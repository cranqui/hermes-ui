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

    es.addEventListener('tool_progress', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (callbacks.onToolProgress) callbacks.onToolProgress(data)
      } catch (_) {}
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

  // Model info (via IPC — reads ~/.hermes/config.yaml + Ollama API)
  getModelInfo: () => ipcRenderer.invoke('get-model-info'),

  // ─── API key secure storage (safeStorage) ─────────────────────────────
  // Key is stored encrypted in app userData, never in localStorage.
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (plainText) => ipcRenderer.invoke('set-api-key', plainText),

  // ─── Hermes CLI (cron, skills, plugins) ──────────────────────────────
  cronList:       () => ipcRenderer.invoke('cron-list'),
  cronStatus:     () => ipcRenderer.invoke('cron-status'),
  cronPause:      (jobId) => ipcRenderer.invoke('cron-pause', jobId),
  cronResume:     (jobId) => ipcRenderer.invoke('cron-resume', jobId),
  cronRemove:     (jobId) => ipcRenderer.invoke('cron-remove', jobId),
  skillsList:     () => ipcRenderer.invoke('skills-list'),
  pluginsList:    () => ipcRenderer.invoke('plugins-list'),
  pluginsToggle:  (name, enable) => ipcRenderer.invoke('plugins-toggle', name, enable),
})