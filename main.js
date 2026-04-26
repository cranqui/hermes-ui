const { app, BrowserWindow, ipcMain, shell, session } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')

let mainWindow

// ─── Stream Proxy State ──────────────────────────────────────────────────────
// Maps streamId → { request, buffer, events[], subscribers[], done, error }
const activeStreams = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f9f9fb',
    icon: path.join(__dirname, 'assets', 'icon.icns'),
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

  // ── Error boundaries ──────────────────────────────────────────────────
  // If the renderer process crashes, auto-reload it (localStorage is preserved)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Hermes Chat] Renderer process gone:', details.reason, details.exitCode)
    if (details.reason !== 'clean-exit') {
      // Small delay to let the OS clean up, then reload
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.loadFile('index.html')
          console.log('[Hermes Chat] Renderer reloaded after crash')
        }
      }, 1000)
    }
  })

  // Log unresponsive events (don't force-reload — it might recover)
  mainWindow.on('unresponsive', () => {
    console.warn('[Hermes Chat] Window became unresponsive — waiting for recovery')
  })
  mainWindow.on('responsive', () => {
    console.log('[Hermes Chat] Window recovered from unresponsive state')
  })
}

// ─── CSP + Security Headers ───────────────────────────────────────────
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
          "connect-src http://localhost:8642 http://127.0.0.1:8642 http://localhost:8643 http://127.0.0.1:8643; " +
          "font-src 'self'; " +
          "media-src 'none'; " +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "form-action 'none'; " +
          "frame-ancestors 'none'"
        ],
        'X-Content-Type-Options': ['nosniff'],
        'X-Frame-Options': ['DENY'],
        'Referrer-Policy': ['no-referrer'],
      },
    })
  })

  startProxyServer()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
  proxyServer?.close()
})

// Prevent uncaught errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[Hermes Chat] Uncaught exception:', err)
  // Show a dialog for truly unexpected errors so the user knows something went wrong
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { dialog } = require('electron')
    dialog.showErrorBox('Unexpected Error', `${err.message}\n\nThe app will continue running, but you may want to restart it.`)
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[Hermes Chat] Unhandled rejection:', reason)
})

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING PROXY SERVER
// ═══════════════════════════════════════════════════════════════════════════════
//
// Why: The Hermes API returns SSE on a single POST request. This means:
//   - If the connection drops, you lose the stream entirely (no reconnect)
//   - Canceling requires destroying the HTTP request (messy)
//   - The renderer can't use EventSource (which requires GET + auto-reconnect)
//
// Solution: A local HTTP proxy that splits into two endpoints:
//   POST /stream/start  →  Creates a Hermes API request, returns {streamId}
//   GET  /stream/events  →  SSE endpoint (EventSource-compatible), auto-reconnects
//   GET  /stream/cancel  →  Kills the active request for that stream
//
// The renderer uses EventSource for consumption (built-in reconnect!) and
// a simple fetch for start/cancel. This is the same pattern Hermes WebUI uses.
// ═══════════════════════════════════════════════════════════════════════════════

const PROXY_PORT = 8643
let proxyServer = null

function startProxyServer() {
  proxyServer = http.createServer((req, res) => {
    // CORS for local renderer (same-origin usually, but be safe)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://localhost:${PROXY_PORT}`)

    if (url.pathname === '/stream/start' && req.method === 'POST') {
      handleStreamStart(req, res)
    } else if (url.pathname === '/stream/events' && req.method === 'GET') {
      handleStreamEvents(req, res, url)
    } else if (url.pathname === '/stream/cancel' && req.method === 'GET') {
      handleStreamCancel(req, res, url)
    } else if (url.pathname === '/stream/status' && req.method === 'GET') {
      handleStreamStatus(req, res, url)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[Hermes Chat] Stream proxy on http://127.0.0.1:${PROXY_PORT}`)
  })
}

// ─── POST /stream/start ──────────────────────────────────────────────────────
// Creates a new Hermes API request and returns a streamId immediately.
// The renderer then connects to GET /stream/events?id=STREAM_ID.
function handleStreamStart(req, res) {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    let params
    try {
      params = JSON.parse(body)
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    const { messages, settings, sessionId, chatId } = params

    // Concurrency guard: reject if this chat is already streaming
    for (const [, stream] of activeStreams) {
      if (stream.chatId === chatId && !stream.done) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'A message is already being sent in this chat.', streamId: null }))
        return
      }
    }

    const streamId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

    // Create stream state
    const streamState = {
      streamId,
      chatId,
      request: null,
      events: [],      // buffered events for late subscribers
      subscribers: [], // { res }
      done: false,
      error: null,
      accumulated: '', // track content for reconnect recovery
      usage: null,
      model: null,
      sessionId: sessionId || null,
    }
    activeStreams.set(streamId, streamState)

    // Start the Hermes API request
    startHermesRequest(streamState, params)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ streamId }))
  })
}

