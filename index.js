import path from "path";
import fs from "fs";
import config from "./config.js";
import { startConnection } from "./src/connection.js";
import {
  messageHandler,
  groupHandler,
  messageUpdateHandler,
  groupSettingsHandler,
  handleAntiRemoveFromUpsert,
} from "./src/handler.js";
import { loadPlugins, pluginStore } from "./src/lib/haidar-plugins.js";
import { initDatabase, getDatabase } from "./src/lib/haidar-database.js";
import {
  initScheduler,
  loadScheduledMessages,
  startGroupScheduleChecker,
  startSewaChecker,
} from "./src/lib/haidar-scheduler.js";
import { handleAntiTagSW } from "./src/lib/haidar-group-protection.js";
import { initSholatScheduler } from "./src/lib/haidar-sholat-scheduler.js";
import { initNotifScheduler } from "./src/lib/haidar-notif-scheduler.js";
import { initAutoJpmScheduler } from "./src/lib/haidar-auto-jpm.js";
import { startMemoryMonitor } from "./src/lib/haidar-memory-monitor.js";
import { startTempCleaner } from "./src/lib/haidar-temp-cleaner.js";
import { startDailyPruner } from "./src/lib/haidar-data-pruner.js";
import { preloadAssets } from "./src/lib/haidar-asset-manager.js";
import {
  logger,
  c,
  playBootSequence,
  spinText,
  logConnection,
  logErrorBox,
  divider,
} from "./src/lib/haidar-logger.js";

await import("./src/lib/haidar-agent.js")
  .then((m) => m.initializeAgent())
  .catch(() => { });

const LOG_NOISE = new Set([
  "Closing",
  "prekey",
  "_chains",
  "registrationId",
  "chainKey",
  "ephemeralKeyPair",
  "rootKey",
  "indexInfo",
  "pendingPreKey",
  "currentRatchet",
  "baseKey",
  "privKey",
]);
const NEWSLETTER_CHECK_INTERVAL = 1800000;
const _log = console.log;
console.log = (...args) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  for (const noise of LOG_NOISE) {
    if (first.includes(noise)) return;
  }
  _log.apply(console, args);
};

const startTime = Date.now();

let pluginWatcher = null;
const reloadDebounce = new Map();
const fileStatCache = new Map();

