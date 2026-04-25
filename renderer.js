// ─── Guard: mark libraries as missing if npm install hasn't been run ─────────
if (typeof marked    === 'undefined') window._markedLoadFailed    = true
if (typeof DOMPurify === 'undefined') window._domPurifyLoadFailed = true

// ─── Minimal Markdown fallback (used if marked fails to load) ────────────────
window._simpleMarkdown = function simpleMarkdown(text) {
  let h = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,     '<em>$1</em>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
  return `<p>${h}</p>`
}

// ─── State ───────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  endpoint: 'http://localhost:8642/v1/chat/completions',
  apiKey: 'change-me-local-dev',
  model: 'hermes-agent',
}

let settings = { ...DEFAULT_SETTINGS }
let chats = []          // [{ id, title, messages: [], sessionId: string|null }]
let activeChatId = null
let isStreaming = false

// Model info from Hermes config + Ollama (fetched via IPC at boot)
let realModel = null     // e.g. "glm-5.1:cloud"
let contextWindow = null // e.g. 202752
let contextUsed = null   // prompt_tokens from last response

// ─── Marked initialisation (once, fixed for v5–v12 API) ─────────────────────

let _markedReady = false

function initMarked() {
  if (_markedReady) return
  if (typeof marked === 'undefined' || window._markedLoadFailed) return

  marked.use({ breaks: true, gfm: true })
  _markedReady = true
}

// ─── HTML sanitisation ───────────────────────────────────────────────────────

function sanitizeHtml(html) {
  if (typeof DOMPurify !== 'undefined' && !window._domPurifyLoadFailed) {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','b','i','code','pre','h1','h2','h3','h4',
        'ul','ol','li','blockquote','a','table','thead','tbody','tr','th','td',
        'span','div','hr','del','sup','sub'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
      ALLOW_DATA_ATTR: false,
    })
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    const s = localStorage.getItem('hermes_settings')
    if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }
    const c = localStorage.getItem('hermes_chats')
    if (c) chats = JSON.parse(c)
  } catch (_) {}
}

function saveState() {
  localStorage.setItem('hermes_settings', JSON.stringify(settings))
  localStorage.setItem('hermes_chats', JSON.stringify(chats))
}

// ─── Chat management ─────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function newChat() {
  const chat = { id: generateId(), title: 'New chat', messages: [], sessionId: null }
  chats.unshift(chat)
  activeChatId = chat.id
  saveState()
  renderSidebar()
  renderMessages()
  updateTopbar()
  updateContextPill()
}

function switchChat(id) {
  if (isStreaming) {
    window.hermesAPI.cancelStream()
    isStreaming = false
    setSendEnabled(true)
  }
  activeChatId = id
  renderMessages()
  updateTopbar()
  renderSidebar()
  updateContextPill()
}

function deleteChat(id) {
  chats = chats.filter(c => c.id !== id)
  if (activeChatId === id) activeChatId = chats[0]?.id || null
  saveState()
  renderSidebar()
  renderMessages()
  updateTopbar()
  updateContextPill()
}

function getActiveChat() {
  return chats.find(c => c.id === activeChatId) || null
}

function setTitle(id, title) {
  const c = chats.find(x => x.id === id)
  if (c) { c.title = title.slice(0, 60); saveState(); renderSidebar() }
}

// ─── Render helpers ───────────────────────────────────────────────────────────

const chatList       = document.getElementById('chat-list')
const msgContainer   = document.getElementById('messages')
const welcome        = document.getElementById('welcome')
const topbarTitle    = document.getElementById('topbar-title')
const sendBtn        = document.getElementById('send-btn')
const msgInput       = document.getElementById('message-input')
const attachmentsRow = document.getElementById('attachments-row')
const modelPillName  = document.getElementById('model-pill-name')

// ─── Model pill sync ──────────────────────────────────────────────────────────

function syncModelPill() {
  modelPillName.textContent = realModel || settings.model || DEFAULT_SETTINGS.model
}

// ─── Context pill (in input toolbar) ────────────────────────────────────────

