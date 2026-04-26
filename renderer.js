// ─── Guard: mark libraries as missing if npm install hasn't been run ─────────
if (typeof marked    === 'undefined') window._markedLoadFailed    = true
if (typeof DOMPurify === 'undefined') window._domPurifyLoadFailed = true
if (typeof katex     === 'undefined') window._katexLoadFailed      = true

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
  sendKey: 'enter', // 'enter' or 'ctrl-enter'
}

let settings = { ...DEFAULT_SETTINGS }
let chats = []          // [{ id, title, messages: [], sessionId: string|null }]
let activeChatId = null
let isStreaming = false

// Model info from Hermes config + Ollama (fetched via IPC at boot)
let realModel = null     // e.g. "glm-5.1:cloud"
let contextWindow = null // e.g. 202752
let contextUsed = null   // prompt_tokens from last response
let isConnected = false  // topbar dot: green when Hermes API reachable

// ─── Inflight state persistence ─────────────────────────────────────────────
// If Electron crashes or the renderer dies mid-stream, we want to recover the
// partial conversation on next boot. We save a snapshot before each request
// and update it as content streams in. On clean completion, we clear it.
// On boot, if we find an inflight snapshot, we restore the partial assistant
// message and mark it [interrupted] so the user knows it wasn't finished.

const INFLIGHT_KEY = 'hermes_inflight'

function saveInflight(chatId, messages, sessionId, accumulated, model) {
  const snapshot = {
    chatId,
    messages,        // array of {role, content, id, createdAt, model, promptTokens}
    sessionId,
    accumulated,     // partial assistant content so far (empty string on request start)
    model,           // model name from stream (for recovery)
    createdAt: Date.now(), // when the user message was sent
    timestamp: Date.now(),
  }
  try {
    localStorage.setItem(INFLIGHT_KEY, JSON.stringify(snapshot))
  } catch (_) {}
}

function clearInflight() {
  try { localStorage.removeItem(INFLIGHT_KEY) } catch (_) {}
}

function loadInflight() {
  try {
    const raw = localStorage.getItem(INFLIGHT_KEY)
    if (!raw) return null
    const snapshot = JSON.parse(raw)
    // Discard if older than 24 hours (stale)
    if (Date.now() - snapshot.timestamp > 24 * 60 * 60 * 1000) {
      clearInflight()
      return null
    }
    return snapshot
  } catch (_) {
    return null
  }
}

function recoverInflight() {
  const snapshot = loadInflight()
  if (!snapshot) return

  // Find the chat this inflight belongs to
  let chat = chats.find(c => c.id === snapshot.chatId)
  if (!chat) {
    // Chat was deleted — discard
    clearInflight()
    return
  }

  // Check if the messages already include the assistant response
  // (edge case: stream completed but clearInflight failed)
  const lastMsg = chat.messages[chat.messages.length - 1]
  if (lastMsg && lastMsg.role === 'assistant') {
    clearInflight()
    return
  }

  // Verify the user message is still the last user message in the chat
  const chatUserMsgs = chat.messages.filter(m => m.role === 'user')
  const snapshotUserMsgs = snapshot.messages.filter(m => m.role === 'user')
  if (chatUserMsgs.length < snapshotUserMsgs.length) {
    // Messages were lost — restore from snapshot
    chat.messages = snapshot.messages.slice()
  }

  // If we have accumulated content, add it as an interrupted assistant message
  if (snapshot.accumulated && snapshot.accumulated.trim()) {
    // Enhanced message model: id, createdAt, model, promptTokens
    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: snapshot.accumulated + '\n\n— *Response interrupted (app restarted)*',
      model: snapshot.model || null,
      promptTokens: snapshot.promptTokens || null,
      createdAt: snapshot.createdAt || Date.now(),
    })
  }

  // Restore session ID if we had one
  if (snapshot.sessionId) {
    chat.sessionId = snapshot.sessionId
  }

  // Set this chat as active
  activeChatId = chat.id
  saveState()
  clearInflight()

  console.log(`[Hermes] Recovered inflight state for chat "${chat.title}" (${snapshot.accumulated.length} chars recovered)`)
}

// ─── Marked initialisation (once, fixed for v5–v12 API) ─────────────────────

let _markedReady = false

function initMarked() {
  if (_markedReady) return
  if (typeof marked === 'undefined' || window._markedLoadFailed) return

  marked.use({ breaks: true, gfm: true })
  _markedReady = true
}

// ─── Streaming Markdown: delta renderer ───────────────────────────────────────
// Instead of re-parsing the entire text on every chunk, we debounce the DOM
// update during streaming. Text accumulates in memory; the bubble is updated
// every ~150ms to avoid excessive innerHTML rewrites + highlightCodeBlocks scans.
// Full re-render + highlighting on stream completion.

const _streamState = { prevLen: 0, prevRendered: '', inCodeFence: false }

