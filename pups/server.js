const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const db = require('./db');
const { generateAIResponse } = require('./ai-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Prevent search indexing headers for admin API and route
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

// Serve the homepage explicitly for local and serverless requests.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve public static assets
app.use(express.static(__dirname));

// Hidden Admin Route handler
app.get(['/admin', '/admin/*'], (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Authentication Middleware
const requireAdmin = (req, res, next) => {
  let token = req.cookies.admin_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized admin access' });
  }

  const settings = db.get('admin_settings') || {};
  try {
    const decoded = jwt.verify(token, settings.jwt_secret);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin session' });
  }
};

// Customer Session Verification Helper & Middleware
function getCustomerSession(req) {
  const businessId = req.headers['x-business-id'] || req.body?.businessId || req.query?.businessId || 'biz_001';
  const sessionToken = req.headers['x-session-token'] || req.body?.sessionToken || req.query?.sessionToken;
  const conversationId = req.headers['x-conversation-id'] || req.body?.conversationId || req.body?.sessionId || req.query?.conversationId || req.query?.sessionId;

  if (!sessionToken || !conversationId) return null;

  const chats = db.get('chats') || [];
  const session = chats.find(c =>
    (c.id === conversationId || c.conversation_id === conversationId) &&
    c.session_token === sessionToken &&
    (c.business_id || 'biz_001') === businessId
  );

  return session || null;
}

const requireCustomerSession = (req, res, next) => {
  const session = getCustomerSession(req);
  if (!session) {
    return res.status(403).json({ error: 'Access Denied: Invalid, missing, or unauthorized customer session token' });
  }
  req.customerSession = session;
  next();
};

// --- AUTH API ROUTES ---

app.post('/api/auth/login', (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const settings = db.get('admin_settings');
  const isValid = bcrypt.compareSync(code.trim(), settings.hashed_code);

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const token = jwt.sign(
    { role: 'admin', business_id: 'biz_001', auth_at: Date.now() },
    settings.jwt_secret,
    { expiresIn: `${settings.inactivity_timeout_mins || 30}m` }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: (settings.inactivity_timeout_mins || 30) * 60 * 1000
  });

  return res.json({
    success: true,
    token,
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('admin_token');
  return res.json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/auth/session', (req, res) => {
  let token = req.cookies.admin_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.json({ authenticated: false });
  }

  const settings = db.get('admin_settings');
  try {
    jwt.verify(token, settings.jwt_secret);
    return res.json({
      authenticated: true,
      inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
    });
  } catch (e) {
    return res.json({ authenticated: false });
  }
});

// --- PUBLIC CHAT WIDGET & CONFIG API ---

app.get('/api/public/config', (req, res) => {
  const businessId = req.query.businessId || 'biz_001';
  return res.json({
    chat_settings: db.get('chat_settings'),
    business_info: db.get('business_info'),
    whatsapp_settings: db.get('whatsapp_settings')
  });
});

// Public puppies list for the chat widget to render rich puppy cards
app.get('/api/public/puppies', (req, res) => {
  const puppies = (db.get('puppies') || []).map(p => ({
    id: p.id,
    name: p.name,
    breed: p.breed,
    gender: p.gender,
    price: p.price,
    color: p.color,
    weight: p.weight,
    status: p.status,
    image_url: p.image_url || '',
    page_url: p.page_url || '/category/all-products.html',
    description: p.description || ''
  }));
  return res.json(puppies);
});

// Initiate or restore private customer chat session securely
app.post('/api/public/chat/init', (req, res) => {
  const { conversationId, sessionId, sessionToken, name, email, businessId = 'biz_001' } = req.body;
  const targetConvId = conversationId || sessionId;

  let chats = db.get('chats') || [];
  let session = null;

  if (targetConvId && sessionToken) {
    session = chats.find(c =>
      (c.id === targetConvId || c.conversation_id === targetConvId) &&
      c.session_token === sessionToken &&
      (c.business_id || 'biz_001') === businessId
    );
  }

  if (!session) {
    // Create new secure private conversation with unique IDs & cryptographic token
    const newConvId = 'conv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const newCustId = 'cust_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const newSessionToken = crypto.randomBytes(32).toString('hex');

    session = {
      id: newConvId,
      conversation_id: newConvId,
      customer_id: newCustId,
      business_id: businessId,
      session_token: newSessionToken,
      customer_name: name || 'Guest Visitor',
      customer_email: email || '',
      mode: 'ai',
      status: 'active',
      unread_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    chats.unshift(session);
    db.set('chats', chats);

    // Initial Welcome Message
    const chatSettings = db.get('chat_settings') || {};
    const welcomeMsg = {
      id: 'msg_' + Date.now(),
      conversation_id: newConvId,
      session_id: newConvId,
      customer_id: newCustId,
      business_id: businessId,
      sender: 'ai',
      sender_name: 'Plush Pups AI',
      text: chatSettings.welcome_message || 'Hello! 🐾 Welcome to Plush Pups by Reed! How can we help you find your dream puppy today?',
      timestamp: new Date().toISOString(),
      read: true
    };
    const messages = db.get('messages') || [];
    messages.push(welcomeMsg);
    db.set('messages', messages);
  } else {
    // Update contact info if provided
    if (name) session.customer_name = name;
    if (email) session.customer_email = email;
    session.updated_at = new Date().toISOString();
    db.set('chats', chats);
  }

  const sessionMessages = (db.get('messages') || []).filter(m =>
    (m.conversation_id || m.session_id) === (session.conversation_id || session.id) &&
    (m.business_id || 'biz_001') === businessId
  );

  return res.json({
    conversation: session,
    sessionToken: session.session_token,
    messages: sessionMessages
  });
});

// Fetch private customer messages (Requires valid sessionToken matching conversation)
app.get('/api/public/chat/messages', requireCustomerSession, (req, res) => {
  const session = req.customerSession;
  const sessionMessages = (db.get('messages') || []).filter(m =>
    (m.conversation_id || m.session_id) === (session.conversation_id || session.id)
  );
  return res.json({ conversation: session, messages: sessionMessages });
});

// Send public customer message (Requires valid sessionToken matching conversation)
app.post('/api/public/chat/send', requireCustomerSession, async (req, res) => {
  const session = req.customerSession;
  const { text, senderName } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Message text required' });
  }

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const customerMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'customer',
    sender_name: senderName || session.customer_name || 'Customer',
    text: text.trim(),
    timestamp: new Date().toISOString(),
    read: false
  };

  let messages = db.get('messages') || [];
  messages.push(customerMsg);

  let chats = db.get('chats') || [];
  const idx = chats.findIndex(c => (c.id || c.conversation_id) === convId);
  if (idx !== -1) {
    chats[idx].updated_at = new Date().toISOString();
    chats[idx].unread_count = (chats[idx].unread_count || 0) + 1;
    session.updated_at = chats[idx].updated_at;
    session.unread_count = chats[idx].unread_count;
    db.set('chats', chats);
  }
  db.set('messages', messages);

  // Broadast ONLY to the customer's private room and the business admin room
  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:message', customerMsg);
  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  let aiReplyMsg = null;

  // If chat is in 'ai' mode, generate isolated AI response
  if (session.mode === 'ai') {
    const sessionHistory = messages.filter(m => (m.conversation_id || m.session_id) === convId);
    const aiResult = await generateAIResponse(text, sessionHistory, bizId);

    if (aiResult.requestTakeover) {
      session.mode = 'human';
      if (idx !== -1) chats[idx].mode = 'human';
      db.set('chats', chats);
      io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
      io.to(roomAdmin).emit('chat:takeover_requested', {
        conversationId: convId,
        customerName: session.customer_name
      });
    }

    aiReplyMsg = {
      id: 'msg_' + (Date.now() + 1),
      conversation_id: convId,
      session_id: convId,
      customer_id: session.customer_id,
      business_id: bizId,
      sender: 'ai',
      sender_name: 'Plush Pups AI',
      text: aiResult.text,
      timestamp: new Date().toISOString(),
      read: true
    };

    messages.push(aiReplyMsg);
    db.set('messages', messages);

    setTimeout(() => {
      io.to(roomConv).to(roomAdmin).emit('chat:message', aiReplyMsg);
    }, 400);
  }

  return res.json({ customerMsg, aiReplyMsg, conversation: session });
});

// --- PROTECTED ADMIN API ROUTES ---

// 1. Live Chats
app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const businessId = req.query.businessId || 'biz_001';
  const chats = (db.get('chats') || []).filter(c => (c.business_id || 'biz_001') === businessId);
  const messages = (db.get('messages') || []).filter(m => (m.business_id || 'biz_001') === businessId);
  return res.json({ chats, messages });
});

