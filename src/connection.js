import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "haidar";

import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "fs";
import path from "path";
import readline from "readline";
import NodeCache from "node-cache";

import config, {
  isOwner as isOwners,
  setBotNumber,
} from "../config.js";

import * as colors from "./lib/haidar-logger.js";
import { extendSocket } from "./lib/haidar-socket.js";

import {
  isLid,
  lidToJid,
  decodeAndNormalize,
  cacheLidJid,
  isLidConverted,
} from "./lib/haidar-lid.js";

import { initAutoBackup } from "./lib/haidar-auto-backup.js";

/* =========================================================
 * CACHE
 * ========================================================= */

const groupCache = new NodeCache({
  stdTTL: 5 * 60,
  useClones: false,
});

const processedMessages = new NodeCache({
  stdTTL: 30,
  useClones: false,
});

const msgRetryCounterCache = new NodeCache({
  stdTTL: 60,
  useClones: false,
});

/* =========================================================
 * WATCHDOG
 * ========================================================= */

let lastMessageReceived = Date.now();
let watchdogTimer = null;

const WATCHDOG_TIMEOUT = 30 * 60 * 1000;
const WATCHDOG_CHECK_INTERVAL = 60 * 1000;

function startWatchdog(reconnectFn, options) {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  lastMessageReceived = Date.now();

  watchdogTimer = setInterval(() => {
    const silentMs = Date.now() - lastMessageReceived;

    if (
      silentMs > WATCHDOG_TIMEOUT &&
      connectionState.isReady
    ) {
      colors.logger.warn(
        "watchdog",
        "Pesan tidak terdeteksi, koneksi akan direstart."
      );

      connectionState.isReady = false;
      connectionState.isConnected = false;

      try {
        connectionState.sock?.end();
      } catch {}
    }
  }, WATCHDOG_CHECK_INTERVAL);

  if (watchdogTimer.unref) {
    watchdogTimer.unref();
  }

  colors.logger.success(
    "watchdog",
    `aktif, batas waktu ${WATCHDOG_TIMEOUT / 60000} menit`
  );
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/* =========================================================
 * STORE
 * ========================================================= */

const store = {
  messages: new Map(),
  chats: new Map(),
  contacts: {},

  bind(ev) {
    ev.on("messages.upsert", ({ messages: msgs }) => {
      for (const msg of msgs) {
        const jid = msg.key?.remoteJid;

        if (!jid) continue;

        if (!this.messages.has(jid)) {
          this.messages.set(jid, new Map());
        }

        const chat = this.messages.get(jid);

        if (msg.key?.id) {
          chat.set(msg.key.id, msg);

          if (chat.size > 200) {
            const keys = [...chat.keys()];

            for (
              let i = 0;
              i < keys.length - 150;
              i++
            ) {
              chat.delete(keys[i]);
            }
          }
        }

        if (
          msg.key?.participantAlt &&
          msg.key?.participant
        ) {
          const alt = decodeAndNormalize(
            msg.key.participantAlt
          );

          const primary = decodeAndNormalize(
            msg.key.participant
          );

          if (
            alt &&
            primary &&
            !isLid(alt) &&
            !isLidConverted(alt)
          ) {
            cacheLidJid(primary, alt);
          }
        }

        if (
          msg.key?.remoteJidAlt &&
          msg.key?.remoteJid
        ) {
          const alt = decodeAndNormalize(
            msg.key.remoteJidAlt
          );

          const primary = decodeAndNormalize(
            msg.key.remoteJid
          );

          if (
            alt &&
            primary &&
            !isLid(alt) &&
            !isLidConverted(alt)
          ) {
            cacheLidJid(primary, alt);
          }
        }

        if (!this.chats.has(jid)) {
          this.chats.set(jid, {
            id: jid,
          });
        }

        if (
          msg.pushName &&
          jid.endsWith("@s.whatsapp.net")
        ) {
          this.contacts[jid] = {
            ...this.contacts[jid],
            notify: msg.pushName,
          };
        }
      }
    });

    ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        if (chat.id) {
          this.chats.set(chat.id, chat);
        }
      }
    });

    ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        if (contact.id) {
          this.contacts[contact.id] = {
            ...this.contacts[contact.id],
            ...contact,
          };
        }
      }
    });
  },

  async loadMessage(jid, id) {
    return (
      this.messages.get(jid)?.get(id) ||
      undefined
    );
  },
};

/* =========================================================
 * CONNECTION STATE
 * ========================================================= */

const connectionState = {
  isConnected: false,
  isReady: false,
  sock: null,
  reconnectAttempts: 0,
  connectedAt: null,
};

/* =========================================================
 * LOGGER
 * ========================================================= */

const logger = pino({
  level: "silent",

  hooks: {
    logMethod(inputArgs, method) {
      const msg = inputArgs[0];

      if (
        typeof msg === "string" &&
        (
          msg.includes("Closing") ||
          msg.includes("session") ||
          msg.includes("SessionEntry") ||
          msg.includes("prekey")
        )
      ) {
        return;
      }

      return method.apply(this, inputArgs);
    },
  },
});