function renderStreamChunk(accumulated) {
  const openFences = (accumulated.match(/```/g) || []).length
  let html = renderMarkdown(accumulated)
  // If odd number of code fence markers, close the last one
  if (openFences % 2 !== 0) {
    html += '</code></pre>'
  }
  _streamState.prevLen = accumulated.length
  _streamState.prevRendered = html
  return html
}

function resetStreamState() {
  _streamState.prevLen = 0
  _streamState.prevRendered = ''
  _streamState.inCodeFence = false
}

// Debounced DOM update for streaming: renders markdown at most every 150ms.
// The accumulated text is always up-to-date; only the visual repaint is throttled.
let _renderDebounceTimer = null
let _renderDebounceAccumulated = ''
let _renderDebounceBubble = null
const STREAM_RENDER_INTERVAL = 150  // ms

function debouncedStreamRender(bubble, accumulated) {
  _renderDebounceAccumulated = accumulated
  _renderDebounceBubble = bubble
  if (_renderDebounceTimer) return  // already scheduled
  _renderDebounceTimer = setTimeout(() => {
    _renderDebounceTimer = null
    if (_renderDebounceBubble && _renderDebounceAccumulated) {
      _renderDebounceBubble.innerHTML = renderStreamChunk(_renderDebounceAccumulated)
      _renderDebounceBubble.classList.add('typing-cursor')
      if (!userScrolledUp) scrollToBottom()
    }
  }, STREAM_RENDER_INTERVAL)
}

function flushStreamRender() {
  if (_renderDebounceTimer) {
    clearTimeout(_renderDebounceTimer)
    _renderDebounceTimer = null
  }
  if (_renderDebounceBubble && _renderDebounceAccumulated) {
    _renderDebounceBubble.innerHTML = renderStreamChunk(_renderDebounceAccumulated)
  }
}

// ─── HTML sanitisation ───────────────────────────────────────────────────────

function sanitizeHtml(html) {
  if (typeof DOMPurify !== 'undefined' && !window._domPurifyLoadFailed) {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','b','i','code','pre','h1','h2','h3','h4',
        'ul','ol','li','blockquote','a','table','thead','tbody','tr','th','td',
        'span','div','hr','del','sup','sub','button','svg','path','polyline','line'],
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'd', 'viewBox',
        'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
        'stroke-linejoin', 'points', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r',
        'data-lang', 'data-clipboard-target'],
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

// ─── Syntax highlighting helper ──────────────────────────────────────────────

function highlightCodeBlocks(container) {
  if (typeof hljs !== 'undefined' && !window._hljsLoadFailed) {
    container.querySelectorAll('pre code').forEach((block) => {
      // Only highlight unprocessed blocks
      if (!block.dataset.highlighted) {
        hljs.highlightElement(block)
        block.dataset.highlighted = 'true'
      }

      // Add language label + copy button (only once per block)
      if (block.parentElement && !block.parentElement.querySelector('.code-header')) {
        const pre = block.parentElement
        const lang = (block.className.match(/language-(\S+)/) || [])[1] || ''

        const header = document.createElement('div')
        header.className = 'code-header'
        header.innerHTML = `
          <span class="code-lang">${escapeHtml(lang)}</span>
          <button class="code-copy-btn" title="Copy code">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>`

        header.querySelector('.code-copy-btn').addEventListener('click', () => {
          navigator.clipboard.writeText(block.textContent).then(() => {
            const btn = header.querySelector('.code-copy-btn')
            const originalHTML = btn.innerHTML
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
            setTimeout(() => { btn.innerHTML = originalHTML }, 1500)
          })
        })

        pre.insertBefore(header, block)
      }
    })
  }
}

// ─── KaTeX math rendering ─────────────────────────────────────────────────
// Renders $inline$ and $$display$$ math inside a DOM container.
// Only called on final renders (finishStream, renderMessages) — NOT during
// streaming, to avoid flicker (KaTeX replaces text nodes which get wiped on
// the next innerHTML update). Raw $...$ is readable enough mid-stream.

function renderMath(container) {
  if (typeof renderMathInElement === 'undefined' || window._katexLoadFailed) return
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
      ],
      // Skip math inside code blocks and <pre>
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      // Only process text nodes, not already-rendered math
      ignoredClasses: ['katex-display', 'katex'],
      throwOnError: false,
      // Strict false = allow \textbf etc. inside math
      strict: false,
    })
  } catch (_) {
    // Silently fail — raw math is still readable
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────
// Per-chat localStorage: O(1) saves on the active chat instead of O(N) full blob.
// Layout:
//   hermes_settings     → global settings (unchanged)
//   hermes_chats_index  → [{id, title, sessionId, createdAt}, ...] sidebar metadata
//   hermes_chat:{id}    → {id, title, sessionId, createdAt, messages} per-chat data

const CHATS_INDEX_KEY = 'hermes_chats_index'
function chatKey(id) { return `hermes_chat:${id}` }

function loadState() {
  try {
    const s = localStorage.getItem('hermes_settings')
    if (s) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) }

    // Try per-chat layout first; fall back to legacy single-blob
    const idx = localStorage.getItem(CHATS_INDEX_KEY)
    if (idx) {
      const index = JSON.parse(idx)
      chats = index.map(meta => {
        const raw = localStorage.getItem(chatKey(meta.id))
        if (raw) return JSON.parse(raw)
        // Orphan index entry — fall back to metadata-only stub
        return { ...meta, messages: [] }
      })
      // Migration: ensure pinned field exists on all chats
      for (const c of chats) { if (c.pinned === undefined) c.pinned = false }
    } else {
      // Legacy: single hermes_chats blob — migrate
      const c = localStorage.getItem('hermes_chats')
      if (c) {
        chats = JSON.parse(c)
        // Write into per-chat layout
        _writeAllChats()
        localStorage.removeItem('hermes_chats')
      }
    }
  } catch (_) {}
}

function saveState() {
  localStorage.setItem('hermes_settings', JSON.stringify(settings))
  _writeAllChats()
}

// Internal: write index + only dirty per-chat keys (or all if needed)
function _writeAllChats() {
  const index = chats.map(c => ({ id: c.id, title: c.title, sessionId: c.sessionId, createdAt: c.createdAt, pinned: !!c.pinned }))
  localStorage.setItem(CHATS_INDEX_KEY, JSON.stringify(index))
  for (const c of chats) {
    localStorage.setItem(chatKey(c.id), JSON.stringify(c))
  }
}

// O(1) save: only the active chat (most common case during streaming / edits)
function saveActiveChat() {
  const chat = getActiveChat()
  if (!chat) return
  // Update index entry
  const raw = localStorage.getItem(CHATS_INDEX_KEY)
  const index = raw ? JSON.parse(raw) : []
  const idx = index.findIndex(i => i.id === chat.id)
  const meta = { id: chat.id, title: chat.title, sessionId: chat.sessionId, createdAt: chat.createdAt, pinned: !!chat.pinned }
  if (idx >= 0) index[idx] = meta; else index.unshift(meta)
  localStorage.setItem(CHATS_INDEX_KEY, JSON.stringify(index))
  // Write chat data
  localStorage.setItem(chatKey(chat.id), JSON.stringify(chat))
}

// Remove a chat's per-key storage
function removeChatStorage(chatId) {
  localStorage.removeItem(chatKey(chatId))
  const raw = localStorage.getItem(CHATS_INDEX_KEY)
  if (raw) {
    const index = JSON.parse(raw).filter(i => i.id !== chatId)
    localStorage.setItem(CHATS_INDEX_KEY, JSON.stringify(index))
  }
}

// ─── Chat management ─────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function newChat() {
  const chat = { id: generateId(), title: 'New chat', messages: [], sessionId: null, createdAt: Date.now(), pinned: false }
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
    cancelCurrentStream()
    isStreaming = false
    setSendEnabled(true)
  }
  activeChatId = id
  syncPerChatModel(getActiveChat())
  renderMessages()
  updateTopbar()
  renderSidebar()
  updateContextPill()
}

function togglePin(id) {
  const chat = chats.find(c => c.id === id)
  if (!chat) return
  chat.pinned = !chat.pinned
  saveActiveChat()
  renderSidebar()
}

function deleteChat(id) {
  chats = chats.filter(c => c.id !== id)
  removeChatStorage(id)
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

// ─── Search filter ───────────────────────────────────────────────────────────

const searchInput = document.getElementById('chat-search')
let searchQuery = ''

if (searchInput) {
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase()
    renderSidebar()
  })
}

// ─── Smart auto-scroll ───────────────────────────────────────────────────────

const isNearBottom = (tolerance = 80) => {
  return msgContainer.scrollTop + msgContainer.clientHeight >= msgContainer.scrollHeight - tolerance
}

let scrollBtnVisible = false
const scrollToBottomBtn = document.getElementById('scroll-to-bottom')

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    msgContainer.scrollTop = msgContainer.scrollHeight
    hideScrollButton()
  }
}

function showScrollButton() {
  if (scrollToBottomBtn && !scrollBtnVisible) {
    scrollBtnVisible = true
    scrollToBottomBtn.classList.add('visible')
  }
}

function hideScrollButton() {
  if (scrollToBottomBtn && scrollBtnVisible) {
    scrollBtnVisible = false
    scrollToBottomBtn.classList.remove('visible')
  }
}

if (scrollToBottomBtn) {
  scrollToBottomBtn.addEventListener('click', () => {
    msgContainer.scrollTop = msgContainer.scrollHeight
    hideScrollButton()
  })
}

// Track scroll position during streaming
let userScrolledUp = false
msgContainer.addEventListener('scroll', () => {
  if (isStreaming) {
    userScrolledUp = !isNearBottom()
    if (userScrolledUp) {
      showScrollButton()
    } else {
      hideScrollButton()
    }
  }
})

// ─── Render helpers ───────────────────────────────────────────────────────

const chatList       = document.getElementById('chat-list')
const msgContainer   = document.getElementById('messages')
const welcome        = document.getElementById('welcome')
const topbarTitle    = document.getElementById('topbar-title')
const topbarTitleInput = document.getElementById('topbar-title-input')
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
    text.textContent = formatTokens(contextUsed)
    fill.style.width = '0%'
    fill.className = ''
  }
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  return String(n)
}

// Format message timestamp — compact: "14:32" today, "Yesterday 14:32", "Apr 24 14:32"
function formatMsgTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return time
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
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

// Migrate chats missing createdAt (assigned in insertion order)
function migrateTimestamps() {
  // Most recent first — assign timestamps backfilling from now
  let migrated = false
  const now = Date.now()
  for (let i = 0; i < chats.length; i++) {
    if (!chats[i].createdAt) {
      // 1-hour intervals going back, newest = now, oldest = now - (n-1)h
      chats[i].createdAt = now - (i * 3600000)
      migrated = true
    }
  }
  if (migrated) saveState()
}

function groupChatsByTime(chats) {
  const pinned = chats.filter(c => c.pinned)
  const unpinned = chats.filter(c => !c.pinned)

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const week = new Date(today.getTime() - 7 * 86400000)
  const month = new Date(today.getTime() - 30 * 86400000)

  const groups = [
    { label: 'Pinned', chats: pinned },
    { label: 'Today', chats: [] },
    { label: 'Yesterday', chats: [] },
    { label: 'Previous 7 Days', chats: [] },
    { label: 'Previous 30 Days', chats: [] },
    { label: 'Older', chats: [] },
  ]

  for (const chat of unpinned) {
    const ts = new Date(chat.createdAt)
    if (ts >= today)       groups[1].chats.push(chat)
    else if (ts >= yesterday) groups[2].chats.push(chat)
    else if (ts >= week)   groups[3].chats.push(chat)
    else if (ts >= month)  groups[4].chats.push(chat)
    else                   groups[5].chats.push(chat)
  }

  return groups
}

function renderSidebar() {
  chatList.innerHTML = ''
  const query = searchQuery.toLowerCase()
  const filtered = query ? chats.filter(c => c.title.toLowerCase().includes(query)) : chats

  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'sidebar-empty'
    empty.textContent = query ? 'No matching chats' : 'No chats yet'
    chatList.appendChild(empty)
    return
  }

  const groups = groupChatsByTime(filtered)

  for (const group of groups) {
    if (!group.chats.length) continue

    const header = document.createElement('div')
    header.className = 'chat-section-header'
    header.textContent = group.label
    chatList.appendChild(header)

    for (const chat of group.chats) {
      const item = document.createElement('div')
      item.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '') + (chat.pinned ? ' pinned' : '')
      item.innerHTML = `
        <button class="chat-item-pin" title="${chat.pinned ? 'Unpin' : 'Pin'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${chat.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/>
          </svg>
        </button>
        <span class="chat-item-title">${escapeHtml(chat.title)}</span>
        <button class="chat-item-delete" title="Delete">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>`
      item.querySelector('.chat-item-pin').addEventListener('click', (e) => {
        e.stopPropagation(); togglePin(chat.id)
      })
      item.querySelector('.chat-item-title').addEventListener('click', () => switchChat(chat.id))
      item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
        e.stopPropagation(); deleteChat(chat.id)
      })
      chatList.appendChild(item)
    }
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
  for (const msg of chat.messages) {
    appendMessageBubble(msg.role, msg.content, false, {
      id: msg.id,
      createdAt: msg.createdAt,
      model: msg.model,
    })
  }
  scrollToBottom(true) // force scroll on chat switch
  // Highlight code blocks after rendering
  highlightCodeBlocks(msgContainer)
  // Render math ($...$, $$...$$) in all loaded messages
  renderMath(msgContainer)
}

function appendMessageBubble(role, content, streaming = false, meta = {}) {
  const row = document.createElement('div')
  row.className = `msg-row ${role}`
  const bubble = document.createElement('div')
  bubble.className = 'msg-bubble'
  if (meta.id) bubble.dataset.msgId = meta.id
  if (streaming) bubble.classList.add('typing-cursor')

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(content)
  } else {
    bubble.textContent = content
  }

  row.appendChild(bubble)

  // Timestamp metadata line (shown on hover / always for assistant)
  if (meta.createdAt) {
    const timeEl = document.createElement('div')
    timeEl.className = 'msg-time'
    timeEl.textContent = formatMsgTime(meta.createdAt)
    if (meta.model) timeEl.textContent += ` · ${meta.model}`
    row.appendChild(timeEl)
  }

  msgContainer.appendChild(row)

  // Highlight code blocks in the new bubble
  highlightCodeBlocks(bubble)

  // Smart scroll: only if user is near bottom
  if (streaming) {
    if (!userScrolledUp) {
      scrollToBottom()
    }
  } else {
    scrollToBottom()
  }

  return bubble
}

function updateTopbar() {
  const chat = getActiveChat()
  topbarTitle.textContent = chat ? chat.title : 'Hermes Chat'
  if (chat) { topbarTitle.classList.add('renamable') } else { topbarTitle.classList.remove('renamable') }
}

// ─── Chat rename (click topbar title → inline edit) ──────────────────────────

topbarTitle.addEventListener('click', () => {
  const chat = getActiveChat()
  if (!chat) return
  topbarTitleInput.value = chat.title
  topbarTitle.style.display = 'none'
  topbarTitleInput.style.display = ''
  topbarTitleInput.focus()
  topbarTitleInput.select()
})

function commitRename() {
  const chat = getActiveChat()
  if (!chat) { cancelRename(); return }
  const newName = topbarTitleInput.value.trim().slice(0, 80)
  if (newName && newName !== chat.title) {
    chat.title = newName
    saveActiveChat()
    renderSidebar()
  }
  cancelRename()
}

function cancelRename() {
  topbarTitleInput.style.display = 'none'
  topbarTitle.style.display = ''
  updateTopbar()
}

topbarTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
  if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
})
topbarTitleInput.addEventListener('blur', commitRename)

function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled
}

// ─── Send message (via stream proxy) ─────────────────────────────────────────

let activeStreamCtrl = null  // { close(), eventSource } for current stream

function sendMessage() {
  const text = msgInput.value.trim()
  const hasAttachments = attachedFiles.length > 0
  if (!text && !hasAttachments) return
  if (isStreaming) return

  // Slash command interception
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/)
    const cmd = parts[0].toLowerCase()
    const args = parts.slice(1).join(' ')
    msgInput.value = ''
    autoResize()
    setSendEnabled(false)
    handleSlashCommand(cmd, args)
    return
  }

  let chat = getActiveChat()
  if (!chat) { newChat(); chat = getActiveChat() }

  const fileCount   = attachedFiles.length
  const fileNames   = attachedFiles.map(f => f.name)
  const fullContent = buildMessageWithAttachments(text)
    // Enhanced message model: id, createdAt, model, promptTokens
    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      content: fullContent,
      model: null,
      promptTokens: null,
      createdAt: Date.now(),
    })

  // Clear input + attachments
  msgInput.value = ''
  attachedFiles = []
  renderAttachments()
  autoResize()
  saveActiveChat()

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
  userScrolledUp = false
  setSendEnabled(false)
  resetStreamState()
  let streamDone = false

  let accumulated = ''
  const bubble = appendMessageBubble('assistant', '', true)

  // ── Save inflight snapshot before request (crash recovery) ──────────
  saveInflight(
    chat.id,
    chat.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
    chat.sessionId,
    '',
    realModel || null
  )

  // ── Proxy stream (primary) ──────────────────────────────────────────────
  // Try the local HTTP proxy first; fall back to legacy IPC if proxy is down
  startProxyStream(chat, bubble, accumulated, streamDone)
}

// Throttle inflight saves to every 500ms during streaming (avoid localStorage thrash)
let _inflightThrottleTimer = null

function throttledSaveInflight(chatId, messages, sessionId, accumulated, model) {
  // Always save the latest values into the throttle slot
  _inflightThrottleSlot = { chatId, messages, sessionId, accumulated, model }
  if (_inflightThrottleTimer) return
  _inflightThrottleTimer = setTimeout(() => {
    const s = _inflightThrottleSlot
    if (s) saveInflight(s.chatId, s.messages, s.sessionId, s.accumulated, s.model)
    _inflightThrottleTimer = null
  }, 500)
}
let _inflightThrottleSlot = null

async function startProxyStream(chat, bubble, _accumulated, _streamDone) {
  let streamDone = _streamDone
  let accumulated = _accumulated
  const messageList = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant')

  try {
    const streamId = await window.hermesAPI.startStream(
      messageList,
      settings,
      chat.sessionId,
      chat.id
    )

    const ctrl = window.hermesAPI.connectStream(streamId, {
      onChunk: (content) => {
        accumulated += content
        debouncedStreamRender(bubble, accumulated)
        // Update inflight snapshot (throttled)
        throttledSaveInflight(chat.id, messageList, chat.sessionId, accumulated, realModel || null)
      },
      onModel: (model) => {
        if (model) { realModel = model; syncModelPill(); updateContextPill() }
      },
      onSession: (sid) => {
        if (sid && chat) { chat.sessionId = sid; saveActiveChat() }
      },
      onUsage: (usage) => {
        if (usage && usage.prompt_tokens != null) {
          contextUsed = usage.prompt_tokens
          updateContextPill()
        }
      },
      onDone: () => {
        if (streamDone) return
        streamDone = true
        finishStream(bubble, accumulated, chat)
      },
      onError: (err, payload) => {
        if (streamDone) return
        streamDone = true
        // Session expired → clear sessionId so next request starts fresh
        if (payload && payload.sessionExpired && chat) {
          chat.sessionId = null
          saveActiveChat()
        }
        errorStream(bubble, accumulated, err)
      },
    })

    activeStreamCtrl = ctrl
  } catch (err) {
    // Proxy unavailable or conflict — fall back to legacy IPC
    console.warn('[Hermes] Proxy stream failed, falling back to IPC:', err.message)
    startIPCStream(chat, bubble)
  }
}

function startIPCStream(chat, bubble) {
  let streamDone = false
  let accumulated = ''
  const messageList = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant')

  // Single consolidated listener — replaces old 7 separate IPC listeners
  // No listener accumulation possible: onChatEvent replaces the previous callback
  window.hermesAPI.onChatEvent(({ type, payload }) => {
    switch (type) {
      case 'chunk':
        accumulated += payload.content
        debouncedStreamRender(bubble, accumulated)
        throttledSaveInflight(chat.id, messageList, chat.sessionId, accumulated, realModel || null)
        break
      case 'model':
        if (payload.model) { realModel = payload.model; syncModelPill(); updateContextPill() }
        break
      case 'session':
        if (payload.sessionId && chat) { chat.sessionId = payload.sessionId; saveActiveChat() }
        break
      case 'usage':
        if (payload && payload.prompt_tokens != null) {
          contextUsed = payload.prompt_tokens
          updateContextPill()
        }
        break
      case 'done':
        if (streamDone) return
        streamDone = true
        finishStream(bubble, accumulated, chat)
        break
      case 'error':
        if (streamDone) return
        streamDone = true
        // Session expired → clear sessionId so next request starts fresh
        if (payload && payload.sessionExpired && chat) {
          chat.sessionId = null
          saveActiveChat()
        }
        errorStream(bubble, accumulated, payload.message || 'Unknown error')
        break
    }
  })

  window.hermesAPI.sendMessageIPC(
    chat.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
    settings,
    chat.sessionId,
    chat.id
  )
}

function finishStream(bubble, accumulated, chat) {
  // Flush any pending debounced render
  flushStreamRender()
  clearInflight()
  _inflightThrottleSlot = null
  bubble.classList.remove('typing-cursor')
  bubble.innerHTML = renderMarkdown(accumulated)
  highlightCodeBlocks(bubble)
  renderMath(bubble)
  // Enhanced message model: store model + token info on the just-completed assistant message
  chat.messages.push({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: accumulated,
    model: realModel || null,
    promptTokens: contextUsed || null,
    createdAt: Date.now(),
  })
  saveActiveChat()
  isStreaming = false
  userScrolledUp = false
  activeStreamCtrl = null
  setSendEnabled(true)
  updateContextPill()
  msgInput.focus()
  hideScrollButton()
}

function errorStream(bubble, accumulated, err) {
  // Flush any pending debounced render so partial content is visible
  flushStreamRender()
  clearInflight()
  _inflightThrottleSlot = null
  bubble.classList.remove('typing-cursor')

  // If we have partial content, render it + show an error bar with Resend
  if (accumulated && accumulated.trim()) {
    bubble.innerHTML = renderMarkdown(accumulated)
    highlightCodeBlocks(bubble)
    renderMath(bubble)

    // Append an error bar after the bubble
    const row = bubble.closest('.msg-row')
    const errBar = document.createElement('div')
    errBar.className = 'msg-error-bar'
    errBar.innerHTML = `<span class="msg-error-text">⚠ ${escapeHtml(err)}</span><button class="msg-resend-btn">Resend</button>`
    row.appendChild(errBar)
    errBar.querySelector('.msg-resend-btn').addEventListener('click', () => {
      errBar.remove()
      resendLastUserMessage()
    })
  } else {
    bubble.innerHTML = `<span style="color:#e88">⚠ ${escapeHtml(err)}</span>`
  }

  showError(err)
  isStreaming = false
  userScrolledUp = false
  activeStreamCtrl = null
  setSendEnabled(true)
  hideScrollButton()
}

// Resend the last user message (after an error with partial content)
function resendLastUserMessage() {
  const chat = getActiveChat()
  if (!chat) return
  // Find last user message
  const lastUserIdx = chat.messages.findLastIndex(m => m.role === 'user')
  if (lastUserIdx < 0) return

  // Remove any partial assistant messages after the last user message
  chat.messages = chat.messages.slice(0, lastUserIdx + 1)
  saveActiveChat()
  renderMessages()

  // Re-send using the existing message list
  const text = chat.messages[lastUserIdx].content
  if (isStreaming) return

  isStreaming = true
  userScrolledUp = false
  setSendEnabled(false)
  resetStreamState()
  let streamDone = false
  let accumulated = ''
  const bubble = appendMessageBubble('assistant', '', true)

  const messageList = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant')
  saveInflight(chat.id, messageList, chat.sessionId, '', realModel || null)

  startProxyStream(chat, bubble, accumulated, streamDone)
}

// Cancel current stream (called when switching chats or on explicit cancel)
function cancelCurrentStream() {
  flushStreamRender()
  clearInflight()
  _inflightThrottleSlot = null
  if (activeStreamCtrl) {
    activeStreamCtrl.close()
    activeStreamCtrl = null
  }
  window.hermesAPI.cancelStreamIPC()
}

// ─── Input auto-resize ────────────────────────────────────────────────────────

function autoResize() {
  msgInput.style.height = 'auto'
  msgInput.style.height = Math.min(msgInput.scrollHeight, 200) + 'px'
}

msgInput.addEventListener('input', () => {
  autoResize()
  setSendEnabled((msgInput.value.trim().length > 0 || attachedFiles.length > 0) && !isStreaming)
  updateCommandMenu()
})

// ─── Send key preference ─────────────────────────────────────────────────────

msgInput.addEventListener('keydown', (e) => {
  // Command menu navigation
  if (commandMenuOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); navigateCommandMenu(1); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); navigateCommandMenu(-1); return }
    if (e.key === 'Enter')     { e.preventDefault(); selectCommandMenuItem(); return }
    if (e.key === 'Escape')    { e.preventDefault(); hideCommandMenu(); return }
    if (e.key === 'Tab')       { e.preventDefault(); selectCommandMenuItem(); return }
  }

  if (settings.sendKey === 'ctrl-enter') {
    // Ctrl+Enter sends, plain Enter inserts newline
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      if (!sendBtn.disabled) sendMessage()
    }
  } else {
    // Default: Enter sends, Shift+Enter inserts newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!sendBtn.disabled) sendMessage()
    }
  }
})

sendBtn.addEventListener('click', sendMessage)

document.getElementById('new-chat-btn').addEventListener('click', () => {
  newChat(); msgInput.focus()
})

// Model pill → open settings
document.getElementById('model-pill').addEventListener('click', openSettings)

// ─── Slash commands ──────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/clear',  desc: 'Clear messages in current chat' },
  { cmd: '/export', desc: 'Export current chat as Markdown' },
  { cmd: '/help',   desc: 'Show available commands' },
]

let commandMenuOpen = false
let commandMenuIdx = -1
const commandMenu = document.getElementById('command-menu')

function handleSlashCommand(cmd, _args) {
  const chat = getActiveChat()
  switch (cmd) {
    case '/clear':
      if (!chat) { showError('No active chat to clear'); return }
      chat.messages = []
      saveActiveChat()
      renderMessages()
      break
    case '/export':
      if (!chat) { showError('No active chat to export'); return }
      exportChatAsMarkdown(chat)
      break
    case '/help':
      const lines = SLASH_COMMANDS.map(c => `**${c.cmd}** — ${c.desc}`).join('\n')
      // Show as a system message in the current chat
      if (!chat) { newChat() }
      const active = getActiveChat()
      active.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: lines,
        model: 'system',
        promptTokens: null,
        createdAt: Date.now(),
      })
      saveActiveChat()
      renderMessages()
      scrollToBottom(true)
      break
    default:
      showError(`Unknown command: ${cmd}. Type /help for commands.`)
  }
}

function exportChatAsMarkdown(chat) {
  const lines = [`# ${chat.title}`, '']
  for (const m of chat.messages) {
    const ts = m.createdAt ? new Date(m.createdAt).toLocaleString() : ''
    const label = m.role === 'user' ? '**You**' : m.role === 'assistant' ? '**Assistant**' : `**${m.role}**`
    lines.push(`### ${label}${ts ? ' — ' + ts : ''}`)
    lines.push('')
    lines.push(m.content || '(empty)')
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = (chat.title || 'chat').replace(/[^a-z0-9]/gi, '_') + '.md'
  a.click()
  URL.revokeObjectURL(url)
}

function updateCommandMenu() {
  const val = msgInput.value
  if (!val.startsWith('/')) { hideCommandMenu(); return }
  const partial = val.toLowerCase().split(/\s/)[0]
  const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(partial))
  if (!matches.length || (matches.length === 1 && matches[0].cmd === partial)) {
    hideCommandMenu()
    return
  }
  commandMenuIdx = -1
  commandMenu.innerHTML = matches.map(c =>
    `<div class="cmd-item" data-cmd="${c.cmd}"><span class="cmd-name">${c.cmd}</span><span class="cmd-desc">${c.desc}</span></div>`
  ).join('')
  commandMenu.querySelectorAll('.cmd-item').forEach(el => {
    el.addEventListener('click', () => {
      msgInput.value = el.dataset.cmd + ' '
      hideCommandMenu()
      msgInput.focus()
      autoResize()
      setSendEnabled(true)
    })
  })
  commandMenu.style.display = 'block'
  commandMenuOpen = true
}

function navigateCommandMenu(dir) {
  const items = commandMenu.querySelectorAll('.cmd-item')
  if (!items.length) return
  if (commandMenuIdx >= 0) items[commandMenuIdx].classList.remove('selected')
  commandMenuIdx = (commandMenuIdx + dir + items.length) % items.length
  items[commandMenuIdx].classList.add('selected')
  items[commandMenuIdx].scrollIntoView({ block: 'nearest' })
}

function selectCommandMenuItem() {
  const items = commandMenu.querySelectorAll('.cmd-item')
  if (commandMenuIdx < 0 && items.length === 1) commandMenuIdx = 0
  if (commandMenuIdx < 0) return
  const cmd = items[commandMenuIdx].dataset.cmd
  msgInput.value = cmd + ' '
  hideCommandMenu()
  msgInput.focus()
  autoResize()
  setSendEnabled(true)
}

function hideCommandMenu() {
  commandMenu.style.display = 'none'
  commandMenuOpen = false
  commandMenuIdx = -1
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (!mod) return

  // Skip if focus is inside textarea/input (don't steal native shortcuts mid-type)
  const active = document.activeElement
  const isTyping = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')
  // Only skip for shortcuts that collide with text editing
  const textSafeKeys = ['n', 'e']  // Cmd+N, Cmd+E could conflict; others safe
  const key = e.key.toLowerCase()

  if (isTyping && textSafeKeys.includes(key)) return

  switch (true) {
    // Cmd+N → New chat
    case key === 'n' && !e.shiftKey:
      e.preventDefault(); newChat(); msgInput.focus(); break
    // Cmd+, → Settings
    case key === ',':
      e.preventDefault(); openSettings(); break
    // Cmd+K → Focus search
    case key === 'k' && !e.shiftKey:
      e.preventDefault(); if (searchInput) searchInput.focus(); break
    // Cmd+Shift+P → Toggle pin on active chat
    case key === 'p' && e.shiftKey:
      e.preventDefault(); if (activeChatId) togglePin(activeChatId); break
    // Cmd+Shift+C → Clear active chat
    case key === 'c' && e.shiftKey:
      e.preventDefault(); handleSlashCommand('/clear', ''); break
    // Cmd+E → Export active chat
    case key === 'e':
      e.preventDefault(); handleSlashCommand('/export', ''); break
  }
})

// Escape → close settings overlay (when open) or command menu
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (settingsOverlay.classList.contains('open')) { closeSettings(); return }
    if (commandMenuOpen) { hideCommandMenu(); return }
  }
})