app.post('/api/admin/chats/:sessionId/mode', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  const { mode } = req.body; // 'ai' or 'human'

  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.mode = mode === 'human' ? 'human' : 'ai';
  session.updated_at = new Date().toISOString();
  db.set('chats', chats);

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const systemMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'human',
    sender_name: 'System',
    text: mode === 'human' ? '👤 Admin took over the live chat.' : '🤖 AI Assistant has resumed the chat.',
    timestamp: new Date().toISOString(),
    read: true
  };
  let messages = db.get('messages') || [];
  messages.push(systemMsg);
  db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
  io.to(roomConv).to(roomAdmin).emit('chat:message', systemMsg);

  return res.json({ success: true, session });
});

app.post('/api/admin/chats/:sessionId/reply', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  const { text } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });

  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  session.mode = 'human';
  session.unread_count = 0;
  session.updated_at = new Date().toISOString();

  const adminMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'human',
    sender_name: 'Admin Concierge',
    text: text.trim(),
    timestamp: new Date().toISOString(),
    read: true
  };

  let messages = db.get('messages') || [];
  messages.push(adminMsg);

  db.set('chats', chats);
  db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:message', adminMsg);
  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  return res.json({ success: true, message: adminMsg, session });
});

app.delete('/api/admin/chats/:sessionId', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);

  chats = chats.filter(c => (c.id || c.conversation_id) !== sessionId);
  db.set('chats', chats);

  if (session) {
    const convId = session.conversation_id || session.id;
    const bizId = session.business_id || 'biz_001';
    io.to(`room:admin_${bizId}`).to(`room:conv_${convId}`).emit('chat:session_deleted', { conversationId: convId });
  }

  return res.json({ success: true });
});