/* =========================================================
 * READLINE
 * ========================================================= */

let rl = null;

function createReadlineInterface() {
  if (rl) {
    try {
      rl.close();
    } catch {}
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return rl;
}

function askQuestion(question) {
  return new Promise((resolve) => {
    const input = createReadlineInterface();

    input.question(question, (answer) => {
      try {
        input.close();
      } catch {}

      rl = null;

      resolve(String(answer || "").trim());
    });
  });
}

/* =========================================================
 * LOGIN CONFIG
 *
 * true  = PAIRING CODE
 * false = QR CODE
 * ========================================================= */

function isPairingEnabled() {
  return config.session?.usePairingCode === true;
}

function getPairingNumber() {
  return String(
    config.session?.pairingNumber || ""
  ).replace(/[^0-9]/g, "");
}

function getPairingCodePrefix() {
  return String(
    config.session?.pairingCode || "HAIDARMD"
  )
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 8);
}

/* =========================================================
 * DISPLAY QR
 * ========================================================= */

async function showQRCode(qr) {
  if (!qr) return;

  try {
    const { default: qrcode } =
      await import("qrcode");

    const qrText = await qrcode.toString(qr, {
      type: "terminal",
      small: true,
    });

    console.log("");
    console.log(
      "=================================================="
    );
    console.log(
      "                 WHATSAPP QR"
    );
    console.log(
      "=================================================="
    );
    console.log("");

    console.log(qrText);

    console.log(
      "=================================================="
    );
    console.log(
      " Scan QR melalui WhatsApp > Perangkat Tertaut"
    );
    console.log(
      "=================================================="
    );
    console.log("");
  } catch (error) {
    colors.logger.error(
      "qr",
      `Gagal menampilkan QR: ${
        error?.message || error
      }`
    );
  }
}

/* =========================================================
 * REQUEST PAIRING CODE
 * ========================================================= */

async function requestPairingCode(sock, state) {
  if (state.creds.registered) {
    return;
  }

  let phoneNumber = getPairingNumber();

  if (!phoneNumber) {
    console.log("");

    colors.logger.warn(
      "pairing",
      "Nomor WhatsApp belum diatur di config."
    );

    phoneNumber = await askQuestion(
      colors.chalk.cyan(
        "Masukkan nomor WhatsApp (contoh: 6281234567890): "
      )
    );

    phoneNumber = String(phoneNumber || "")
      .replace(/[^0-9]/g, "");
  }

  if (!phoneNumber) {
    colors.logger.error(
      "pairing",
      "Nomor WhatsApp tidak boleh kosong."
    );

    return;
  }

  if (phoneNumber.length < 10) {
    colors.logger.error(
      "pairing",
      "Nomor WhatsApp tidak valid."
    );

    return;
  }

  const customCode = getPairingCodePrefix();

  try {
    colors.logger.info(
      "pairing",
      `Meminta pairing code untuk ${phoneNumber}`
    );

    /*
     * Beri waktu socket untuk siap.
     */
    await new Promise((resolve) =>
      setTimeout(resolve, 2000)
    );

    const code =
      await sock.requestPairingCode(
        phoneNumber,
        customCode
      );

    console.log("");

    console.log(
      "=================================================="
    );
    console.log(
      "                 PAIRING CODE"
    );
    console.log(
      "=================================================="
    );
    console.log("");

    console.log(
      `                 ${code}`
    );

    console.log("");

    console.log(
      " Buka WhatsApp di HP"
    );
    console.log(
      " Pengaturan > Perangkat Tertaut"
    );
    console.log(
      " > Tautkan perangkat"
    );

    console.log("");

    console.log(
      " Masukkan pairing code tersebut."
    );

    console.log("");

    console.log(
      "=================================================="
    );

    console.log("");

    colors.logger.success(
      "pairing",
      "Pairing code berhasil dibuat."
    );
  } catch (error) {
    colors.logger.error(
      "pairing",
      `Gagal membuat pairing code: ${
        error?.message || error
      }`
    );
  }
}

/* =========================================================
 * START CONNECTION
 * ========================================================= */

