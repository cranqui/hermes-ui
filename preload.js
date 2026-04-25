const { contextBridge, ipcRenderer } = require('electron')

const PROXY_URL = 'http://127.0.0.1:8643'

// ─── Stream Proxy API (primary) ──────────────────────────────────────────
// Uses local HTTP proxy + EventSource for auto-reconnecting SSE.
// Much more reliable than direct IPC for long-running streams.

contextBridge.exposeInMainWorld('hermesAPI', {
  // Start a new stream via the local proxy
  startStream: async (messages, settings, sessionId, chatId) => {
    const res = await fetch(`${PROXY_URL}/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, settings, sessionId, chatId }),
    })
    if (res.status === 409) {
      // Concurrency conflict
      const data = await res.json()
      throw new Error(data.error || 'Stream already active for this chat')
    }
    if (!res.ok) {
      throw new Error(`Stream start failed: ${res.status}`)
    }
    return (await res.json()).streamId
  },

  // Connect to stream events via EventSource (auto-reconnects!)
  connectStream: (streamId, callbacks) => {
    const es = new EventSource(`${PROXY_URL}/stream/events?id=${streamId}`)

    es.addEventListener('chunk', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (callbacks.onChunk) callbacks.onChunk(data.content)
      } catch (_) {}
    })

    es.addEventListener('model', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (callbacks.onModel) callbacks.onModel(data.model)
      } catch (_) {}
    })

    es.addEventListener('session', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (callbacks.onSession) callbacks.onSession(data.sessionId)
      } catch (_) {}
    })

    es.addEventListener('usage', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (callbacks.onUsage) callbacks.onUsage(data)
      } catch (_) {}
    })

    es.addEventListener('error', (e) => {
      // Check if it's an SSE event with data (our proxy error)
      if (e.data) {
        try {
          const data = JSON.parse(e.data)
          if (callbacks.onError) callbacks.onError(data.message || 'Stream error')
        } catch (_) {
          if (callbacks.onError) callbacks.onError('Stream error')
        }
        es.close()
        if (callbacks.onDone) callbacks.onDone()
        return
      }
      // Native EventSource error — could be reconnect or real disconnect
      // If readyState is CONNECTING (0), EventSource is auto-reconnecting
      if (es.readyState === EventSource.CONNECTING) {
        // Auto-reconnect in progress, don't call onError yet
        return
      }
      // readyState is CLOSED (2) — real failure
      if (callbacks.onError) callbacks.onError('Connection lost')
      es.close()
      if (callbacks.onDone) callbacks.onDone()
    })

    es.addEventListener('done', () => {
      if (callbacks.onDone) callbacks.onDone()
      es.close()
    })

    // Return control object so renderer can close the EventSource
    return {
      close: () => es.close(),
      eventSource: es,
    }
  },

  // Cancel a stream
  cancelStream: async (streamId) => {
    try {
      const res = await fetch(`${PROXY_URL}/stream/cancel?id=${streamId}`)
      return (await res.json()).cancelled
    } catch (_) {
      return false
    }
  },

  // Check stream status (for reconnect recovery)
  streamStatus: async (streamId) => {
    try {
      const res = await fetch(`${PROXY_URL}/stream/status?id=${streamId}`)
      if (!res.ok) return null
      return await res.json()
    } catch (_) {
      return null
    }
  },

  // Model info (still via IPC — no streaming needed)
  getModelInfo: () => ipcRenderer.invoke('get-model-info'),

  // ─── Legacy IPC (fallback) ──────────────────────────────────────────
  sendMessage: (messages, settings, sessionId, chatId) => {
    ipcRenderer.send('chat-stream', { messages, settings, sessionId, chatId })
  },
  cancelStreamIPC: () => {
    ipcRenderer.send('chat-cancel')
  },
  onChunk: (cb) => ipcRenderer.on('chat-stream-chunk', (_e, chunk) => cb(chunk)),
  onDone: (cb) => ipcRenderer.on('chat-stream-done', (_e) => cb()),
  onError: (cb) => ipcRenderer.on('chat-stream-error', (_e, err) => cb(err)),
  onSession: (cb) => ipcRenderer.on('chat-stream-session', (_e, sid) => cb(sid)),
  onModel: (cb) => ipcRenderer.on('chat-stream-model', (_e, model) => cb(model)),
  onUsage: (cb) => ipcRenderer.on('chat-stream-usage', (_e, usage) => cb(usage)),
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('chat-stream-chunk')
    ipcRenderer.removeAllListeners('chat-stream-done')
    ipcRenderer.removeAllListeners('chat-stream-error')
    ipcRenderer.removeAllListeners('chat-stream-session')
    ipcRenderer.removeAllListeners('chat-stream-model')
    ipcRenderer.removeAllListeners('chat-stream-usage')
  },
})