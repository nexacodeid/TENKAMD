<div align="center">

# TENKA MD

### Multi-Device WhatsApp Bot • Modular • Powerful • Developer Focused

<img src="https://i.pinimg.com/originals/6f/2c/5b/6f2c5b5f0c2c9d1f6e4c5c7a5f1f6d4a.gif" width="680" alt="Anime Kawaii GIF">

<br>

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Multi--Device-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://www.whatsapp.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=for-the-badge&logo=javascript&logoColor=111111)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License](https://img.shields.io/badge/License-ISC-blue?style=for-the-badge)](LICENSE)

<br>

**A feature-rich WhatsApp Multi-Device bot built with a modular plugin architecture.**

</div>

---

## ✦ About

**TENKA MD** is a JavaScript-based WhatsApp bot designed around a modular architecture, making features easier to maintain, extend, and reload during development.

The project uses **Node.js 22+**, ES Modules, a plugin system, local data/database utilities, schedulers, media processing, and a customized Baileys-compatible connection layer.

> Built for developers who want a WhatsApp bot that feels like a real project, not a 300-line `index.js` held together by prayer.

---

## ✧ Highlights

| Area | Included |
| --- | --- |
| WhatsApp | Multi-Device connection |
| Architecture | Modular plugin system |
| Development | Plugin hot-reload watcher |
| Database | Local database utilities |
| Scheduler | Automated scheduled tasks |
| Media | Image, audio, video & sticker tooling |
| Downloader | YouTube, TikTok and other media utilities |
| AI | Google Generative AI integration |
| Games | Game and RPG command systems |
| Groups | Group management & protection utilities |
| Automation | Notifications, backups & scheduled jobs |
| Developer Tools | ESLint and development scripts |

---

## ♡ Feature Set

### Core

- Multi-Device WhatsApp bot
- Plugin-based command architecture
- Dynamic plugin loading
- Development hot-reload support
- Owner and permission handling
- Group and private chat handling
- Message update processing
- Persistent local data handling

### Media & Downloader

- TikTok downloader
- YouTube search and media utilities
- Spotify utilities
- Thread/media downloader tools
- Sticker generation
- Text-to-speech utilities
- Image manipulation and canvas tools
- Video transcription
- HD media processing

### Group & Automation

- Group settings management
- Welcome and goodbye systems
- Promote/demote notifications
- Scheduled messages
- Prayer schedule automation
- Notification scheduler
- Auto-JPM scheduler
- Automatic backup utilities
- Temporary-file cleanup
- Data pruning
- Anti-remove and group protection systems

### Entertainment & Utilities

- Games and RPG systems
- Snake & ladder
- Genshin information/stalker utilities
- Pinterest utilities
- Wikipedia search
- Song search
- Holiday information
- Grow a Garden information
- Music card generator
- Logo and text utilities
- AI-powered chat utilities

---

## ⚡ Requirements

- **Node.js 22.0.0 or newer**
- npm
- A WhatsApp account for the bot session
- Stable internet connection

Check your Node.js version:

```bash
node -v
npm -v
```

---

## 🚀 Installation

### 1. Clone the repository

```bash
git clone https://github.com/nexacodeid/TENKAMD.git
cd TENKAMD
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the bot

Review the configuration in:

```text
config.js
```

Set the required owner, bot, API and feature configuration according to your environment.

### 4. Start TENKA MD

```bash
npm start
```

For development:

```bash
npm run dev
```

Lint the plugin directory:

```bash
npm run lint
```

---

## 📁 Project Structure

```text
TENKAMD/
├── assets/
│   ├── audio/
│   ├── fonts/
│   ├── image/
│   ├── kertas/
│   └── video/
├── case/
├── data/
├── database/
├── plugins/
├── src/
│   ├── connection.js
│   └── lib/
├── config.js
├── index.js
├── package.json
├── package-lock.json
└── UPDATE.txt
```

The repository separates connection handling, plugins, assets, persistent data, and supporting libraries so the codebase can grow without turning into spaghetti with a WhatsApp logo slapped on it.

---

## 🧩 Plugin Architecture

TENKA MD is designed around plugins. New functionality can be added independently without rewriting the core connection layer.

Typical workflow:

```text
WhatsApp Message
       ↓
 Message Handler
       ↓
 Plugin Loader
       ↓
 Command / Feature Plugin
       ↓
 Service / Utility
       ↓
 WhatsApp Response
```

During development, the bot also provides a plugin watcher so changes can be detected without manually restarting the entire process.

---

## 🛠️ Tech Stack

- **Node.js** — runtime
- **JavaScript / ES Modules** — application code
- **Baileys-compatible client** — WhatsApp Multi-Device layer
- **Pino** — logging
- **Node Cache** — caching
- **LowDB / local storage utilities** — persistent data
- **Sharp / Jimp / Canvas** — media processing
- **FFmpeg** — audio & video processing
- **Google Generative AI** — AI features
- **ESLint** — code quality

---

## 📌 Latest Update

### TENKA MD 3.1

Recent updates include improvements to menus, reply styles, schedulers, downloaders, games, media tools, group notifications, asset management, and multiple utility commands.

Notable additions include:

- Shuffle Reply Thumb (`.srt`)
- Asset replacement (`.ganti-asset`)
- Menu and reply system updates
- Game/RPG toggles
- Music card generator
- Genshin and Pinterest utilities
- TTP and logo maker tools
- Wikipedia and song search
- Video transcription
- PDDIKTI lookup
- Code bug finder utility
- Improved welcome/goodbye systems

See [`UPDATE.txt`](UPDATE.txt) for the detailed changelog.

---

## 🔐 Security Notes

Never commit secrets, session credentials, API keys, or private configuration to a public repository.

Recommended practice:

```text
.env
session/
credentials/
secrets/
```

Keep sensitive values outside Git and use environment variables where possible.

---

## 🤝 Contributing

Contributions are welcome when they improve stability, maintainability, documentation, or functionality.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally
5. Open a pull request

Keep plugins focused and avoid unnecessary changes to the core connection layer.

---

## ⚠️ Disclaimer

This project is intended for educational and legitimate automation purposes. Use WhatsApp automation responsibly and comply with applicable laws, platform rules, and the terms of services you use.

The maintainers are not responsible for misuse, account restrictions, data loss, or third-party service changes.

---

<div align="center">

### Made with JavaScript, caffeine, and questionable amounts of debugging.

<img src="https://i.pinimg.com/originals/91/5c/7b/915c7b0c8a7a6c0d5b3c8e7f6d9a1b2c.gif" width="420" alt="Kawaii Anime">

<br><br>

**TENKA MD** • Multi-Device WhatsApp Bot

</div>