// 2. Customers CRM
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  return res.json(db.get('customers') || []);
});

app.post('/api/admin/customers', requireAdmin, (req, res) => {
  const newCust = {
    id: 'cust_' + Date.now(),
    business_id: 'biz_001',
    created_at: new Date().toISOString(),
    ...req.body
  };
  const customers = db.get('customers') || [];
  customers.unshift(newCust);
  db.set('customers', customers);
  return res.json(newCust);
});

app.put('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let customers = db.get('customers') || [];
  const idx = customers.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  customers[idx] = { ...customers[idx], ...req.body };
  db.set('customers', customers);
  return res.json(customers[idx]);
});

app.delete('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let customers = db.get('customers') || [];
  customers = customers.filter(c => c.id !== id);
  db.set('customers', customers);
  return res.json({ success: true });
});

// 3. Puppies Inventory
app.get('/api/admin/puppies', requireAdmin, (req, res) => {
  return res.json(db.get('puppies') || []);
});

app.post('/api/admin/puppies', requireAdmin, (req, res) => {
  const newPup = {
    id: 'pup_' + Date.now(),
    business_id: 'biz_001',
    status: 'Available',
    ...req.body
  };
  const puppies = db.get('puppies') || [];
  puppies.unshift(newPup);
  db.set('puppies', puppies);
  return res.json(newPup);
});

app.put('/api/admin/puppies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let puppies = db.get('puppies') || [];
  const idx = puppies.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Puppy not found' });
  puppies[idx] = { ...puppies[idx], ...req.body };
  db.set('puppies', puppies);
  return res.json(puppies[idx]);
});

app.delete('/api/admin/puppies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let puppies = db.get('puppies') || [];
  puppies = puppies.filter(p => p.id !== id);
  db.set('puppies', puppies);
  return res.json({ success: true });
});

// 4. Orders
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  return res.json(db.get('orders') || []);
});

app.post('/api/admin/orders', requireAdmin, (req, res) => {
  const newOrder = {
    id: 'ord_' + Date.now(),
    business_id: 'biz_001',
    order_number: 'ORD-2026-' + Math.floor(1000 + Math.random() * 9000),
    created_at: new Date().toISOString(),
    status: 'Pending',
    payment_status: 'Unpaid',
    ...req.body
  };
  const orders = db.get('orders') || [];
  orders.unshift(newOrder);
  db.set('orders', orders);
  return res.json(newOrder);
});

app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let orders = db.get('orders') || [];
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  orders[idx] = { ...orders[idx], ...req.body };
  db.set('orders', orders);
  return res.json(orders[idx]);
});

// 5. Payments
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  return res.json(db.get('payments') || []);
});