// ─── GET /stream/events?id=STREAM_ID ─────────────────────────────────────────
// SSE endpoint. Renderer connects via EventSource. Auto-reconnect safe:
// on reconnect, we replay buffered events then continue live.
function handleStreamEvents(req, res, url) {
  const streamId = url.searchParams.get('id')
  const streamState = activeStreams.get(streamId)

  if (!streamState) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Stream not found')
    return
  }

  // Set up SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  })

  // Replay buffered events to this subscriber
  for (const event of streamState.events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
  }

  // If stream is already done, send done and close
  if (streamState.done) {
    if (streamState.error) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: streamState.error })}\n\n`)
    } else {
      res.write(`event: done\ndata: {}\n\n`)
    }
    res.end()
    return
  }

  // Register as a live subscriber
  const subscriber = { res }
  streamState.subscribers.push(subscriber)

  // Clean up on disconnect
  req.on('close', () => {
    const idx = streamState.subscribers.indexOf(subscriber)
    if (idx !== -1) streamState.subscribers.splice(idx, 1)
  })
}

// ─── GET /stream/cancel?id=STREAM_ID ─────────────────────────────────────────
function handleStreamCancel(req, res, url) {
  const streamId = url.searchParams.get('id')
  const streamState = activeStreams.get(streamId)

  if (!streamState) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Stream not found' }))
    return
  }

  // Destroy the Hermes request
  if (streamState.request) {
    try { streamState.request.destroy() } catch (_) {}
    streamState.request = null
  }

  // Notify subscribers and clean up
  if (!streamState.done) {
    streamState.done = true
    streamState.error = 'Cancelled by user'
    pushEvent(streamState, 'error', { message: 'Cancelled by user' })
    pushEvent(streamState, 'done', {})
  }

  // Clean up stream after a delay (allow late reconnects to get the final events)
  setTimeout(() => {
    cleanupStream(streamId)
  }, 5000)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ cancelled: true }))
}

// ─── GET /stream/status?id=STREAM_ID ─────────────────────────────────────────
function handleStreamStatus(req, res, url) {
  const streamId = url.searchParams.get('id')
  const streamState = activeStreams.get(streamId)

  if (!streamState) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Stream not found' }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    streamId,
    chatId: streamState.chatId,
    done: streamState.done,
    error: streamState.error,
    contentLength: streamState.accumulated.length,
    hasUsage: !!streamState.usage,
    hasModel: !!streamState.model,
  }))
}

// ─── Core: Start Hermes API Request ──────────────────────────────────────────
function startHermesRequest(streamState, params) {
  const { messages, settings, sessionId } = params
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

  let doneSent = false

  const req = transport.request(options, (apiRes) => {
    // Handle non-2xx status codes immediately
    if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
      let errBody = ''
      apiRes.on('data', (chunk) => { errBody += chunk.toString() })
      apiRes.on('end', () => {
        if (!doneSent) {
          doneSent = true
          streamState.done = true
          let msg = `HTTP ${apiRes.statusCode}`
          try { const j = JSON.parse(errBody); msg = j.error?.message || j.error || j.message || msg } catch (_) {}
          if (apiRes.statusCode === 401 || apiRes.statusCode === 403) msg = `Authentication failed (${apiRes.statusCode})`
          if (apiRes.statusCode === 404) msg = 'Session expired or not found. Start a new chat or resend.'
          streamState.error = msg
          pushEvent(streamState, 'error', { message: msg, statusCode: apiRes.statusCode, sessionExpired: apiRes.statusCode === 404 })
          setTimeout(() => cleanupStream(streamState.streamId), 60000)
        }
      })
      return
    }

    // Set response timeout: if no data arrives for 120s, destroy the connection
    apiRes.setTimeout(120_000, () => {
      if (!doneSent) {
        doneSent = true
        streamState.done = true
        streamState.error = 'Response timed out (120s)'
        pushEvent(streamState, 'error', { message: 'Response timed out (120s)' })
        req.destroy()
      }
    })
    let buffer = ''

    apiRes.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          if (!doneSent) {
            doneSent = true
            streamState.done = true
            pushEvent(streamState, 'done', {})
            // Clean up stream state after 5 minutes (allow reconnects)
            setTimeout(() => cleanupStream(streamState.streamId), 300000)
          }
          return
        }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) {
            streamState.accumulated += delta
            pushEvent(streamState, 'chunk', { content: delta })
          }
          if (parsed.usage) {
            streamState.usage = parsed.usage
            pushEvent(streamState, 'usage', parsed.usage)
          }
          if (parsed.model) {
            streamState.model = parsed.model
            pushEvent(streamState, 'model', { model: parsed.model })
          }
          const sid = parsed.headers?.['x-hermes-session-id'] || parsed.session_id
          if (sid) {
            streamState.sessionId = sid
            pushEvent(streamState, 'session', { sessionId: sid })
          }
          // Task list updates: Hermes emits { tasks: [{id, subject, status}, …] }
          if (parsed.tasks && Array.isArray(parsed.tasks)) {
            pushEvent(streamState, 'tasks', { tasks: parsed.tasks })
          }
        } catch (_) {
          // ignore malformed lines
        }
      }
    })

    apiRes.on('end', () => {
      if (!doneSent) {
        doneSent = true
        streamState.done = true
        pushEvent(streamState, 'done', {})
        setTimeout(() => cleanupStream(streamState.streamId), 300000)
      }
      if (streamState.request === req) streamState.request = null
    })

    apiRes.on('error', (err) => {
      if (!doneSent) {
        doneSent = true
        streamState.done = true
        streamState.error = err.message
        pushEvent(streamState, 'error', { message: err.message })
        setTimeout(() => cleanupStream(streamState.streamId), 60000)
      }
      if (streamState.request === req) streamState.request = null
    })
  })

  req.on('error', (err) => {
    if (!doneSent) {
      doneSent = true
      streamState.done = true
      streamState.error = err.message
      pushEvent(streamState, 'error', { message: err.message })
      setTimeout(() => cleanupStream(streamState.streamId), 60000)
    }
  })

  // Connection timeout: 30s to establish connection, 120s between data chunks
  req.setTimeout(30_000, () => {
    if (!doneSent) {
      doneSent = true
      streamState.done = true
      streamState.error = 'Connection timed out (30s)'
      pushEvent(streamState, 'error', { message: 'Connection timed out (30s)' })
      req.destroy()
    }
  })

  req.write(body)
  req.end()
  streamState.request = req
}

// ─── Push event to all SSE subscribers + buffer for reconnect ────────────────
function pushEvent(streamState, type, data) {
  const event = { type, data, timestamp: Date.now() }
  streamState.events.push(event)

  // Buffer limit: keep max 5000 events to prevent memory leaks on very long streams
  if (streamState.events.length > 5000) {
    streamState.events = streamState.events.slice(-2500)
  }

  for (const sub of streamState.subscribers) {
    try {
      sub.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch (_) {
      // Subscriber disconnected; will be cleaned up on close event
    }
  }
}

// ─── Clean up completed stream state ──────────────────────────────────────────
function cleanupStream(streamId) {
  const streamState = activeStreams.get(streamId)
  if (!streamState) return

  // Close any remaining SSE subscriber connections
  for (const sub of streamState.subscribers) {
    try { sub.res.end() } catch (_) {}
  }

  // Destroy the Hermes request if still active
  if (streamState.request) {
    try { streamState.request.destroy() } catch (_) {}
  }

  activeStreams.delete(streamId)
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY IPC — Consolidated single-channel events (typed payloads)
// ═══════════════════════════════════════════════════════════════════════════════
// Instead of 7 separate IPC channels (chat-stream-chunk, -done, -error, -usage,
// -model, -session, chat-cancel), we now use a single 'chat-event' channel.
// Each event has a `type` field and a `payload` field. The renderer handles them
// via one listener with a switch statement — no listener accumulation possible.
//
// Event types: chunk, done, error, usage, model, session

let activeRequest = null
let activeChatId = null

function sendChatEvent(event, type, payload) {
  event.sender.send('chat-event', { type, payload })
}

ipcMain.on('chat-stream', (event, { messages, settings, sessionId, chatId }) => {
  if (activeChatId === chatId) {
    sendChatEvent(event, 'error', { message: 'A message is already being sent in this chat.' })
    return
  }

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

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

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

  let doneSent = false

  const req = transport.request(options, (apiRes) => {
    // Handle non-2xx status codes immediately
    if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
      let errBody = ''
      apiRes.on('data', (chunk) => { errBody += chunk.toString() })
      apiRes.on('end', () => {
        if (!doneSent) {
          doneSent = true
          activeChatId = null
          let msg = `HTTP ${apiRes.statusCode}`
          try { const j = JSON.parse(errBody); msg = j.error?.message || j.error || j.message || msg } catch (_) {}
          if (apiRes.statusCode === 401 || apiRes.statusCode === 403) msg = `Authentication failed (${apiRes.statusCode})`
          if (apiRes.statusCode === 404) msg = 'Session expired or not found. Start a new chat or resend.'
          sendChatEvent(event, 'error', { message: msg, statusCode: apiRes.statusCode, sessionExpired: apiRes.statusCode === 404 })
        }
      })
      return
    }

    // Response timeout: 120s between data chunks
    apiRes.setTimeout(120_000, () => {
      if (!doneSent) {
        doneSent = true
        activeChatId = null
        sendChatEvent(event, 'error', { message: 'Response timed out (120s)' })
      }
      if (activeRequest === req) activeRequest = null
      req.destroy()
    })

    let buffer = ''

    apiRes.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          if (!doneSent) {
            doneSent = true
            activeChatId = null
            sendChatEvent(event, 'done', {})
          }
          return
        }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) sendChatEvent(event, 'chunk', { content: delta })
          if (parsed.usage) sendChatEvent(event, 'usage', parsed.usage)
          if (parsed.model) sendChatEvent(event, 'model', { model: parsed.model })
          const sid = parsed.headers?.['x-hermes-session-id'] || parsed.session_id
          if (sid) sendChatEvent(event, 'session', { sessionId: sid })
          if (parsed.tasks && Array.isArray(parsed.tasks)) {
            sendChatEvent(event, 'tasks', { tasks: parsed.tasks })
          }
        } catch (_) {}
      }
    })

    apiRes.on('end', () => {
      if (!doneSent) {
        doneSent = true
        activeChatId = null
        sendChatEvent(event, 'done', {})
      }
      if (activeRequest === req) activeRequest = null
    })

    apiRes.on('error', (err) => {
      if (!doneSent) {
        doneSent = true
        activeChatId = null
        sendChatEvent(event, 'error', { message: err.message })
      }
      if (activeRequest === req) activeRequest = null
    })
  })

  req.on('error', (err) => {
    sendChatEvent(event, 'error', { message: err.message })
    activeChatId = null
    if (activeRequest === req) activeRequest = null
  })

  // Connection timeout: 30s to establish connection
  req.setTimeout(30_000, () => {
    if (!doneSent) {
      doneSent = true
      sendChatEvent(event, 'error', { message: 'Connection timed out (30s)' })
      activeChatId = null
      if (activeRequest === req) activeRequest = null
    }
    req.destroy()
  })

  req.write(body)
  req.end()
  activeRequest = req
  activeChatId = chatId
})

ipcMain.on('chat-cancel', () => {
  if (activeRequest) {
    try { activeRequest.destroy() } catch (_) {}
    activeRequest = null
  }
  activeChatId = null
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

// ─── IPC: Hermes CLI commands (cron, skills, plugins) ───────────────────────
const { execSync } = require('child_process')

function runHermes(args) {
  try {
    const out = execSync(`hermes ${args}`, { timeout: 15000, encoding: 'utf8' })
    return { ok: true, data: out }
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message }
  }
}

ipcMain.handle('cron-list', async () => {
  const r = runHermes('cron list')
  if (!r.ok) return r
  const jobs = []
  const blocks = r.data.split(/\n\s*\n/).filter(b => b.includes('[active]') || b.includes('[paused]'))
  for (const block of blocks) {
    const id = (block.match(/^\s*([a-f0-9]+)\s*\[/m) || [])[1]
    const status = (block.match(/\[(active|paused)\]/) || [])[1]
    const name = (block.match(/Name:\s+(.+)/) || [])[1]?.trim()
    const schedule = (block.match(/Schedule:\s+(.+)/) || [])[1]?.trim()
    const repeat = (block.match(/Repeat:\s+(.+)/) || [])[1]?.trim()
    const nextRun = (block.match(/Next run:\s+(.+)/) || [])[1]?.trim()
    const deliver = (block.match(/Deliver:\s+(.+)/) || [])[1]?.trim()
    const skills = (block.match(/Skills:\s+(.+)/) || [])[1]?.trim()
    const lastRunLine = block.match(/Last run:\s+(.+)/)?.[1]?.trim()
    let lastRun = null, lastStatus = null
    if (lastRunLine) {
      const parts = lastRunLine.match(/(.+?)\s+(ok|error|running)$/s)
      if (parts) { lastRun = parts[1].trim(); lastStatus = parts[2] }
      else { lastRun = lastRunLine }
    }
    if (id) jobs.push({ id, status, name, schedule, repeat, nextRun, deliver, skills, lastRun, lastStatus })
  }
  return { ok: true, data: jobs }
})

ipcMain.handle('cron-status', async () => {
  return runHermes('cron status')
})

ipcMain.handle('cron-pause', async (_e, jobId) => {
  return runHermes(`cron pause ${jobId}`)
})

ipcMain.handle('cron-resume', async (_e, jobId) => {
  return runHermes(`cron resume ${jobId}`)
})

ipcMain.handle('cron-remove', async (_e, jobId) => {
  return runHermes(`cron rm ${jobId}`)
})

ipcMain.handle('skills-list', async () => {
  const r = runHermes('skills list')
  if (!r.ok) return r
  const skills = []
  const lines = r.data.split('\n')
  // Parse rows between the header separator and footer
  let inTable = false
  for (const line of lines) {
    if (line.includes('━')) { inTable = !inTable; continue }
    if (!inTable) continue
    const m = line.match(/│\s*(.+?)\s*│\s*(.+?)\s*│\s*(.+?)\s*│\s*(.+?)\s*│/)
    if (m) {
      skills.push({ name: m[1].trim(), category: m[2].trim(), source: m[3].trim(), trust: m[4].trim() })
    }
  }
  return { ok: true, data: skills }
})

ipcMain.handle('plugins-list', async () => {
  const r = runHermes('plugins list')
  if (!r.ok) return r
  const plugins = []
  const lines = r.data.split('\n')
  let inTable = false, currentPlugin = null
  for (const line of lines) {
    if (line.includes('━')) { inTable = !inTable; continue }
    if (!inTable) continue
    const m = line.match(/│\s*(.+?)\s*│\s*(.+?)\s*│\s*(.+?)\s*│\s*(.+?)\s*│\s*(.+?)\s*│/)
    if (m) {
      const name = m[1].trim(), status = m[2].trim(), version = m[3].trim(), desc = m[4].trim(), source = m[5].trim()
      if (name) {
        if (currentPlugin) plugins.push(currentPlugin)
        currentPlugin = { name, status, version, description: desc, source }
      } else if (currentPlugin && desc) {
        // Multi-line description
        currentPlugin.description += ' ' + desc
      }
    }
  }
  if (currentPlugin) plugins.push(currentPlugin)
  return { ok: true, data: plugins }
})

ipcMain.handle('plugins-toggle', async (_e, name, enable) => {
  const action = enable ? 'enable' : 'disable'
  return runHermes(`plugins ${action} ${name}`)
})