// ─── File attachment ──────────────────────────────────────────────────────────

// attachedFiles: [{ name, content }]  — content is plain text (or a note for binary)
let attachedFiles = []

const fileInput  = document.getElementById('file-input')
const attachBtn  = document.getElementById('attach-btn')

attachBtn.addEventListener('click', () => fileInput.click())

// Shared file processing (used by both file picker and drag-and-drop)
function processFiles(files) {
  if (!files.length) return

  Array.from(files).forEach(file => {
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
}

fileInput.addEventListener('change', () => {
  processFiles(fileInput.files || [])
  // Reset so same file can be re-attached after removal
  fileInput.value = ''
})

// ─── Drag-and-drop ────────────────────────────────────────────────────────────

const inputWrapper = document.getElementById('input-wrapper')

inputWrapper.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.stopPropagation()
  inputWrapper.classList.add('drag-over')
})

inputWrapper.addEventListener('dragleave', (e) => {
  e.preventDefault()
  e.stopPropagation()
  // Only remove class if leaving the wrapper entirely (not entering a child)
  if (!inputWrapper.contains(e.relatedTarget)) {
    inputWrapper.classList.remove('drag-over')
  }
})

inputWrapper.addEventListener('drop', (e) => {
  e.preventDefault()
  e.stopPropagation()
  inputWrapper.classList.remove('drag-over')
  if (e.dataTransfer.files.length) {
    processFiles(e.dataTransfer.files)
    msgInput.focus()
  }
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
const sSendKey  = document.getElementById('s-sendkey')
const connDot   = document.getElementById('conn-dot')
const connLabel = document.getElementById('conn-label')
const topbarDot = document.getElementById('topbar-dot')

document.getElementById('settings-btn').addEventListener('click', openSettings)
document.getElementById('cancel-settings-btn').addEventListener('click', closeSettings)
document.getElementById('save-settings-btn').addEventListener('click', saveSettings)
document.getElementById('test-connection-btn').addEventListener('click', testConnection)
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings() })

