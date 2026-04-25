# Hermes Chat

A desktop chat interface for [Hermes Agent](https://hermes-agent.nousresearch.com/) — built with Electron.
Dark-themed, streaming responses, persistent chat history, markdown rendering.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer)
- Hermes Agent installed and running locally

---

## 1. Enable Hermes API server

In your Hermes `.env` file (`~/.hermes/.env`), make sure these are set:

```
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
```

Then (re)start the Hermes gateway:

```bash
hermes gateway restart
```

It will start the API server at `http://localhost:8642`.

> On loopback (127.0.0.1) with no API key, all requests are allowed.
> With a key set, Bearer auth is required.

---

## 2. Install & run the app

```bash
# From this folder:
npm install
npm start
```

The app window will open. On first launch, click **Settings** (bottom-left) to confirm your endpoint/key if you changed the defaults.

---

## Default settings

| Setting  | Default value                                       |
|----------|-----------------------------------------------------|
| Endpoint | `http://localhost:8642/v1/chat/completions`         |
| API Key  | `change-me-local-dev`                               |
| Model    | `hermes-agent`                                      |

---

## Features

- Streaming responses with live typing cursor
- Full Markdown rendering (code blocks, tables, lists)
- Persistent chat history (saved in localStorage)
- Session continuity via X-Hermes-Session-Id header
- Settings panel to change endpoint, API key, and model
- Connection test button in Settings (checks /health + /v1/models)
- Dark theme, native macOS title bar
- Content Security Policy (CSP) for XSS protection
- DOMPurify HTML sanitization on model output
- Stream cancellation on chat switch

---

## Security

- **CSP**: Strict Content-Security-Policy blocks inline scripts, restricts `connect-src` to localhost:8642
- **Sandbox**: Electron renderer sandbox enabled (`sandbox: true` in webPreferences)
- **Context isolation**: Enabled (default in modern Electron)
- **HTML sanitization**: DOMPurify sanitizes all markdown-rendered model output
- **No nodeIntegration**: Renderer has no direct Node.js access
- **Auth**: Bearer token required if API_SERVER_KEY is set

---

## Package as a standalone Mac app (optional)

```bash
npm install --save-dev electron-builder
npx electron-builder --mac
```

The `.dmg` will appear in the `dist/` folder.