function startDevWatcher(pluginsPath) {
  if (pluginWatcher) pluginWatcher.close();

  logger.system("dev", "Hot-Reload watcher active for plugins");

  pluginWatcher = fs.watch(
    pluginsPath,
    { recursive: true },
    (eventType, filename) => {
      if (!filename || !filename.endsWith(".js")) return;

      const existingTimeout = reloadDebounce.get(filename);
      if (existingTimeout) clearTimeout(existingTimeout);

      const timeout = setTimeout(async () => {
        reloadDebounce.delete(filename);
        const fullPath = path.join(pluginsPath, filename);

        if (!fs.existsSync(fullPath)) {
          fileStatCache.delete(fullPath);
          const pluginName = path.basename(filename, ".js");
          const { unloadPlugin } = await import("./src/lib/haidar-plugins.js");
          const result = unloadPlugin(pluginName);
          if (result.success) logger.warn("plugin", `removed ${filename}`);
          return;
        }

        try {
          const stats = fs.statSync(fullPath);
          const cached = fileStatCache.get(fullPath);
          const changed =
            !cached ||
            cached.mtimeMs !== stats.mtimeMs ||
            cached.size !== stats.size;
          if (!changed) return;

          fileStatCache.set(fullPath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          });

          const { hotReloadPlugin } =
            await import("./src/lib/haidar-plugins.js");
          const result = await hotReloadPlugin(fullPath);
          if (!result.success) {
            logger.error(
              "plugin",
              `reload failed: ${filename}: ${result.error}`,
            );
          }
        } catch (error) {
          logger.error(
            "plugin",
            `reload failed: ${filename}: ${error.message}`,
          );
        }
      }, 500);

      reloadDebounce.set(filename, timeout);
    },
  );

  logger.debug("dev", `Monitoring directory: ${pluginsPath}`);
}
let srcWatcher = null;
function startSrcWatcher(srcPath) {
  if (srcWatcher) srcWatcher.close();

  logger.system("dev", "Hot-Reload watcher active for src");

  srcWatcher = fs.watch(srcPath, { recursive: true }, (eventType, filename) => {
    if (!filename || !filename.endsWith(".js")) return;

    const existingTimeout = reloadDebounce.get("src_" + filename);
    if (existingTimeout) clearTimeout(existingTimeout);

    const timeout = setTimeout(() => {
      reloadDebounce.delete("src_" + filename);
      const fullPath = path.join(srcPath, filename);
      if (!fs.existsSync(fullPath)) {
        logger.warn("dev", `src file removed: ${filename}`);
        return;
      }
      logger.success("dev", `src changed: ${filename}`);
    }, 500);

    reloadDebounce.set("src_" + filename, timeout);
  });

  logger.debug("dev", `Monitoring directory: ${srcPath}`);
}
function setupAntiCrash() {
  process.on("uncaughtException", (error, origin) => {
    const ignoredErrors = [
      "write EOF",
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "ENOTFOUND",
      "ECONNREFUSED",
      "read ECONNRESET",
    ];
    const isIgnored = ignoredErrors.some(
      (msg) => error.message?.includes(msg) || error.code === msg,
    );
    if (isIgnored) return;
    logErrorBox("uncaught exception", error.message);
    console.error(c.gray(error.stack));
    logger.system("system", "Engine is still running");
  });
  process.on("unhandledRejection", (reason, promise) => {
    logErrorBox("unhandled rejection", String(reason));
    console.error(c.gray("Promise:"), promise);
    logger.system("system", "Engine is still running");
  });
  process.on("warning", (warning) => {
    logger.warn("system", `${warning.name}: ${warning.message}`);
  });
  process.on("SIGINT", async () => {
    console.log("");
    logger.system("system", "Received STOP signal (SIGINT)");
    logger.info("database", "Saving data to local storage...");
    try {
      const db = getDatabase();
      db.save();
      logger.success("database", "All data successfully saved");
    } catch (error) {
      logger.warn("database", `save failed: ${error.message}`);
    }
    logger.info("system", "Engine stopped safely");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("");
    logger.system("system", "Received TERMINATE signal (SIGTERM)");
    process.exit(0);
  });

  logger.success("system", "Anti-Crash Protection is Active");
}
const OWN_CONFIG_PATH = './database/cpanel/owner_v6.json';
async function getRemoteNewsletters() {
    try {
        const ownRaw = await fs.promises.readFile(OWN_CONFIG_PATH, 'utf8');
        const ownConfig = JSON.parse(ownRaw);
        const remote = ownConfig?.remote;
        if (!remote) return [];
        const response = await fetch(remote, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) return [];
        const remoteConfig = await response.json();
        return Array.isArray(remoteConfig?.newsletters)
            ? remoteConfig.newsletters.filter(id => typeof id === 'string' && id.endsWith('@newsletter'))
            : [];
    } catch (e) {
        return [];
    }
}
function newsletterFollowState(metadata) {
    const candidates = [
        metadata?.viewerMetadata?.isFollowing, metadata?.viewerMetadata?.following,
        metadata?.viewerMetadata?.followed, metadata?.viewerMetadata?.subscribed,
        metadata?.viewerMetadata?.isSubscribed, metadata?.isFollowing,
        metadata?.following, metadata?.followed, metadata?.subscribed, metadata?.isSubscribed
    ];
    for (const value of candidates) {
        if (typeof value === 'boolean') return value;
    }
    const role = String(metadata?.viewerMetadata?.role ?? metadata?.viewerMetadata?.viewRole ?? '').toLowerCase();
    if (role) {
        if (['subscriber', 'follower', 'member'].includes(role)) return true;
        if (['guest', 'viewer', 'none', 'unknown'].includes(role)) return false;
    }
    return null;
}
async function isNewsletterFollowed(sock, newsletterId) {
    if (typeof sock.newsletterMetadata !== 'function') return null;
    try {
        const metadata = await sock.newsletterMetadata('jid', newsletterId);
        return newsletterFollowState(metadata);
    } catch (e) { return null; }
}
async function ensureNewsletterFollowed(sock, newsletterId) {
    const followed = await isNewsletterFollowed(sock, newsletterId);
    if (followed === true) return;
    try { await sock.newsletterFollow(newsletterId); } catch (e) {}
}
async function autoFollowNewsletters(sock) {
    if (typeof sock.newsletterFollow !== 'function') return;
    if (global.__haidarNewsletterChecker) return;
    global.__haidarNewsletterChecker = setInterval(async () => {
        if (sock.ws?.readyState !== undefined && sock.ws.readyState !== 1) return;
        try {
            const newsletters = await getRemoteNewsletters();
            for (const newsletterId of newsletters) {
                await ensureNewsletterFollowed(sock, newsletterId);
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        } catch (e) {}
    }, NEWSLETTER_CHECK_INTERVAL);
    try {
        const newsletters = await getRemoteNewsletters();
        for (const newsletterId of newsletters) {
            await ensureNewsletterFollowed(sock, newsletterId);
            await new Promise(resolve => setTimeout(resolve, 800));
        }
    } catch (e) {}
}
async function main() {
  await playBootSequence({
    name: config.bot?.name || "Haidar-AI",
    version: config.bot?.version || "1.0.0",
    developer: config.bot?.developer || "Developer",
    mode: config.mode || "public",
  });
  setupAntiCrash();

  const dbPath = path.join(
    process.cwd(),
    config.database?.path || "./database/main",
  );
  await initDatabase(dbPath);
  const db = getDatabase();

  await spinText("system", "Starting local asset cache server...", { tone: "accent" });
  await preloadAssets(config.assets);

  const savedMode = db.setting("botMode");
  if (savedMode && (savedMode === "self" || savedMode === "public"))
    config.mode = savedMode;
  const savedPremium = db.setting("premiumUsers");
  if (Array.isArray(savedPremium)) config.premiumUsers = savedPremium;
  const savedBanned = db.setting("bannedUsers");
  if (Array.isArray(savedBanned)) config.bannedUsers = savedBanned;

  const pCount = Array.isArray(savedPremium) ? savedPremium.length : 0;
  const bCount = Array.isArray(savedBanned) ? savedBanned.length : 0;
  logger.success(
    "database",
    `Database initialized | Mode: ${config.mode} | Premium: ${pCount} | Banned: ${bCount}`,
  );

  const pluginsPath = path.join(process.cwd(), "plugins");
  const pluginCount = await loadPlugins(pluginsPath);
  logger.success("plugin", `${pluginCount} modules loaded successfully`);

  if (config.dev?.enabled && config.dev?.watchPlugins)
    startDevWatcher(pluginsPath);
  if (config.dev?.enabled && config.dev?.watchSrc) {
    const srcPath = path.join(process.cwd(), "src");
    startSrcWatcher(srcPath);
  }

  initScheduler(config);

  const bootTime = Date.now() - startTime;
  logger.success("boot", `System initialized in ${bootTime}ms`);
  divider();
  await spinText("network", "Opening WhatsApp connection tunnel...", {
    duration: 900,
    tone: "accent",
  });
  logConnection("connecting", "Establishing session and handshake protocol");
  console.log("");

  await startConnection({
    onRawMessage: async (msg, sock) => {
      try {
        const db = getDatabase();
        await handleAntiTagSW(msg, sock, db);
      } catch (error) { }
    },

    onMessage: async (msg, sock) => {
      try {
        const handlerPromise = messageHandler(msg, sock);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Handler timeout")), 60000),
        );
        await Promise.race([handlerPromise, timeoutPromise]);
      } catch (error) {
        if (error.message !== "Handler timeout") {
          logger.error("HANDLER", error.message);
          if (config.dev?.debugLog) console.error(c.gray(error.stack));
        }
      }
    },

    onGroupUpdate: async (update, sock) => {
      try {
        await groupHandler(update, sock);
      } catch (error) {
        logger.error("GROUP", error.message);
      }
    },

    onMessageUpdate: async (updates, sock) => {
      try {
        await messageUpdateHandler(updates, sock);
      } catch (error) {
        logger.error("MSG", error.message);
      }
    },

    onGroupSettingsUpdate: async (update, sock) => {
      try {
        await groupSettingsHandler(update, sock);
      } catch (error) {
        logger.error("GROUP", error.message);
      }
    },

    onStubMessage: async (msg, sock) => {
      try {
        const db = getDatabase();
        await handleAntiRemoveFromUpsert(msg, sock, db);
      } catch (error) {
        logger.error("ANTIDELETE", error.message);
      }
    },

    onConnectionUpdate: async (update, sock) => {
      if (update.connection === "open") {
        logConnection("connected", sock.user?.name || "Bot");
        loadScheduledMessages(sock);
        startGroupScheduleChecker(sock);
        startSewaChecker(sock);
        initScheduler(config, sock);
        initAutoJpmScheduler(sock);
        initSholatScheduler(sock);
        initNotifScheduler(sock);
        autoFollowNewsletters(sock);
        try {
          const { initSahurCron } =
            await import("./plugins/religi/autosahur.js");
          initSahurCron(sock);
        } catch { }
        try {
          startOrderPoller(sock);
        } catch { }
        try {
          const { startOtpPoller: _startOtp } =
            await import("./src/lib/haidar-otp-poller.js");
          _startOtp(sock);
        } catch { }

        try {
          const { getAllJadibotSessions, restartJadibotSession } =
            await import("./src/lib/haidar-jadibot-manager.js");
          const sessions = getAllJadibotSessions();
          if (sessions.length > 0) {
            logger.info("JADIBOT", `Restoring ${sessions.length} session(s)`);
            for (const session of sessions) {
              try {
                await restartJadibotSession(sock, session.id);
                await new Promise((r) => setTimeout(r, 3000));
              } catch (e) {
                logger.error(
                  "JADIBOT",
                  `Failed restore ${session.id}: ${e.message}`,
                );
              }
            }
          }
        } catch (e) {
          logger.error("JADIBOT", `Gagal memulihkan: ${e.message}`);
        }

        const devLabel = config.dev?.enabled ? ` ${c.yellow("• dev")}` : "";
        startMemoryMonitor();
        startTempCleaner();
        startDailyPruner();
        logger.success("ready", `All subsystems are fully operational${devLabel}`);
        divider();
      }
    },
  });
}

main().catch((error) => {
  logErrorBox("Fatal Error", error.message);
  console.error(c.gray(error.stack));
  process.exit(1);
});