// ─── Settings tabs ──────────────────────────────────────────────────────────

document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'))
    tab.classList.add('active')
    const target = tab.getAttribute('data-tab')
    document.getElementById(`settings-tab-${target}`).classList.add('active')
  })
})

// ─── Cron Dashboard ─────────────────────────────────────────────────────────

async function loadCronDashboard() {
  const banner = document.getElementById('cron-status-banner')
  const list = document.getElementById('cron-jobs-list')

  banner.textContent = 'Loading…'
  banner.className = ''
  list.innerHTML = ''

  const [statusRes, jobsRes] = await Promise.all([
    window.hermesAPI.cronStatus(),
    window.hermesAPI.cronList()
  ])

  // Status banner
  if (!statusRes.ok) {
    banner.textContent = '⚠ Could not reach Hermes: ' + statusRes.error
    banner.className = 'error'
  } else {
    const txt = statusRes.data || ''
    if (txt.includes('running')) {
      banner.className = 'running'
      banner.textContent = txt.trim()
    } else {
      banner.className = 'stopped'
      banner.textContent = txt.trim() || 'Gateway not running'
    }
  }

  // Job cards
  if (!jobsRes.ok) {
    list.innerHTML = `<div style="color:#c62828;font-size:13px;">Error: ${jobsRes.error}</div>`
    return
  }
  const jobs = jobsRes.data || []
  if (!jobs.length) {
    list.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:20px 0;">No scheduled jobs</div>'
    return
  }
  // Build cards with DOM nodes so event listeners work under CSP (no inline onclick)
  list.innerHTML = ''
  jobs.forEach(job => {
    const card = renderCronCard(job)
    list.appendChild(card)
  })
}

