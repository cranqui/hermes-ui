const { app, BrowserWindow, ipcMain, shell, session } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile('index.html')

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ─── CSP: tighten for security ──────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https:; " +
          "connect-src http://localhost:8642 http://127.0.0.1:8642; " +
          "font-src 'self'; " +
          "media-src 'none'; " +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'none'; " +
          "frame-ancestors 'none'"
        ],
      },
    })
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Prevent uncaught errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[Hermes Chat] Uncaught exception:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Hermes Chat] Unhandled rejection:', reason)
})

// ─── IPC: Chat request → Hermes API (streaming) ─────────────────────────

// Track active requests so we can cancel on chat switch
let activeRequest = null

ipcMain.on('chat-stream', (event, { messages, settings, sessionId }) => {
  const { endpoint, apiKey, model } = settings
  const url = new URL(endpoint)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http

  const body = JSON.stringify({
    model: model || 'hermes-agent',
    messages,
    stream: true,
  })

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }

  // Add Bearer auth if key is configured
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Session continuity: reuse Hermes session across messages in the same chat
  if (sessionId) {
    headers['X-Hermes-Session-Id'] = sessionId
  }

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers,
  }

  // Cancel any previous in-flight request
  if (activeRequest) {
    try { activeRequest.destroy() } catch (_) {}
    activeRequest = null
  }

  let doneSent = false

  const req = transport.request(options, (res) => {
    let buffer = ''

    res.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          if (!doneSent) {
            doneSent = true
            event.sender.send('chat-stream-done')
          }
          return
        }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) event.sender.send('chat-stream-chunk', delta)
          // Capture usage from final chunk (prompt_tokens, completion_tokens, total_tokens)
          if (parsed.usage) event.sender.send('chat-stream-usage', parsed.usage)
          // Capture model name from first response (e.g. "glm-5.1:cloud")
          if (parsed.model) event.sender.send('chat-stream-model', parsed.model)
          // Capture session ID from first response if available
          const sid = parsed.headers?.['x-hermes-session-id'] || parsed.session_id
          if (sid) event.sender.send('chat-stream-session', sid)
        } catch (_) {
          // ignore malformed lines
        }
      }
    })

    res.on('end', () => {
      if (!doneSent) {
        doneSent = true
        event.sender.send('chat-stream-done')
      }
      if (activeRequest === req) activeRequest = null
    })

    res.on('error', (err) => {
      if (!doneSent) {
        doneSent = true
        event.sender.send('chat-stream-error', err.message)
      }
      if (activeRequest === req) activeRequest = null
    })
  })

  req.on('error', (err) => {
    event.sender.send('chat-stream-error', err.message)
    if (activeRequest === req) activeRequest = null
  })

  req.write(body)
  req.end()
  activeRequest = req
})

// Cancel active stream when user switches chats
ipcMain.on('chat-cancel', () => {
  if (activeRequest) {
    try { activeRequest.destroy() } catch (_) {}
    activeRequest = null
  }
})

// ─── IPC: Fetch real model info from Hermes config + Ollama ────────────

const fs = require('fs')
const os = require('os')

function readHermesConfig() {
  const configPath = path.join(os.homedir(), '.hermes', 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const getModel = () => {
      const m = raw.match(/^  default:\s*(.+)/m)
      return m ? m[1].trim() : null
    }
    const getBaseUrl = () => {
      const m = raw.match(/^  base_url:\s*(.+)/m)
      return m ? m[1].trim() : null
    }
    return { model: getModel(), baseUrl: getBaseUrl() }
  } catch (_) {
    return null
  }
}

function fetchOllamaContextWindow(modelName) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ name: modelName })
    const opts = {
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/show',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 5000,
    }
    const req = http.request(opts, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const info = data.model_info || {}
          const ctxKey = Object.keys(info).find(k => k.endsWith('.context_length'))
          resolve(ctxKey ? info[ctxKey] : null)
        } catch (_) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(postData)
    req.end()
  })
}

ipcMain.handle('get-model-info', async () => {
  const cfg = readHermesConfig()
  if (!cfg || !cfg.model) return { model: null, contextWindow: null }

  let contextWindow = null
  if (cfg.baseUrl && cfg.baseUrl.includes(':11434')) {
    contextWindow = await fetchOllamaContextWindow(cfg.model)
  }

  return { model: cfg.model, contextWindow }
})