app.post('/api/admin/payments', requireAdmin, (req, res) => {
  const newPay = {
    id: 'pay_' + Date.now(),
    business_id: 'biz_001',
    date: new Date().toISOString(),
    status: 'Success',
    ...req.body
  };
  const payments = db.get('payments') || [];
  payments.unshift(newPay);
  db.set('payments', payments);
  return res.json(newPay);
});

// 6. AI Knowledge
app.get('/api/admin/knowledge', requireAdmin, (req, res) => {
  return res.json(db.get('ai_knowledge') || {});
});

app.put('/api/admin/knowledge', requireAdmin, (req, res) => {
  const updated = db.set('ai_knowledge', req.body);
  return res.json(updated);
});

// 7. Business Info
app.get('/api/admin/business', requireAdmin, (req, res) => {
  return res.json(db.get('business_info') || {});
});

app.put('/api/admin/business', requireAdmin, (req, res) => {
  const updated = db.set('business_info', req.body);
  return res.json(updated);
});

// 8. WhatsApp Settings
app.get('/api/admin/whatsapp', requireAdmin, (req, res) => {
  return res.json(db.get('whatsapp_settings') || {});
});

app.put('/api/admin/whatsapp', requireAdmin, (req, res) => {
  const updated = db.set('whatsapp_settings', req.body);
  return res.json(updated);
});

// 9. Chat Settings
app.get('/api/admin/chat-settings', requireAdmin, (req, res) => {
  return res.json(db.get('chat_settings') || {});
});

app.put('/api/admin/chat-settings', requireAdmin, (req, res) => {
  const updated = db.set('chat_settings', req.body);
  io.emit('chat:config_updated', updated);
  return res.json(updated);
});

// 10. Notifications Settings
app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  return res.json(db.get('notifications_settings') || {});
});

app.put('/api/admin/notifications', requireAdmin, (req, res) => {
  const updated = db.set('notifications_settings', req.body);
  return res.json(updated);
});

// 11. Admin Security Settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = db.get('admin_settings') || {};
  return res.json({
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { newCode, inactivityTimeoutMins } = req.body;
  let settings = db.get('admin_settings') || {};

  if (newCode && newCode.trim().length >= 4) {
    settings.hashed_code = bcrypt.hashSync(newCode.trim(), 10);
  }

  if (inactivityTimeoutMins && !isNaN(inactivityTimeoutMins)) {
    settings.inactivity_timeout_mins = parseInt(inactivityTimeoutMins, 10);
  }

  db.set('admin_settings', settings);
  return res.json({ success: true, inactivity_timeout_mins: settings.inactivity_timeout_mins });
});

// --- REALTIME SOCKET.IO PRIVATE ROOM ARCHITECTURE ---

io.on('connection', (socket) => {
  // Secure Customer Room Join
  socket.on('join:customer_conversation', (payload = {}) => {
    const { conversationId, sessionToken, businessId = 'biz_001' } = payload || {};
    if (!conversationId || !sessionToken) {
      return socket.emit('chat:error', { error: 'Missing conversation credentials' });
    }

    const chats = db.get('chats') || [];
    const session = chats.find(c =>
      (c.id === conversationId || c.conversation_id === conversationId) &&
      c.session_token === sessionToken &&
      (c.business_id || 'biz_001') === businessId
    );

    if (session) {
      const convId = session.conversation_id || session.id;
      socket.join(`room:conv_${convId}`);
      socket.emit('joined:success', { conversationId: convId });
    } else {
      socket.emit('chat:error', { error: 'Access Denied: Invalid customer session token' });
    }
  });

  // Secure Admin Room Join
  socket.on('join:admin', (payload = {}) => {
    const { adminToken, businessId = 'biz_001' } = payload || {};
    const settings = db.get('admin_settings') || {};
    try {
      if (adminToken) {
        jwt.verify(adminToken, settings.jwt_secret);
        socket.join(`room:admin_${businessId}`);
        socket.emit('joined:admin_success', { businessId });
      } else {
        socket.emit('chat:error', { error: 'Admin token required' });
      }
    } catch (err) {
      socket.emit('chat:error', { error: 'Unauthorized or expired admin token' });
    }
  });
});

// Start Server
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🐾 Plush Pups Multi-Tenant Secure Live Chat System`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔒 Hidden Admin Route: http://localhost:${PORT}/admin`);
    console.log(`====================================================`);
  });
}

module.exports = app;
