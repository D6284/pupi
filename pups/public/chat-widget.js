(function () {
  if (window.PlushChatWidgetInitialized) return;
  window.PlushChatWidgetInitialized = true;

  const BUSINESS_ID = 'biz_001';

  if (!window.io) {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = initWidget;
    s.onerror = initWidget;
    document.head.appendChild(s);
  } else {
    initWidget();
  }

  function initWidget() {
    let socket = null;
    if (window.io) {
      try { socket = window.io(); } catch (e) { }
    }

    let conversationId = localStorage.getItem('plush_chat_conversation_id');
    let sessionToken = localStorage.getItem('plush_chat_session_token');
    let customerName = localStorage.getItem('plush_chat_customer_name') || 'Guest Visitor';
    let isWidgetOpen = false;
    let currentMode = 'ai';

    // ── Root HTML ──────────────────────────────────────────────────────────
    const root = document.createElement('div');
    root.id = 'plush-chat-root';
    root.innerHTML = `
      <a href="https://wa.me/19793466792?text=Hello%20Plush%20Pups%20by%20Reed" class="plush-whatsapp-launcher" id="plush-whatsapp-launcher" title="Chat on WhatsApp" target="_blank" rel="noopener noreferrer" aria-label="Chat on WhatsApp">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.06 0C5.44 0 .03 5.39.03 12.02c0 2.13.56 4.2 1.63 6.02L0 24l6.13-1.6a11.98 11.98 0 0 0 5.93 1.78h.01c6.61 0 11.99-5.39 11.99-12.02 0-3.2-1.25-6.21-3.54-8.68Zm-8.46 18.46h-.01a9.97 9.97 0 0 1-5.08-1.39l-.36-.22-3.64.95 1-3.54-.24-.37A9.95 9.95 0 0 1 2.02 12c0-5.52 4.49-10 10.04-10a10 10 0 0 1 7.12 3.05 10.02 10.02 0 0 1 2.94 7.03c0 5.52-4.49 10-10.04 10Zm5.52-7.52c-.3-.15-1.78-.88-2.06-.98-.27-.1-.47-.15-.67.15-.2.3-.77.98-.95 1.18-.17.2-.35.22-.65.08-.3-.15-1.28-.47-2.44-1.5-.9-.8-1.51-1.8-1.68-2.1-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.5h-.57c-.2 0-.52.07-.8.38-.28.3-1.08 1.06-1.08 2.58 0 1.52 1.11 2.99 1.26 3.19.15.2 2.18 3.33 5.28 4.67.74.32 1.32.51 1.77.66.75.24 1.43.21 1.97.13.6-.09 1.78-.72 2.03-1.42.25-.7.25-1.3.17-1.43-.08-.12-.28-.2-.58-.35Z"/></svg>
      </a>

      <button class="plush-chat-launcher" id="plush-launcher" title="Live Chat with Plush Pups">
        <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
      </button>

      <div class="plush-chat-card" id="plush-card">
        <div class="plush-chat-header">
          <div class="plush-header-info">
            <div class="plush-avatar" id="plush-avatar">🐾</div>
            <div>
              <h4 class="plush-header-title" id="plush-header-title">Plush Pups Concierge</h4>
              <div class="plush-header-subtitle">
                <span class="plush-status-dot"></span>
                <span id="plush-status-text">AI Concierge Active</span>
              </div>
            </div>
          </div>
          <button class="plush-close-btn" id="plush-close-btn" title="Close Chat">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="plush-messages-box" id="plush-messages">
          <div class="plush-quick-prompts" id="plush-quick-prompts">
            <button class="plush-prompt-btn" data-text="What Cavapoo puppies are available?">🐶 Cavapoo Puppies</button>
            <button class="plush-prompt-btn" data-text="What Toy Maltipoo puppies do you have?">🐾 Toy Maltipoos</button>
            <button class="plush-prompt-btn" data-text="How does shipping and delivery work?">🚚 Shipping Info</button>
            <button class="plush-prompt-btn" data-text="Tell me about your 2-Year Health Guarantee">🛡️ Health Guarantee</button>
            <button class="plush-prompt-btn" data-text="I want to speak with a human agent">💬 Speak with Owner</button>
          </div>
        </div>

        <div class="plush-chat-footer">
          <input type="text" class="plush-chat-input" id="plush-input" placeholder="Ask about puppies, shipping, pricing..." />
          <button class="plush-send-btn" id="plush-send-btn">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // ── Puppy card CSS (injected inline so it works on any page) ──────────
    const style = document.createElement('style');
    style.textContent = `
      .plush-puppy-card {
        display: flex;
        flex-direction: column;
        background: #fff;
        border: 1px solid #f0e0c8;
        border-radius: 12px;
        overflow: hidden;
        margin: 6px 0;
        max-width: 220px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.10);
        font-family: inherit;
      }
      .plush-puppy-card img {
        width: 100%;
        height: 150px;
        object-fit: cover;
        display: block;
      }
      .plush-puppy-card .pcard-body {
        padding: 8px 10px 10px;
      }
      .plush-puppy-card .pcard-name {
        font-weight: 700;
        font-size: 14px;
        color: #92400e;
        margin: 0 0 2px;
      }
      .plush-puppy-card .pcard-breed {
        font-size: 12px;
        color: #78716c;
        margin: 0 0 4px;
      }
      .plush-puppy-card .pcard-price {
        font-size: 15px;
        font-weight: 700;
        color: #d97706;
        margin: 0 0 8px;
      }
      .plush-puppy-card .pcard-btn {
        display: block;
        width: 100%;
        text-align: center;
        background: #d97706;
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 7px 0;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
      }
      .plush-puppy-card .pcard-btn:hover { background: #b45309; }
      .plush-cards-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 4px 0;
      }
    `;
    document.head.appendChild(style);

    const launcher = document.getElementById('plush-launcher');
    const card = document.getElementById('plush-card');
    const closeBtn = document.getElementById('plush-close-btn');
    const messagesBox = document.getElementById('plush-messages');
    const input = document.getElementById('plush-input');
    const sendBtn = document.getElementById('plush-send-btn');
    const statusText = document.getElementById('plush-status-text');
    const avatar = document.getElementById('plush-avatar');

    // ── Puppy data cache (fetched once from public config) ─────────────────
    let puppiesCache = [];
    fetch('/api/public/config?businessId=' + BUSINESS_ID)
      .then(r => r.json()).catch(() => ({}));
    // Fetch puppies via admin endpoint not available publicly,
    // so we embed the card data at render-time via /api/public/config puppies extension.
    // We'll pull puppies from a dedicated lightweight endpoint added below.

    fetch('/api/public/puppies')
      .then(r => r.json())
      .then(data => { puppiesCache = data || []; })
      .catch(() => { });

    // ── Toggle widget ──────────────────────────────────────────────────────
    launcher.addEventListener('click', () => {
      isWidgetOpen = !isWidgetOpen;
      card.classList.toggle('plush-open', isWidgetOpen);
      if (isWidgetOpen) { input.focus(); scrollToBottom(); }
    });
    closeBtn.addEventListener('click', () => {
      isWidgetOpen = false;
      card.classList.remove('plush-open');
    });

    // ── Quick prompts ──────────────────────────────────────────────────────
    document.querySelectorAll('.plush-prompt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-text');
        if (text) sendMessage(text);
      });
    });

    // ── Send handlers ──────────────────────────────────────────────────────
    sendBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (text) { sendMessage(text); input.value = ''; }
    });
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const text = input.value.trim();
        if (text) { sendMessage(text); input.value = ''; }
      }
    });

    // ── Init / restore session ────────────────────────────────────────────
    fetch('/api/public/chat/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, sessionToken, name: customerName, businessId: BUSINESS_ID })
    })
      .then(r => r.json())
      .then(data => {
        if (data.conversation) {
          conversationId = data.conversation.id || data.conversation.conversation_id;
          sessionToken = data.sessionToken || data.conversation.session_token;
          currentMode = data.conversation.mode;
          localStorage.setItem('plush_chat_conversation_id', conversationId);
          localStorage.setItem('plush_chat_session_token', sessionToken);
          updateHeaderStatus(currentMode);
          connectIsolatedSocket();
        }
        if (data.messages && data.messages.length > 0) renderMessages(data.messages);
      })
      .catch(err => console.error('Error initializing chat:', err));

    // ── Socket ─────────────────────────────────────────────────────────────
    function connectIsolatedSocket() {
      if (!socket || !conversationId || !sessionToken) return;
      socket.emit('join:customer_conversation', { conversationId, sessionToken, businessId: BUSINESS_ID });
      socket.on('chat:message', (msg) => {
        if ((msg.conversation_id || msg.session_id) === conversationId) appendMessage(msg);
      });
      socket.on('chat:session_updated', (session) => {
        if ((session.id || session.conversation_id) === conversationId) {
          currentMode = session.mode;
          updateHeaderStatus(currentMode);
        }
      });
    }

    function updateHeaderStatus(mode) {
      if (mode === 'human') {
        statusText.innerText = 'Owner Connected (Live)';
        avatar.innerText = '👤';
      } else {
        statusText.innerText = 'AI Concierge Active';
        avatar.innerText = '🐾';
      }
    }

    // ── Send message ───────────────────────────────────────────────────────
    function sendMessage(text) {
      if (!conversationId || !sessionToken) return;
      appendMessage({
        id: 'temp_' + Date.now(),
        conversation_id: conversationId,
        sender: 'customer',
        sender_name: customerName,
        text,
        timestamp: new Date().toISOString()
      });
      fetch('/api/public/chat/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': sessionToken,
          'X-Conversation-Id': conversationId,
          'X-Business-Id': BUSINESS_ID
        },
        body: JSON.stringify({ conversationId, sessionToken, text, senderName: customerName, businessId: BUSINESS_ID })
      })
        .then(r => {
          if (r.status === 403) {
            localStorage.removeItem('plush_chat_conversation_id');
            localStorage.removeItem('plush_chat_session_token');
            location.reload();
            return null;
          }
          return r.json();
        })
        .then(data => {
          if (data && data.conversation) {
            currentMode = data.conversation.mode;
            updateHeaderStatus(currentMode);
          }
        })
        .catch(err => console.error('Error sending message:', err));
    }

    // ── Render messages ────────────────────────────────────────────────────
    function renderMessages(messages) {
      const prompts = document.getElementById('plush-quick-prompts');
      messagesBox.innerHTML = '';
      if (prompts) messagesBox.appendChild(prompts);
      messages.forEach(m => appendMessage(m, false));
      scrollToBottom();
    }

    function appendMessage(msg, scroll = true) {
      if (document.getElementById('msg-' + msg.id)) return;

      const row = document.createElement('div');
      row.id = 'msg-' + msg.id;
      row.className = `plush-msg-row ${msg.sender}`;

      const timeStr = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

      // Parse message text: expand [CARD:pupid] and [CARD:all] tokens
      const parsedContent = parseMessageContent(msg.text || '');

      row.innerHTML = `
        <div class="plush-msg-sender">${escapeHtml(msg.sender_name || msg.sender)}</div>
        <div class="plush-bubble">${parsedContent}</div>
        <div class="plush-msg-time">${timeStr}</div>
      `;

      messagesBox.appendChild(row);
      if (scroll) scrollToBottom();
    }

    /**
     * Parse message text and expand [CARD:pupid] tokens into rich HTML puppy cards.
     * Plain text is safely escaped; only card tokens produce raw HTML.
     */
    function parseMessageContent(text) {
      // Split on card tokens
      const cardTokenRegex = /\[CARD:([\w_]+)\]/g;
      const parts = [];
      let lastIndex = 0;
      let match;

      while ((match = cardTokenRegex.exec(text)) !== null) {
        // Text before this card
        if (match.index > lastIndex) {
          parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
        }
        parts.push({ type: 'card', id: match[1] });
        lastIndex = cardTokenRegex.lastIndex;
      }
      // Remaining text
      if (lastIndex < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIndex) });
      }

      // Collect card ids to render as a row
      const cardIds = parts.filter(p => p.type === 'card').map(p => p.id);
      const hasCards = cardIds.length > 0;

      let html = '';
      let cardsRendered = false;

      for (const part of parts) {
        if (part.type === 'text') {
          // Convert plain URL-like paths to real links
          const escaped = escapeHtml(part.value).replace(
            /(\/product-page\/[\w\-\.]+\.html|\/category\/[\w\-\.]+\.html)/g,
            '<a href="$1" target="_blank" style="color:#d97706;text-decoration:underline;">$1</a>'
          );
          html += escaped.replace(/\n/g, '<br>');
        } else if (part.type === 'card' && !cardsRendered) {
          // Render all cards together in one row
          const allCardIds = cardIds[0] === 'all'
            ? puppiesCache.filter(p => p.status === 'Available').map(p => p.id)
            : cardIds;

          const cards = allCardIds
            .map(id => buildPuppyCard(id))
            .filter(Boolean)
            .join('');

          if (cards) {
            html += `<div class="plush-cards-row">${cards}</div>`;
          }
          cardsRendered = true;
        }
        // Skip subsequent card tokens (already rendered as a row)
      }

      return html;
    }

    function buildPuppyCard(pupId) {
      const pup = puppiesCache.find(p => p.id === pupId);
      if (!pup) return '';
      const name = escapeHtml(pup.name || '');
      const breed = escapeHtml(pup.breed || '');
      const gender = escapeHtml(pup.gender || '');
      const price = pup.price ? '$' + Number(pup.price).toLocaleString() : '';
      const imgSrc = escapeHtml(pup.image_url || '');
      const pageUrl = escapeHtml(pup.page_url || '/category/all-products.html');
      return `
        <div class="plush-puppy-card">
          ${imgSrc ? `<img src="${imgSrc}" alt="${name}" loading="lazy">` : ''}
          <div class="pcard-body">
            <p class="pcard-name">${name}</p>
            <p class="pcard-breed">${breed} · ${gender}</p>
            <p class="pcard-price">${price}</p>
            <a class="pcard-btn" href="${pageUrl}" target="_blank">View &amp; Reserve 🐾</a>
          </div>
        </div>`;
    }

    function scrollToBottom() {
      setTimeout(() => { messagesBox.scrollTop = messagesBox.scrollHeight; }, 50);
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  }
})();