function renderCronCard(job) {
  const statusClass = job.status === 'active' ? 'active' : 'paused'
  const lastRunHtml = job.lastRun
    ? `<span class="${job.lastStatus === 'ok' ? 'cron-last-ok' : job.lastStatus === 'error' ? 'cron-last-error' : ''}">${escapeHtml(job.lastRun)} ${escapeHtml(job.lastStatus || '')}</span>`
    : '<span>Never</span>'

  const card = document.createElement('div')
  card.className = 'cron-card'
  card.innerHTML = `
    <div class="cron-card-header">
      <span class="cron-card-name">${escapeHtml(job.name || job.id)}</span>
      <span class="cron-card-status ${statusClass}">${escapeHtml(job.status)}</span>
    </div>
    <div class="cron-card-details">
      <dt>Schedule</dt><dd><code>${escapeHtml(job.schedule || '—')}</code></dd>
      <dt>Next run</dt><dd>${escapeHtml(job.nextRun || '—')}</dd>
      <dt>Last run</dt><dd>${lastRunHtml}</dd>
      ${job.skills ? `<dt>Skills</dt><dd>${escapeHtml(job.skills)}</dd>` : ''}
      ${job.repeat ? `<dt>Repeat</dt><dd>${escapeHtml(job.repeat)}</dd>` : ''}
      ${job.deliver ? `<dt>Deliver</dt><dd>${escapeHtml(job.deliver)}</dd>` : ''}
    </div>
    <div class="cron-card-actions">
      <button class="btn btn-secondary js-cron-toggle">${job.status === 'active' ? '⏸ Pause' : '▶ Resume'}</button>
      <button class="btn btn-secondary js-cron-remove" style="color:#c62828;">✕ Remove</button>
    </div>`

  // Attach listeners after innerHTML (safe — no inline handlers)
  card.querySelector('.js-cron-toggle').addEventListener('click', () => toggleCron(job.id, job.status !== 'active'))
  card.querySelector('.js-cron-remove').addEventListener('click', () => removeCron(job.id))

  return card
}