function updateContextPill() {
  const pill = document.getElementById('ctx-pill')
  const text = document.getElementById('ctx-text')
  const fill = document.getElementById('ctx-fill')
  if (!pill) return

  if (contextWindow == null && contextUsed == null) {
    // Nothing received yet — keep hidden
    pill.classList.remove('visible')
    return
  }

  pill.classList.add('visible')

  if (contextWindow) {
    const used = contextUsed ?? 0
    const pct  = Math.min(100, Math.round(used / contextWindow * 100))
    text.textContent = `${formatTokens(used)} / ${formatTokens(contextWindow)}`
    fill.style.width = pct + '%'
    fill.className = pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : ''
  } else {
    // Know usage but not window size
    text.textContent = formatTokens(contextUsed)
    fill.style.width = '0%'
    fill.className = ''
  }
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  return String(n)
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderMarkdown(text) {
  initMarked()
  const raw = (_markedReady && typeof marked !== 'undefined')
    ? marked.parse(text)
    : window._simpleMarkdown(text)
  return sanitizeHtml(raw)
}

function renderSidebar() {
  chatList.innerHTML = ''
  for (const chat of chats) {
    const item = document.createElement('div')
    item.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '')
    item.innerHTML = `
      <span class="chat-item-title">${escapeHtml(chat.title)}</span>
      <button class="chat-item-delete" title="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
        </svg>
      </button>`
    item.querySelector('.chat-item-title').addEventListener('click', () => switchChat(chat.id))
    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation(); deleteChat(chat.id)
    })
    chatList.appendChild(item)
  }
}

function renderMessages() {
  const chat = getActiveChat()
  if (!chat) {
    welcome.style.display = 'flex'
    msgContainer.style.display = 'none'
    return
  }
  welcome.style.display = 'none'
  msgContainer.style.display = 'flex'
  msgContainer.innerHTML = ''
  for (const msg of chat.messages) appendMessageBubble(msg.role, msg.content, false)
  scrollToBottom()
}

function appendMessageBubble(role, content, streaming = false) {
  const row = document.createElement('div')
  row.className = `msg-row ${role}`
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'
  if (streaming) bubble.classList.add('typing-cursor')

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content)
  } else {
    bubble.textContent = content
  }

  row.appendChild(bubble)
  msgContainer.appendChild(row)
  scrollToBottom()
  return bubble
}

function scrollToBottom() {
  msgContainer.scrollTop = msgContainer.scrollHeight
}

function updateTopbar() {
  const chat = getActiveChat()
  topbarTitle.textContent = chat ? chat.title : 'Hermes Chat'
}

function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled
}

// ─── Send message ─────────────────────────────────────────────────────────────

function sendMessage() {
  const text = msgInput.value.trim()
  const hasAttachments = attachedFiles.length > 0
  if (!text && !hasAttachments) return
  if (isStreaming) return

  let chat = getActiveChat()
  if (!chat) { newChat(); chat = getActiveChat() }

  const fileCount   = attachedFiles.length
  const fileNames   = attachedFiles.map(f => f.name)
  const fullContent = buildMessageWithAttachments(text)
  chat.messages.push({ role: 'user', content: fullContent })

  // Clear input + attachments
  msgInput.value = ''
  attachedFiles = []
  renderAttachments()
  autoResize()
  saveState()

  welcome.style.display = 'none'
  msgContainer.style.display = 'flex'

  // In the bubble, show the user's text + a compact file tag list
  let bubbleText = text
  if (fileCount > 0) {
    const tag = fileNames.map(n => `📎 ${n}`).join('  ')
    bubbleText = text ? `${text}\n${tag}` : tag
  }
  appendMessageBubble('user', bubbleText || '(attachment)', false)

  const titleText = text || fileNames[0] || 'File attachment'
  if (chat.messages.length === 1) { setTitle(chat.id, titleText); updateTopbar() }

  isStreaming = true
  setSendEnabled(false)
  let streamDone = false // guard against duplicate onDone

  let accumulated = ''
  const bubble = appendMessageBubble('assistant', '', true)

  window.hermesAPI.removeAllListeners()

  window.hermesAPI.onChunk((chunk) => {
    accumulated += chunk
    bubble.innerHTML = renderMarkdown(accumulated)
    bubble.classList.add('typing-cursor')
    scrollToBottom()
  })

  window.hermesAPI.onModel((model) => {
    if (model) {
      realModel = model
      syncModelPill()
      updateContextPill()
    }
  })

  window.hermesAPI.onSession((sid) => {
    if (sid && chat) { chat.sessionId = sid; saveState() }
  })

  window.hermesAPI.onUsage((usage) => {
    if (usage && usage.prompt_tokens != null) {
      contextUsed = usage.prompt_tokens
      updateContextPill()
    }
  })

  window.hermesAPI.onDone(() => {
    if (streamDone) return // dedup
    streamDone = true
    bubble.classList.remove('typing-cursor')
    bubble.innerHTML = renderMarkdown(accumulated)
    chat.messages.push({ role: 'assistant', content: accumulated })
    saveState()
    isStreaming = false
    setSendEnabled(true)
    updateContextPill()
    msgInput.focus()
  })

  window.hermesAPI.onError((err) => {
    if (streamDone) return // dedup
    streamDone = true
    bubble.classList.remove('typing-cursor')
    if (!accumulated) bubble.innerHTML = `<span style="color:#e88">\u26A0 ${escapeHtml(err)}</span>`
    showError(err)
    isStreaming = false
    setSendEnabled(true)
  })

  window.hermesAPI.sendMessage(
    chat.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
    settings,
    chat.sessionId
  )
}

