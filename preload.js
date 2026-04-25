const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hermesAPI', {
  sendMessage: (messages, settings, sessionId, chatId) => {
    ipcRenderer.send('chat-stream', { messages, settings, sessionId, chatId })
  },
  cancelStream: () => {
    ipcRenderer.send('chat-cancel')
  },
  onChunk: (cb) => ipcRenderer.on('chat-stream-chunk', (_e, chunk) => cb(chunk)),
  onDone: (cb) => ipcRenderer.on('chat-stream-done', (_e) => cb()),
  onError: (cb) => ipcRenderer.on('chat-stream-error', (_e, err) => cb(err)),
  onSession: (cb) => ipcRenderer.on('chat-stream-session', (_e, sid) => cb(sid)),
  onModel: (cb) => ipcRenderer.on('chat-stream-model', (_e, model) => cb(model)),
  onUsage: (cb) => ipcRenderer.on('chat-stream-usage', (_e, usage) => cb(usage)),
  getModelInfo: () => ipcRenderer.invoke('get-model-info'),
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('chat-stream-chunk')
    ipcRenderer.removeAllListeners('chat-stream-done')
    ipcRenderer.removeAllListeners('chat-stream-error')
    ipcRenderer.removeAllListeners('chat-stream-session')
    ipcRenderer.removeAllListeners('chat-stream-model')
    ipcRenderer.removeAllListeners('chat-stream-usage')
  },
})