async function toggleCron(jobId, enable) {
  const res = enable ? await window.hermesAPI.cronResume(jobId) : await window.hermesAPI.cronPause(jobId)
  if (!res.ok) { alert('Error: ' + res.error); return }
  loadCronDashboard()
}

async function removeCron(jobId) {
  if (!confirm('Remove this cron job?')) return
  const res = await window.hermesAPI.cronRemove(jobId)
  if (!res.ok) { alert('Error: ' + res.error); return }
  loadCronDashboard()
}

document.getElementById('cron-refresh-btn').addEventListener('click', loadCronDashboard)

// ─── Skills Navigator ────────────────────────────────────────────────────────

let allSkills = []
let activeSkillCategory = 'all'

async function loadSkillsList() {
  const container = document.getElementById('skills-list')
  const chipsContainer = document.getElementById('skills-category-chips')
  container.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:20px 0;">Loading…</div>'

  const res = await window.hermesAPI.skillsList()
  if (!res.ok) {
    container.innerHTML = `<div style="color:#c62828;font-size:13px;">Error: ${res.error}</div>`
    return
  }
  allSkills = res.data || []
  activeSkillCategory = 'all'

  // Build category chips
  const categories = [...new Set(allSkills.map(s => s.category || 'uncategorized').filter(Boolean))].sort()
  const counts = {}
  allSkills.forEach(s => { const c = s.category || 'uncategorized'; counts[c] = (counts[c] || 0) + 1 })

  chipsContainer.innerHTML = [
    `<span class="skill-chip active" data-cat="all">All (${allSkills.length})</span>`,
    ...categories.map(c => `<span class="skill-chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${counts[c]})</span>`)
  ].join('')

  chipsContainer.querySelectorAll('.skill-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeSkillCategory = chip.getAttribute('data-cat')
      chipsContainer.querySelectorAll('.skill-chip').forEach(c => c.classList.remove('active'))
      chip.classList.add('active')
      renderSkillsList()
    })
  })

  renderSkillsList()
}