// ─── Input auto-resize ────────────────────────────────────────────────────────

function autoResize() {
  msgInput.style.height = 'auto'
  msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px'
}

msgInput.addEventListener('input', () => {
  autoResize()
  setSendEnabled((msgInput.value.trim().length > 0 || attachedFiles.length > 0) && !isStreaming)
})

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (!sendBtn.disabled) sendMessage()
  }
})

sendBtn.addEventListener('click', sendMessage)

document.getElementById('new-chat-btn').addEventListener('click', () => {
  newChat(); msgInput.focus()
})

// Model pill → open settings
document.getElementById('model-pill').addEventListener('click', openSettings)

// ─── File attachment ──────────────────────────────────────────────────────────

// attachedFiles: [{ name, content }]  — content is plain text (or a note for binary)
let attachedFiles = []

const fileInput  = document.getElementById('file-input')
const attachBtn  = document.getElementById('attach-btn')

attachBtn.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || [])
  if (!files.length) return

  files.forEach(file => {
    // Skip duplicates
    if (attachedFiles.find(f => f.name === file.name)) return

    const reader = new FileReader()

    if (file.type.startsWith('text/') || /\.(md|json|yaml|yml|toml|csv|xml|html|css|js|ts|py|sh|txt|log|env|ini|conf)$/i.test(file.name)) {
      reader.onload = (e) => {
        attachedFiles.push({ name: file.name, content: e.target.result })
        renderAttachments()
        setSendEnabled(true)
      }
      reader.readAsText(file)
    } else {
      // For binary/image files: attach a note — Hermes handles them as tool context
      attachedFiles.push({ name: file.name, content: `[Binary file: ${file.name} (${(file.size/1024).toFixed(1)} KB) — ${file.type || 'unknown type'}]` })
      renderAttachments()
      setSendEnabled(true)
    }
  })
  // Reset so same file can be re-attached after removal
  fileInput.value = ''
})

function renderAttachments() {
  attachmentsRow.innerHTML = ''
  attachedFiles.forEach((f, i) => {
    const chip = document.createElement('div')
    chip.className = 'attach-chip'
    chip.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;opacity:0.6">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <button class="attach-chip-remove" data-idx="${i}" title="Remove">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`
    chip.querySelector('.attach-chip-remove').addEventListener('click', () => {
      attachedFiles.splice(i, 1)
      renderAttachments()
      setSendEnabled(msgInput.value.trim().length > 0 || attachedFiles.length > 0)
    })
    attachmentsRow.appendChild(chip)
  })
}

// Inject attached file contents into the user message text
function buildMessageWithAttachments(text) {
  if (!attachedFiles.length) return text
  const fileBlock = attachedFiles.map(f =>
    `<file name="${f.name}">\n${f.content}\n</file>`
  ).join('\n\n')
  return text
    ? `${text}\n\n${fileBlock}`
    : fileBlock
}