async function startConnection(options = {}) {
  if (connectionState.sock) {
    try {
      connectionState.sock.end();

      colors.logger.debug(
        "whatsapp",
        "Koneksi sebelumnya ditutup."
      );
    } catch {}

    connectionState.sock = null;
  }

  const sessionPath = path.join(
    process.cwd(),
    "storage",
    config.session?.folderName || "session"
  );

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, {
      recursive: true,
    });
  }

  const {
    state,
    saveCreds,
  } = await useMultiFileAuthState(
    sessionPath
  );

  /*
   * Ambil versi terbaru jika tersedia.
   * Fallback ke versi yang sebelumnya digunakan
   * project kamu.
   */
  let version = [2, 3000, 1035194821];

  try {
    const latest =
      await fetchLatestBaileysVersion();

    if (
      latest?.version &&
      Array.isArray(latest.version)
    ) {
      version = latest.version;
    }
  } catch (error) {
    colors.logger.debug(
      "version",
      `Gagal mengambil versi terbaru, menggunakan fallback: ${
        error?.message || error
      }`
    );
  }

  const usePairingCode =
    isPairingEnabled();

  const useQR =
    !usePairingCode;

  colors.logger.info(
    "login",
    `Metode login: ${
      usePairingCode
        ? "PAIRING CODE"
        : "QR CODE"
    }`
  );

  /* =======================================================
   * SOCKET
   * ======================================================= */

  const sock = makeWASocket({
    version,

    logger,

    /*
     * QR ditampilkan manual.
     */
    printQRInTerminal: false,

    auth: {
      creds: state.creds,

      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger
      ),
    },

    browser: [
      "Ubuntu",
      "Chrome",
      "20.0.0",
    ],

    syncFullHistory: false,

    markOnlineOnConnect: false,

    generateHighQualityLinkPreview: false,

    shouldIgnoreJid: (jid) =>
      jid
        ? jid.includes("meta_ai")
        : false,

    getMessage: async (key) => {
      const msg =
        await store.loadMessage(
          key.remoteJid,
          key.id
        );

      return (
        msg?.message ||
        undefined
      );
    },

    cachedGroupMetadata: async (jid) => {
      const cached =
        groupCache.get(jid);

      if (cached) {
        return cached;
      }

      try {
        const fresh =
          await sock.groupMetadata(jid);

        if (fresh) {
          groupCache.set(
            jid,
            fresh
          );
        }

        return fresh;
      } catch {
        return undefined;
      }
    },

    msgRetryCounterCache,
  });

  store.bind(sock.ev);

  sock.store = store;

  connectionState.sock = sock;

  try {
    extendSocket(sock);
  } catch (error) {
    colors.logger.warn(
      "socket",
      `extendSocket gagal: ${
        error?.message || error
      }`
    );
  }

  /*
   * Simpan credential.
   */
  sock.ev.on(
    "creds.update",
    saveCreds
  );

  /* =======================================================
   * PAIRING CODE
   * ======================================================= */

  if (
    usePairingCode &&
    !state.creds.registered
  ) {
    /*
     * Jalankan sedikit setelah socket dibuat.
     */
    setTimeout(() => {
      requestPairingCode(
        sock,
        state
      ).catch((error) => {
        colors.logger.error(
          "pairing",
          error?.message || error
        );
      });
    }, 2000);
  }

  /* =======================================================
   * CONNECTION UPDATE
   * ======================================================= */

  sock.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection: c,
        lastDisconnect: d,
        qr,
      } = update;

      /*
       * QR LOGIN
       */

      if (
        qr &&
        useQR &&
        !state.creds.registered
      ) {
        await showQRCode(qr);
      }

      /*
       * CONNECTION CLOSED
       */

      if (c === "close") {
        connectionState.isConnected =
          false;

        connectionState.isReady =
          false;

        stopWatchdog();

        const statusCode =
          d?.error instanceof Boom
            ? d.error.output
                ?.statusCode
            : d?.error?.output
                ?.statusCode;

        const STATUS_MESSAGES = {
          400: "Bad Request — request tidak valid",
          401: "Unauthorized — session tidak valid",
          403: "Forbidden — akses ditolak",
          404: "Not Found — resource tidak ditemukan",
          405: "Method Not Allowed",
          408: "Timeout — koneksi timeout",
          410: "Gone — session dihapus",
          428: "Connection Required",
          440: "Session Conflict",
          500: "Internal Server Error",
          501: "Not Implemented",
          502: "Bad Gateway",
          503: "Service Unavailable",
          504: "Gateway Timeout",
          515: "Restart Required",
        };

        const statusMsg =
          STATUS_MESSAGES[statusCode] ||
          `Unknown (kode: ${statusCode})`;

        colors.logger.warn(
          "whatsapp",
          `Terputus — ${statusMsg}`
        );

        /*
         * LOGGED OUT
         */

        if (
          statusCode ===
            DisconnectReason.loggedOut ||
          statusCode === 401
        ) {
          colors.logger.error(
            "whatsapp",
            "Session logout. Hapus folder storage/session jika ingin login ulang."
          );

          connectionState.reconnectAttempts =
            0;

          return;
        }

        /*
         * SESSION CONFLICT
         */

        if (statusCode === 440) {
          connectionState.reconnectAttempts++;

          if (
            connectionState.reconnectAttempts <=
            3
          ) {
            colors.logger.info(
              "whatsapp",
              `Percobaan sambung ulang ${connectionState.reconnectAttempts}/3 dalam 10 detik`
            );

            setTimeout(
              () =>
                startConnection(
                  options
                ),
              10000
            );
          } else {
            colors.logger.error(
              "whatsapp",
              "Konflik session. Pastikan bot lain tidak menggunakan session yang sama."
            );

            connectionState.reconnectAttempts =
              0;
          }

          return;
        }

        /*
         * RECONNECT
         */

        if (
          statusCode !==
          DisconnectReason.loggedOut
        ) {
          connectionState.reconnectAttempts++;

          const maxReconnect =
            config.session
              ?.maxReconnectAttempts ||
            5;

          const reconnectInterval =
            config.session
              ?.reconnectInterval ||
            15000;

          if (
            connectionState.reconnectAttempts <=
            maxReconnect
          ) {
            colors.logger.info(
              "whatsapp",
              `Percobaan sambung ulang ${connectionState.reconnectAttempts}/${maxReconnect}`
            );

            setTimeout(
              () =>
                startConnection(
                  options
                ),
              reconnectInterval
            );
          } else {
            colors.logger.error(
              "whatsapp",
              `Gagal sambung ulang setelah ${maxReconnect} percobaan`
            );
          }
        }
      }

      /*
       * CONNECTION OPEN
       */

      if (c === "open") {
        connectionState.isConnected =
          true;

        connectionState.isReady =
          true;

        connectionState.reconnectAttempts =
          0;

        connectionState.connectedAt =
          new Date();

        const number =
          sock.user?.id
            ?.split(":")[0] ||
          sock.user?.id
            ?.split("@")[0];

        if (number) {
          setBotNumber(number);
        }

        colors.logger.success(
          "bot",
          `${config.bot?.name || "Haidar-AI"} (${number || "?"}) · WA v${version.join(".")}`
        );

        /*
         * Plugin loader
         */

        setTimeout(
          async () => {
            try {
              const {
                reloadAllPlugins,
                getPluginCount,
              } = await import(
                "./lib/haidar-plugins.js"
              );

              if (
                !getPluginCount()
              ) {
                await reloadAllPlugins();
              }
            } catch {}
          },
          100
        );

        /*
         * Watchdog
         */

        startWatchdog(
          startConnection,
          options
        );

        /*
         * Auto backup
         */

        try {
          initAutoBackup(sock);
        } catch (error) {
          colors.logger.debug(
            "backup",
            `skipped: ${
              error?.message || error
            }`
          );
        }

        /*
         * Giveaway
         */

        try {
          const {
            startGiveawayChecker,
          } = await import(
            "../plugins/group/giveaway.js"
          );

          const {
            getDatabase,
          } = await import(
            "./lib/haidar-database.js"
          );

          const db =
            getDatabase();

          startGiveawayChecker(
            sock,
            db
          );
        } catch (error) {
          colors.logger.debug(
            "giveaway",
            `skipped: ${
              error?.message || error
            }`
          );
        }

        colors.logger.success(
          "whatsapp",
          "Siap menerima pesan."
        );
      }

      /*
       * Callback external
       */

      if (
        options.onConnectionUpdate
      ) {
        try {
          await options.onConnectionUpdate(
            update,
            sock
          );
        } catch {}
      }
    }
  );

  /* =======================================================
   * GROUP QUEUE
   * ======================================================= */

  const groupEventQueue = [];

  let groupEventProcessing =
    false;

  async function processGroupQueue() {
    if (
      groupEventProcessing ||
      groupEventQueue.length === 0
    ) {
      return;
    }

    groupEventProcessing =
      true;

    while (
      groupEventQueue.length > 0
    ) {
      const {
        handler,
        args,
      } =
        groupEventQueue.shift();

      try {
        await handler(
          ...args
        );
      } catch (error) {
        if (
          error?.message?.includes(
            "rate-overlimit"
          ) ||
          error?.output?.statusCode ===
            429
        ) {
          colors.logger.warn(
            "rate-limit",
            "throttled, waiting 5s..."
          );

          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                5000
              )
          );

          try {
            await handler(
              ...args
            );
          } catch {}
        }
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            2000
          )
      );
    }

    groupEventProcessing =
      false;
  }

  /* =======================================================
   * GROUP UPDATE
   * ======================================================= */

  sock.ev.on(
    "groups.update",
    async (updates) => {
      for (const update of updates) {
        if (
          options.onGroupSettingsUpdate
        ) {
          try {
            await options.onGroupSettingsUpdate(
              update,
              sock
            );
          } catch (error) {
            console.error(
              "[GroupsUpdate] Error:",
              error?.message ||
                error
            );
          }
        }
      }
    }
  );

  /* =======================================================
   * PARTICIPANTS UPDATE
   * ======================================================= */

  sock.ev.on(
    "group-participants.update",
    async (event) => {
      if (
        options.onParticipantsUpdate
      ) {
        try {
          await options.onParticipantsUpdate(
            event,
            sock
          );
        } catch {}
      }

      if (
        options.onGroupUpdate
      ) {
        groupEventQueue.push({
          handler:
            options.onGroupUpdate,

          args: [
            event,
            sock,
          ],
        });

        processGroupQueue();
      }
    }
  );

  /* =======================================================
   * CHATS
   * ======================================================= */

  sock.ev.on(
    "chats.upsert",
    async (chats) => {
      for (const chat of chats) {
        const chatId =
          chat?.id;

        if (!chatId) continue;

        if (
          chatId.endsWith("@g.us")
        ) {
          if (
            !global.groupMetadataCache
          ) {
            global.groupMetadataCache =
              new Map();
          }

          const now =
            Date.now();

          if (
            global.groupMetadataCache.size >
            100
          ) {
            for (
              const [
                key,
                value,
              ] of global
                .groupMetadataCache
            ) {
              if (
                now -
                  value.timestamp >
                10 * 60 * 1000
              ) {
                global.groupMetadataCache.delete(
                  key
                );
              }
            }
          }

          if (
            !global.groupMetadataCache.has(
              chatId
            )
          ) {
            sock
              .groupMetadata(
                chatId
              )
              .then(
                (metadata) => {
                  if (metadata) {
                    global.groupMetadataCache.set(
                      chatId,
                      {
                        data: metadata,
                        timestamp:
                          now,
                      }
                    );
                  }
                }
              )
              .catch(
                () => {}
              );
          }
        }
      }
    }
  );

  /* =======================================================
   * CONTACTS
   * ======================================================= */

  sock.ev.on(
    "contacts.upsert",
    () => {}
  );

  /* =======================================================
   * MESSAGES
   * ======================================================= */

  sock.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      lastMessageReceived =
        Date.now();

      if (
        config.dev?.debugLog
      ) {
        colors.logger.debug(
          "pesan",
          `${messages.length} pesan, tipe=${type}`
        );
      }

      if (
        type !== "notify" &&
        type !== "append"
      ) {
        return;
      }

      if (
        !connectionState.isReady
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              500
            )
        );

        if (
          !connectionState.isReady
        ) {
          return;
        }
      }

      const currentSock =
        connectionState.sock;

      if (!currentSock) {
        return;
      }

      for (const msg of messages) {
        const stubType =
          msg.messageStubType;

        if (
          !msg.message &&
          (
            stubType === 1 ||
            stubType === 132
          )
        ) {
          if (
            options.onStubMessage
          ) {
            try {
              await options.onStubMessage(
                msg,
                currentSock
              );
            } catch {}
          }

          continue;
        }

        if (!msg.message) {
          continue;
        }

        const msgId =
          msg.key?.id;

        if (
          msgId &&
          processedMessages.has(
            msgId
          )
        ) {
          continue;
        }

        if (msgId) {
          processedMessages.set(
            msgId,
            true
          );
        }

        /* ================================================
         * MESSAGE AGE
         * ================================================ */

        let msgTimestamp = 0;

        if (
          msg.messageTimestamp
        ) {
          if (
            typeof msg
              .messageTimestamp
              .toNumber ===
            "function"
          ) {
            msgTimestamp =
              msg
                .messageTimestamp
                .toNumber() *
              1000;
          } else {
            msgTimestamp =
              Number(
                msg.messageTimestamp
              ) * 1000;
          }
        }

        const msgAge =
          Date.now() -
          msgTimestamp;

        if (
          msgTimestamp &&
          msgAge >
            5 * 60 * 1000
        ) {
          continue;
        }

        /* ================================================
         * MESSAGE TYPE
         * ================================================ */

        const metadataKeys = [
          "senderKeyDistributionMessage",
          "messageContextInfo",
        ];

        const msgType =
          Object.keys(
            msg.message || {}
          ).find(
            (key) =>
              !metadataKeys.includes(
                key
              )
          ) ||
          Object.keys(
            msg.message || {}
          )[0];

        const hasInteractiveResponse =
          !!msg.message
            ?.interactiveResponseMessage;

        /* ================================================
         * PROTOCOL
         * ================================================ */

        if (
          msgType ===
          "protocolMessage"
        ) {
          const protocolMessage =
            msg.message
              .protocolMessage;

          if (
            protocolMessage?.type ===
              30 &&
            protocolMessage?.memberLabel
          ) {
            try {
              const {
                handleLabelChange,
              } = await import(
                "../plugins/group/notifgantitag.js"
              );

              if (
                handleLabelChange
              ) {
                await handleLabelChange(
                  msg,
                  currentSock
                );
              }
            } catch {}
          }

          if (
            protocolMessage?.type ===
              "MESSAGE_EDIT" ||
            protocolMessage?.type ===
              14
          ) {
            const edited =
              protocolMessage
                .editedMessage;

            if (edited) {
              const originalKey =
                protocolMessage.key ||
                msg.key;

              const syntheticMsg = {
                key: {
                  remoteJid:
                    originalKey.remoteJid ||
                    msg.key.remoteJid,

                  fromMe:
                    msg.key.fromMe,

                  id:
                    originalKey.id,

                  participant:
                    msg.key.participant,
                },

                message: edited,

                messageTimestamp:
                  Math.floor(
                    Date.now() /
                      1000
                  ),

                pushName:
                  msg.pushName ||
                  "User",
              };

              if (
                options.onMessage
              ) {
                await options.onMessage(
                  syntheticMsg,
                  currentSock
                );
              }
            }
          }

          continue;
        }

        /* ================================================
         * STATUS / GROUP MENTION
         * ================================================ */

        const allMsgKeys =
          Object.keys(
            msg.message || {}
          );

        const isStatusMention =
          allMsgKeys.includes(
            "groupStatusMessage"
          ) ||
          allMsgKeys.includes(
            "groupStatusMessageV2"
          ) ||
          allMsgKeys.includes(
            "groupStatusMentionMessage"
          ) ||
          allMsgKeys.includes(
            "groupMentionedMessage"
          ) ||
          allMsgKeys.includes(
            "statusMentionMessage"
          ) ||
          !!msg.message?.viewOnceMessage
            ?.message
            ?.groupStatusMessage ||
          !!msg.message?.viewOnceMessageV2
            ?.message
            ?.groupStatusMessage ||
          !!msg.message?.viewOnceMessageV2Extension
            ?.message
            ?.groupStatusMessage ||
          !!msg.message?.ephemeralMessage
            ?.message
            ?.groupStatusMessage;

        const hasGroupMentionInContext =
          (() => {
            const content =
              msg.message?.[
                msgType
              ];

            if (
              content
                ?.contextInfo
                ?.groupMentions
                ?.length > 0
            ) {
              return true;
            }

            const viewOnce =
              msg.message
                ?.viewOnceMessage
                ?.message ||
              msg.message
                ?.viewOnceMessageV2
                ?.message ||
              msg.message
                ?.viewOnceMessageV2Extension
                ?.message;

            if (viewOnce) {
              const vType =
                Object.keys(
                  viewOnce
                )[0];

              if (
                viewOnce[
                  vType
                ]
                  ?.contextInfo
                  ?.groupMentions
                  ?.length > 0
              ) {
                return true;
              }
            }

            return false;
          })();

        if (
          isStatusMention ||
          hasGroupMentionInContext
        ) {
          const groupJid =
            msg.key.remoteJid;

          try {
            const {
              getDatabase,
            } = await import(
              "./lib/haidar-database.js"
            );

            const {
              handleAntiTagSW,
              handleAntiSwGc,
            } = await import(
              "./lib/haidar-group-protection.js"
            );

            const db =
              getDatabase();

            if (
              groupJid?.endsWith(
                "@g.us"
              )
            ) {
              const handled =
                await handleAntiTagSW(
                  msg,
                  currentSock,
                  db
                );

              if (!handled) {
                await handleAntiSwGc(
                  msg,
                  currentSock,
                  db
                );
              }
            }
          } catch (error) {
            colors.logger.error(
              "antitagsw",
              error?.message ||
                error
            );
          }
        }

        /* ================================================
         * IGNORED TYPES
         * ================================================ */

        const ignoredTypes = [
          "protocolMessage",
          "reactionMessage",
          "senderKeyDistributionMessage",
          "stickerSyncRmrMessage",
          "encReactionMessage",
          "pollUpdateMessage",
          "pollCreationMessage",
          "pollCreationMessageV2",
          "pollCreationMessageV3",
          "keepInChatMessage",
          "requestPhoneNumberMessage",
          "pinInChatMessage",
          "deviceSentMessage",
          "call",
          "peerDataOperationRequestMessage",
          "bcallMessage",
        ];

        if (
          ignoredTypes.includes(
            msgType
          ) &&
          !hasInteractiveResponse
        ) {
          continue;
        }

        /* ================================================
         * JID
         * ================================================ */

        let jid =
          msg.key.remoteJid ||
          "";

        if (
          msg.key.fromMe &&
          type === "append" &&
          jid !==
            "status@broadcast"
        ) {
          continue;
        }

        if (
          jid ===
          "status@broadcast"
        ) {
          try {
            let participant =
              msg.key.participant ||
              "";

            if (
              isLid(participant)
            ) {
              participant =
                lidToJid(
                  participant
                ) ||
                participant;

              msg.key.participant =
                participant;
            }

            const {
              getDatabase,
            } = await import(
              "./lib/haidar-database.js"
            );

            const db =
              getDatabase();

            const autoReadSW =
              db.setting(
                "autoReadSW"
              ) || {};

            const autoReactSW =
              db.setting(
                "autoReactSW"
              ) || {};

            if (
              autoReadSW.enabled &&
              participant &&
              !participant.endsWith(
                "@lid"
              )
            ) {
              await currentSock
                .sendReceipt(
                  "status@broadcast",
                  participant,
                  [msg.key.id],
                  "read"
                )
                .catch(
                  () => {}
                );
            }

            if (
              autoReactSW.enabled &&
              participant &&
              !participant.endsWith(
                "@lid"
              )
            ) {
              const emoji =
                autoReactSW.emoji ||
                "🔥";

              await currentSock
                .sendMessage(
                  "status@broadcast",
                  {
                    react: {
                      text: emoji,
                      key: msg.key,
                    },
                  },
                  {
                    statusJidList: [
                      participant,
                    ],
                  }
                )
                .catch(
                  () => {}
                );
            }
          } catch (error) {
            colors.logger.debug(
              "story",
              `auto story error: ${
                error?.message ||
                error
              }`
            );
          }

          continue;
        }

        if (
          isLid(jid)
        ) {
          const converted =
            lidToJid(jid);

          if (converted) {
            jid = converted;
            msg.key.remoteJid =
              converted;
          }
        }

        if (
          msg.key.participant &&
          isLid(
            msg.key.participant
          )
        ) {
          const converted =
            lidToJid(
              msg.key.participant
            );

          if (converted) {
            msg.key.participant =
              converted;
          }
        }

        if (
          jid.endsWith(
            "@broadcast"
          )
        ) {
          continue;
        }

        if (
          !jid ||
          jid === "undefined" ||
          jid.length < 5
        ) {
          continue;
        }

        /* ================================================
         * RAW MESSAGE
         * ================================================ */

        if (
          options.onRawMessage
        ) {
          try {
            await options.onRawMessage(
              msg,
              currentSock
            );
          } catch {}
        }

        /* ================================================
         * MESSAGE BODY
         * ================================================ */

        const messageBody =
          (() => {
            const message =
              msg.message;

            if (!message) {
              return "";
            }

            const type =
              Object.keys(
                message
              )[0];

            const content =
              message[type];

            if (
              typeof content ===
              "string"
            ) {
              return content;
            }

            return (
              content?.text ||
              content?.caption ||
              content?.conversation ||
              ""
            );
          })();

        /* ================================================
         * OWNER
         * ================================================ */

        const isGroup =
          msg.key.remoteJid?.endsWith(
            "@g.us"
          );

        const senderJid =
          isGroup
            ? msg.key
                .participantAlt ||
              msg.key
                .participant
            : msg.key
                .remoteJidAlt ||
              msg.key
                .remoteJid ||
              "";

        const isOwner =
          isOwners(
            senderJid
          );

        /* ================================================
         * OWNER EVAL
         * ================================================ */

        if (
          isOwner &&
          messageBody.startsWith(
            "=>"
          )
        ) {
          const code =
            messageBody
              .slice(2)
              .trim();

          if (code) {
            try {
              const {
                serialize,
              } = await import(
                "./lib/haidar-serialize.js"
              );

              await serialize(
                currentSock,
                msg,
                {}
              );

              const result =
                code.startsWith("{")
                  ? await eval(
                      `(async () => ${code})()`
                    )
                  : await eval(
                      `(async () => { return ${code} })()`
                    );

              let output =
                result;

              if (
                typeof output !==
                "string"
              ) {
                const {
                  inspect,
                } = await import(
                  "util"
                );

                output =
                  inspect(
                    output,
                    {
                      depth: 2,
                    }
                  );
              }

              if (
                output !==
                undefined
              ) {
                await currentSock.sendMessage(
                  jid,
                  {
                    text: String(
                      output
                    ).slice(
                      0,
                      3500
                    ),
                  },
                  {
                    quoted: msg,
                  }
                );
              }
            } catch (error) {
              await currentSock.sendMessage(
                jid,
                {
                  text:
                    `❌ *ᴇᴠᴀʟ ᴇʀʀᴏʀ*\n\n` +
                    "```text\n" +
                    `${
                      error?.message ||
                      error
                    }` +
                    "\n```",
                },
                {
                  quoted: msg,
                }
              );
            }

            continue;
          }
        }

        /* ================================================
         * OWNER TERMINAL
         * ================================================ */

        if (
          isOwner &&
          messageBody.startsWith(
            "$"
          )
        ) {
          const command =
            messageBody
              .slice(1)
              .trim();

          if (command) {
            try {
              const {
                exec,
              } = await import(
                "child_process"
              );

              const {
                promisify,
              } = await import(
                "util"
              );

              const execAsync =
                promisify(exec);

              await currentSock.sendMessage(
                jid,
                {
                  text:
                    `🕕 *ᴇxᴇᴄᴜᴛɪɴɢ...*\n\n` +
                    `\`$ ${command}\``,
                },
                {
                  quoted: msg,
                }
              );

              const {
                stdout,
                stderr,
              } =
                await execAsync(
                  command,
                  {
                    shell:
                      process.platform ===
                      "win32"
                        ? "powershell.exe"
                        : "/bin/bash",

                    timeout:
                      60000,

                    maxBuffer:
                      1024 *
                      1024,

                    encoding:
                      "utf8",
                  }
                );

              const output =
                stdout ||
                stderr ||
                "No output";

              await currentSock.sendMessage(
                jid,
                {
                  text:
                    `✅ *ᴛᴇʀᴍɪɴᴀʟ*\n\n` +
                    `\`$ ${command}\`\n\n` +
                    "```text\n" +
                    output.slice(
                      0,
                      3500
                    ) +
                    "\n```",
                }
              );
            } catch (error) {
              const output =
                error?.stderr ||
                error?.stdout ||
                error?.message ||
                String(error);

              await currentSock.sendMessage(
                jid,
                {
                  text:
                    `❌ *ᴛᴇʀᴍɪɴᴀʟ ᴇʀʀᴏʀ*\n\n` +
                    `\`$ ${command}\`\n\n` +
                    "```text\n" +
                    output.slice(
                      0,
                      3500
                    ) +
                    "\n```",
                }
              );
            }

            continue;
          }
        }

        /* ================================================
         * NORMAL MESSAGE CALLBACK
         * ================================================ */

        if (
          options.onMessage
        ) {
          options
            .onMessage(
              msg,
              currentSock
            )
            .catch(
              (error) => {
                colors.logger.error(
                  "Message",
                  error?.message ||
                    error
                );
              }
            );
        }
      }
    }
  );

  /* =======================================================
   * SECONDARY GROUP PARTICIPANT CALLBACK
   * ======================================================= */

  sock.ev.on(
    "group-participants.update",
    async (update) => {
      if (
        options.onGroupUpdate
      ) {
        groupEventQueue.push({
          handler:
            options.onGroupUpdate,

          args: [
            update,
            sock,
          ],
        });

        processGroupQueue();
      }
    }
  );

  /* =======================================================
   * MESSAGE UPDATE
   * ======================================================= */

  sock.ev.on(
    "messages.update",
    async (updates) => {
      if (
        options.onMessageUpdate
      ) {
        try {
          await options.onMessageUpdate(
            updates,
            sock
          );
        } catch {}
      }
    }
  );

  /* =======================================================
   * ANTICALL
   * ======================================================= */

  try {
    const {
      getDatabase,
    } = await import(
      "./lib/haidar-database.js"
    );

    const db =
      getDatabase();

    if (
      db.setting("antiCall") ??
      config.features?.antiCall
    ) {
      sock.ev.on(
        "call",
        async (calls) => {
          for (const call of calls) {
            if (
              call.status !==
              "offer"
            ) {
              continue;
            }

            try {
              colors.logger.warn(
                "Call",
                `Menolak panggilan dari ${call.from}`
              );

              await sock.rejectCall(
                call.id,
                call.from
              );

              if (
                config.messages
                  ?.rejectCall
              ) {
                await sock.sendMessage(
                  call.from,
                  {
                    text:
                      config.messages
                        .rejectCall,
                  }
                );
              }
            } catch {}

            if (
              config.features
                ?.blockIfCall
            ) {
              try {
                let targetJid =
                  call.from;

                if (
                  targetJid.endsWith(
                    "@lid"
                  )
                ) {
                  try {
                    const pn =
                      await sock
                        .signalRepository
                        ?.lidMapping
                        ?.getPNForLID(
                          targetJid
                        );

                    if (pn) {
                      targetJid =
                        pn;

                      colors.logger.info(
                        "Call",
                        `LID berhasil di-resolve: ${targetJid}`
                      );
                    }
                  } catch {}
                }

                if (
                  !targetJid.endsWith(
                    "@lid"
                  )
                ) {
                  const sanitizedJid =
                    targetJid.replace(
                      /:\d+@/,
                      "@"
                    );

                  await db.setUser(
                    sanitizedJid,
                    {
                      isBlocked:
                        true,
                    }
                  );

                  try {
                    await sock.updateBlockStatus(
                      sanitizedJid.split(
                        "@"
                      )[0],
                      "block"
                    );

                    colors.logger.info(
                      "Call",
                      `Berhasil memblokir: ${sanitizedJid}`
                    );
                  } catch {}
                }
              } catch (error) {
                colors.logger.error(
                  "Call",
                  `Gagal memblokir: ${
                    error?.message ||
                    error
                  }`
                );
              }
            }
          }
        }
      );
    }
  } catch {}

  /* =======================================================
   * FLUSH
   * ======================================================= */

  process.nextTick(() => {
    try {
      sock.ev?.flush?.();
    } catch {}
  });

  setTimeout(() => {
    try {
      sock.ev?.flush?.();
    } catch {}
  }, 2000);

  const flushInterval =
    setInterval(() => {
      if (
        !connectionState.isConnected
      ) {
        clearInterval(
          flushInterval
        );

        return;
      }

      try {
        sock.ev?.flush?.();
      } catch {}
    }, 30000);

  if (
    flushInterval.unref
  ) {
    flushInterval.unref();
  }

  return sock;
}