function renderSkillsList() {
  const container = document.getElementById('skills-list')
  const query = (document.getElementById('skills-search')?.value || '').toLowerCase()
  let skills = allSkills

  if (activeSkillCategory !== 'all') {
    skills = skills.filter(s => (s.category || 'uncategorized') === activeSkillCategory)
  }
  if (query) {
    skills = skills.filter(s => s.name.toLowerCase().includes(query) || (s.category || '').toLowerCase().includes(query))
  }

  // Group by category
  const groups = {}
  skills.forEach(s => {
    const cat = s.category || 'uncategorized'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(s)
  })

  const sortedCats = Object.keys(groups).sort()
  let html = ''
  for (const cat of sortedCats) {
    html += `<div class="skill-category-header">${escapeHtml(cat)}</div>`
    for (const s of groups[cat]) {
      const src = (s.source || 'unknown').toLowerCase()
      html += `<div class="skill-row">
        <span class="skill-name">${escapeHtml(s.name)}</span>
        <span class="skill-source ${src}">${escapeHtml(s.source || '?')}</span>
      </div>`
    }
  }
  container.innerHTML = html || '<div style="color:var(--text-secondary);font-size:13px;text-align:center;padding:20px 0;">No matching skills</div>'
}

document.getElementById('skills-search').addEventListener('input', renderSkillsList)
document.getElementById('skills-refresh-btn').addEventListener('click', loadSkillsList)