// ─── Error toast ──────────────────────────────────────────────────────────────

let errorTimeout
function showError(msg) {
  const toast = document.getElementById('error-toast')
  toast.textContent = `\u26A0 ${msg}`
  toast.classList.add('show')
  clearTimeout(errorTimeout)
  errorTimeout = setTimeout(() => toast.classList.remove('show'), 5000)
}

// ─── Settings panel ───────────────────────────────────────────────────────────

const settingsOverlay = document.getElementById('settings-overlay')
const sEndpoint = document.getElementById('s-endpoint')
const sApiKey   = document.getElementById('s-apikey')
const sModel    = document.getElementById('s-model')
const connDot   = document.getElementById('conn-dot')
const connLabel = document.getElementById('conn-label')

document.getElementById('settings-btn').addEventListener('click', openSettings)
document.getElementById('cancel-settings-btn').addEventListener('click', closeSettings)
document.getElementById('save-settings-btn').addEventListener('click', saveSettings)
document.getElementById('test-connection-btn').addEventListener('click', testConnection)
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings() })

function openSettings() {
  sEndpoint.value = settings.endpoint
  sApiKey.value   = settings.apiKey
  sModel.value    = settings.model
  setConnStatus('grey', 'Not tested')
  settingsOverlay.classList.add('open')
}

function closeSettings() { settingsOverlay.classList.remove('open') }

function saveSettings() {
  settings.endpoint = sEndpoint.value.trim() || DEFAULT_SETTINGS.endpoint
  settings.apiKey   = sApiKey.value.trim()   || DEFAULT_SETTINGS.apiKey
  settings.model    = sModel.value.trim()    || DEFAULT_SETTINGS.model
  saveState()
  syncModelPill()
  closeSettings()
  // Re-fetch model info when settings change
  fetchModelInfo()
}

function setConnStatus(color, text) {
  connDot.className = `status-dot ${color}`
  connLabel.textContent = text
}

async function testConnection() {
  setConnStatus('grey', 'Testing\u2026')
  const endpoint = sEndpoint.value.trim() || DEFAULT_SETTINGS.endpoint
  const apiKey   = sApiKey.value.trim()   || DEFAULT_SETTINGS.apiKey

  try {
    const healthUrl = endpoint.replace(/\/v1\/chat\/completions$/, '/health')
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(8000) })
    if (res.ok || res.status === 200) {
      try {
        const modelsUrl = endpoint.replace(/\/v1\/chat\/completions$/, '/v1/models')
        const authRes = await fetch(modelsUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        })
        if (authRes.ok) {
          const data = await authRes.json()
          const list = (data.data || []).map(m => m.id).join(', ')
          setConnStatus('green', `Connected \u2713  Models: ${list || 'none'}`)
        } else if (authRes.status === 401) {
          setConnStatus('red', 'Server up, but API key rejected (401)')
        } else {
          setConnStatus('green', 'Connected \u2713 (auth unverified)')
        }
      } catch (_) {
        setConnStatus('green', 'Connected \u2713 (auth unverified)')
      }
    } else {
      setConnStatus('red', `HTTP ${res.status}`)
    }
  } catch (e) {
    setConnStatus('red', `Failed: ${e.message}`)
  }
}

// ─── Fetch real model info from Hermes config (via IPC) ──────────────────────

async function fetchModelInfo() {
  try {
    const info = await window.hermesAPI.getModelInfo()
    if (info && info.model) {
      realModel = info.model
      // Update settings model to show real name in pill
      if (settings.model === DEFAULT_SETTINGS.model) {
        settings.model = info.model
      }
      syncModelPill()
      saveState()
    }
    if (info && info.contextWindow) {
      contextWindow = info.contextWindow
    }
    updateContextPill()
  } catch (_) {
    // Silently fail — keep whatever model is in settings
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

loadState()
syncModelPill()
fetchModelInfo()
renderSidebar()
renderMessages()
updateTopbar()
updateContextPill()
setTimeout(() => msgInput.focus(), 100)