/* =========================================================
 * CONNECTION GETTERS
 * ========================================================= */

function getConnectionState() {
  return connectionState;
}

function getSocket() {
  return connectionState.sock;
}

function isConnected() {
  return connectionState.isConnected;
}

function getUptime() {
  if (
    !connectionState.connectedAt
  ) {
    return 0;
  }

  return (
    Date.now() -
    connectionState.connectedAt.getTime()
  );
}

/* =========================================================
 * LOGOUT
 * ========================================================= */

async function logout() {
  try {
    const sessionPath =
      path.join(
        process.cwd(),
        "storage",
        config.session?.folderName ||
          "session"
      );

    if (
      connectionState.sock
    ) {
      try {
        await connectionState.sock.logout();
      } catch {}
    }

    if (
      fs.existsSync(
        sessionPath
      )
    ) {
      fs.rmSync(
        sessionPath,
        {
          recursive: true,
          force: true,
        }
      );
    }

    connectionState.isConnected =
      false;

    connectionState.isReady =
      false;

    connectionState.sock =
      null;

    connectionState.connectedAt =
      null;

    connectionState.reconnectAttempts =
      0;

    stopWatchdog();

    colors.logger.success(
      "koneksi",
      "Keluar dan session dihapus."
    );

    return true;
  } catch (error) {
    colors.logger.error(
      "koneksi",
      `Gagal logout: ${
        error?.message || error
      }`
    );

    return false;
  }
}

/* =========================================================
 * EXPORT
 * ========================================================= */

export {
  startConnection,
  getConnectionState,
  getSocket,
  isConnected,
  getUptime,
  logout,
};