function openSettings() {
  sEndpoint.value = settings.endpoint
  sApiKey.value   = settings.apiKey
  sModel.value    = settings.model
  if (sSendKey) sSendKey.value = settings.sendKey || 'enter'
  setConnStatus('grey', 'Not tested')
  settingsOverlay.classList.add('open')
  // Lazy-load data for whichever tab is currently active
  const activeTab = document.querySelector('.settings-tab.active')?.getAttribute('data-tab')
  if (activeTab === 'cron') loadCronDashboard()
  if (activeTab === 'skills') loadSkillsList()
}

function closeSettings() { settingsOverlay.classList.remove('open') }

function saveSettings() {
  settings.endpoint = sEndpoint.value.trim() || DEFAULT_SETTINGS.endpoint
  settings.apiKey   = sApiKey.value.trim()   || DEFAULT_SETTINGS.apiKey
  settings.model    = sModel.value.trim()    || DEFAULT_SETTINGS.model
  if (sSendKey) settings.sendKey = sSendKey.value
  saveState()
  syncModelPill()
  closeSettings()
  // Re-fetch model info + re-check connection when settings change
  fetchModelInfo()
  checkTopbarConnection()
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
      localStorage.setItem('hermes_settings', JSON.stringify(settings))
    }
    if (info && info.contextWindow) {
      contextWindow = info.contextWindow
    }
    updateContextPill()
  } catch (_) {
    // Silently fail — keep whatever model is in settings
  }
}

// ─── Topbar connection dot ──────────────────────────────────────────────────
// Lightweight health check: pings the Hermes /health endpoint and updates the
// small status dot in the topbar. Also sets isConnected for other code to query.

function updateTopbarDot(color) {
  if (topbarDot) topbarDot.className = `status-dot ${color}`
}

async function checkTopbarConnection() {
  updateTopbarDot('grey')
  const endpoint = settings.endpoint || DEFAULT_SETTINGS.endpoint
  try {
    const healthUrl = endpoint.replace(/\/v1\/chat\/completions$/, '/health')
    const res = await fetch(healthUrl, { method: 'GET', signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      updateTopbarDot('green')
      updateConnectionStatus(true)
    } else {
      updateTopbarDot('red')
      updateConnectionStatus(false)
    }
  } catch (_) {
    updateTopbarDot('red')
    updateConnectionStatus(false)
  }
}

// Offline detection: disable input + show "No connection" banner
function updateConnectionStatus(online) {
  const wasConnected = isConnected
  isConnected = online
  const banner = document.getElementById('offline-banner')
  if (online) {
    banner.style.display = 'none'
    setSendEnabled(msgInput.value.trim().length > 0 && !isStreaming)
  } else {
    banner.style.display = 'flex'
    setSendEnabled(false)
  }
  // Auto-reconnect check every 15s when offline
  if (!online && !wasConnected) {
    setTimeout(() => { if (!isConnected) checkTopbarConnection() }, 15000)
  }
}

// ─── Per-chat model memory ───────────────────────────────────────────────────
// When switching chats, look at the last assistant message's `model` field to
// restore the model pill (each chat may have been answered by a different model).

function syncPerChatModel(chat) {
  if (!chat) { syncModelPill(); return }
  // Walk backwards to find the last assistant message with a model field
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i]
    if (m.role === 'assistant' && m.model) {
      realModel = m.model
      syncModelPill()
      return
    }
  }
  // No per-chat model found — keep current realModel
  syncModelPill()
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

loadState()
migrateTimestamps()
recoverInflight()  // Restore partial conversation if app crashed mid-stream
syncModelPill()
fetchModelInfo()
renderSidebar()
renderMessages()
updateTopbar()
updateContextPill()
checkTopbarConnection()
setTimeout(() => msgInput.focus(), 100)

// Flush inflight state before page unload (handles clean Electron close mid-stream)
window.addEventListener('beforeunload', () => {
  if (isStreaming && _inflightThrottleSlot) {
    // Force-flush the throttled inflight save
    const s = _inflightThrottleSlot
    if (s) saveInflight(s.chatId, s.messages, s.sessionId, s.accumulated, s.model)
  }
})

// ─── Global error boundaries ─────────────────────────────────────────────────
// Catch unhandled promise rejections so they show as error toasts instead of
// silently disappearing in the devtools console.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Hermes Chat] Unhandled promise rejection:', event.reason)
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason)
  showError(msg)
})

// ─── Settings tab lazy-loading ───────────────────────────────────────────────
// Tab-click listener: load data when switching tabs while settings are open
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.getAttribute('data-tab')
    if (target === 'cron') setTimeout(loadCronDashboard, 50)
    if (target === 'skills') setTimeout(loadSkillsList, 50)
  })
})