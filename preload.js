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
          if (callbacks.onError) callbacks.onError(data.message || 'Stream error', data)
        } catch (_) {
          if (callbacks.onError) callbacks.onError('Stream error', {})
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
      if (callbacks.onError) callbacks.onError('Connection lost', {})
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

  // ─── Consolidated IPC event listener ──────────────────────────────────
  // Single channel replaces the old 7 separate listeners (onChunk, onDone,
  // onError, onUsage, onModel, onSession, removeAllListeners).
  // The renderer registers ONE callback that receives { type, payload }.
  // No listener accumulation possible — replacing the callback is safe.

  onChatEvent: (callback) => {
    // Remove any previous listener to prevent accumulation
    ipcRenderer.removeAllListeners('chat-event')
    ipcRenderer.on('chat-event', (_event, data) => callback(data))
  },

  // Legacy: send message via IPC (used as fallback if proxy is unavailable)
  sendMessageIPC: (messages, settings, sessionId, chatId) => {
    ipcRenderer.send('chat-stream', { messages, settings, sessionId, chatId })
  },

  // Cancel via IPC
  cancelStreamIPC: () => {
    ipcRenderer.send('chat-cancel')
  },
})