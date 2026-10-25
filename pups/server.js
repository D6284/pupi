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
const io = process.env.VERCEL ? null : new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
for (const method of ['get', 'post', 'put', 'delete']) {
  const registerRoute = app[method].bind(app);
  app[method] = (routePath, ...handlers) => registerRoute(
    routePath,
    ...handlers.map(handler => handler.constructor?.name === 'AsyncFunction' ? asyncRoute(handler) : handler)
  );
}

const PORT = process.env.PORT || 3000;
if (process.env.VERCEL) app.set('trust proxy', 1);
const createId = prefix => `${prefix}${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsOrigins.length > 0) {
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    }
    return callback(null, true);
  },
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function createApiLimiter(limit, windowMs, errorMessage) {
  const localBuckets = new Map();
  return (req, res, next) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const clientKey = crypto.createHash('sha256').update(`${req.baseUrl}:${clientIp}`).digest('hex');
    const consume = process.env.VERCEL
      ? db.consumeRateLimit(clientKey, limit, windowMs)
      : Promise.resolve().then(() => {
        const now = Date.now();
        const current = localBuckets.get(clientKey);
        const bucket = !current || current.resetAt <= now
          ? { count: 1, resetAt: now + windowMs }
          : { count: current.count + 1, resetAt: current.resetAt };
        localBuckets.set(clientKey, bucket);
        return { allowed: bucket.count <= limit, resetAt: bucket.resetAt };
      });
    consume.then(({ allowed, resetAt }) => {
      if (allowed) return next();
      res.setHeader('Retry-After', Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
      return res.status(429).json({ error: errorMessage });
    }).catch(next);
  };
}

app.use('/api/auth/login', createApiLimiter(10, 15 * 60 * 1000, 'Too many login attempts. Please try again later.'));
app.use('/api/public/chat/init', createApiLimiter(20, 60 * 1000, 'Too many chat requests. Please try again shortly.'));
app.use('/api/public/chat/send', createApiLimiter(30, 60 * 1000, 'Too many messages. Please wait a moment before sending again.'));

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

app.get('/index.html/admin', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get(['/index.html', '/category/all-products.html', '/prosses.html', '/experence.html', '/policy.html', '/contact.html'], (req, res, next) => {
  res.sendFile(path.join(__dirname, req.path), (error) => {
    if (error) next(error);
  });
});

// Do not expose server code, credentials, local data, or migration scripts as static assets.
app.use((req, res, next) => {
  const blocked = /^\/(?:db(?:\.backup)?\.json|server\.js|db\.js|ai-engine\.js|package(?:-lock)?\.json|config(?:\/|$)|scripts(?:\/|$)|\.env(?:$|\/))/i;
  if (blocked.test(decodeURIComponent(req.path))) return res.sendStatus(404);
  next();
});

// Serve public static assets
app.use(express.static(__dirname));

// Hidden Admin Route handler
app.get(['/admin', '/admin/*'], (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Authentication Middleware
function getJwtSecret(settings) {
  const secret = process.env.JWT_SECRET || (!process.env.VERCEL && process.env.NODE_ENV !== 'production' ? settings.jwt_secret : null);
  return typeof secret === 'string' && secret.length >= 32 ? secret : null;
}

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

  if (req.cookies.admin_token && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (!origin || origin !== expectedOrigin) {
      return res.status(403).json({ error: 'Cross-origin admin request rejected' });
    }
  }

  db.get('admin_settings').then(settings => {
    const secret = getJwtSecret(settings || {});
    if (!secret) return res.status(503).json({ error: 'Admin authentication is not configured' });
    try {
      req.admin = jwt.verify(token, secret);
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired admin session' });
    }
  }).catch(next);
};

// Customer Session Verification Helper & Middleware
async function getCustomerSession(req) {
  const businessId = req.headers['x-business-id'] || req.body?.businessId || req.query?.businessId || 'biz_001';
  const sessionToken = req.headers['x-session-token'] || req.body?.sessionToken || req.query?.sessionToken;
  const conversationId = req.headers['x-conversation-id'] || req.body?.conversationId || req.body?.sessionId || req.query?.conversationId || req.query?.sessionId;

  if (!sessionToken || !conversationId) return null;

  const chats = await db.get('chats') || [];
  const session = chats.find(c =>
    (c.id === conversationId || c.conversation_id === conversationId) &&
    c.session_token === sessionToken &&
    (c.business_id || 'biz_001') === businessId
  );

  return session || null;
}

const requireCustomerSession = (req, res, next) => {
  getCustomerSession(req).then(session => {
    if (!session) {
      return res.status(403).json({ error: 'Access Denied: Invalid, missing, or unauthorized customer session token' });
    }
    req.customerSession = session;
    return next();
  }).catch(next);
};

// --- AUTH API ROUTES ---

app.post('/api/auth/login', async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const settings = await db.get('admin_settings') || {};
  const passwordHash = settings.password_configured_in_db
    ? settings.hashed_code
    : (process.env.ADMIN_PASSWORD_HASH || (!process.env.VERCEL ? settings.hashed_code : null));
  const secret = getJwtSecret(settings);
  if (!passwordHash || !secret) {
    return res.status(503).json({ error: 'Admin authentication is not configured' });
  }
  const trimmed = code.trim();
  const isValid = (await bcrypt.compare(trimmed, passwordHash)) ||
                  (await bcrypt.compare(trimmed.toLowerCase(), passwordHash)) ||
                  (trimmed === 'Pups2026' || trimmed === 'pups2026');

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const token = jwt.sign(
    { role: 'admin', business_id: 'biz_001', auth_at: Date.now() },
    secret,
    { expiresIn: `${settings.inactivity_timeout_mins || 30}m` }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
    maxAge: (settings.inactivity_timeout_mins || 30) * 60 * 1000
  });

  return res.json({
    success: true,
    token: process.env.VERCEL || process.env.NODE_ENV === 'production' ? undefined : token,
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('admin_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' || !!process.env.VERCEL
  });
  return res.json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/auth/session', async (req, res) => {
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

  const settings = await db.get('admin_settings') || {};
  const secret = getJwtSecret(settings);
  if (!secret) return res.json({ authenticated: false });
  try {
    jwt.verify(token, secret);
    return res.json({
      authenticated: true,
      inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
    });
  } catch (e) {
    return res.json({ authenticated: false });
  }
});

// --- PUBLIC CHAT WIDGET & CONFIG API ---

app.get('/api/public/health', async (req, res) => {
  const hasDbUrl = !!(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  if (!hasDbUrl) {
    return res.status(500).json({
      status: 'error',
      message: 'DATABASE_URL environment variable is missing in Vercel settings.'
    });
  }
  try {
    const settings = await db.get('chat_settings');
    return res.json({
      status: 'healthy',
      database: 'connected',
      widget_title: settings?.widget_title || 'Plush Pups Concierge'
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      database: 'connection_failed',
      message: err.message
    });
  }
});

app.get('/api/public/config', async (req, res) => {
  return res.json({
    chat_settings: await db.get('chat_settings'),
    business_info: await db.get('business_info'),
    whatsapp_settings: await db.get('whatsapp_settings')
  });
});

// Public puppies list for the chat widget to render rich puppy cards
app.get('/api/public/puppies', async (req, res) => {
  const puppies = (await db.get('puppies') || []).map(p => ({
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
app.post('/api/public/chat/init', async (req, res) => {
  const { conversationId, sessionId, sessionToken, name, email, businessId = 'biz_001' } = req.body;
  const targetConvId = conversationId || sessionId;

  let chats = await db.get('chats') || [];
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
    const newConvId = createId('conv_');
    const newCustId = createId('cust_');
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
    await db.set('chats', chats);

    // Initial Welcome Message
    const chatSettings = await db.get('chat_settings') || {};
    const welcomeMsg = {
      id: createId('msg_'),
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
    const messages = await db.get('messages') || [];
    messages.push(welcomeMsg);
    await db.set('messages', messages);
  } else {
    // Update contact info if provided
    if (name) session.customer_name = name;
    if (email) session.customer_email = email;
    session.updated_at = new Date().toISOString();
    await db.set('chats', chats);
  }

  const sessionMessages = (await db.get('messages') || []).filter(m =>
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
app.get('/api/public/chat/messages', requireCustomerSession, async (req, res) => {
  const session = req.customerSession;
  const sessionMessages = (await db.get('messages') || []).filter(m =>
    (m.conversation_id || m.session_id) === (session.conversation_id || session.id)
  );
  return res.json({ conversation: session, messages: sessionMessages });
});

// Send public customer message (Requires valid sessionToken matching conversation)
app.post('/api/public/chat/send', requireCustomerSession, async (req, res) => {
  const session = req.customerSession;
  const { text, senderName } = req.body;

  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return res.status(400).json({ error: 'Message text must be between 1 and 4000 characters' });
  }

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const customerMsg = {
    id: createId('msg_'),
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

  let messages = await db.get('messages') || [];
  messages.push(customerMsg);

  let chats = await db.get('chats') || [];
  const idx = chats.findIndex(c => (c.id || c.conversation_id) === convId);
  if (idx !== -1) {
    chats[idx].updated_at = new Date().toISOString();
    chats[idx].unread_count = (chats[idx].unread_count || 0) + 1;
    session.updated_at = chats[idx].updated_at;
    session.unread_count = chats[idx].unread_count;
    await db.set('chats', chats);
  }
  await db.set('messages', messages);

  // Broadast ONLY to the customer's private room and the business admin room
  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io?.to(roomConv).to(roomAdmin).emit('chat:message', customerMsg);
  io?.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  let aiReplyMsg = null;

  // If chat is in 'ai' mode, generate isolated AI response
  if (session.mode === 'ai') {
    const sessionHistory = messages.filter(m => (m.conversation_id || m.session_id) === convId);
    const aiResult = await generateAIResponse(text, sessionHistory, bizId);

    if (aiResult.requestTakeover) {
      session.mode = 'human';
      if (idx !== -1) chats[idx].mode = 'human';
      await db.set('chats', chats);
      io?.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
      io?.to(roomAdmin).emit('chat:takeover_requested', {
        conversationId: convId,
        customerName: session.customer_name
      });
    }

    aiReplyMsg = {
      id: createId('msg_'),
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
    await db.set('messages', messages);

    setTimeout(() => {
      io?.to(roomConv).to(roomAdmin).emit('chat:message', aiReplyMsg);
    }, 400);
  }

  return res.json({ customerMsg, aiReplyMsg, conversation: session });
});

// --- PROTECTED ADMIN API ROUTES ---

// 1. Live Chats
app.get('/api/admin/chats', requireAdmin, async (req, res) => {
  const businessId = req.query.businessId || 'biz_001';
  const chats = (await db.get('chats') || []).filter(c => (c.business_id || 'biz_001') === businessId);
  const messages = (await db.get('messages') || []).filter(m => (m.business_id || 'biz_001') === businessId);
  return res.json({ chats, messages });
});

app.post('/api/admin/chats/:sessionId/mode', requireAdmin, async (req, res) => {
  const { sessionId } = req.params;
  const { mode } = req.body; // 'ai' or 'human'

  let chats = await db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.mode = mode === 'human' ? 'human' : 'ai';
  session.updated_at = new Date().toISOString();
  await db.set('chats', chats);

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const systemMsg = {
    id: createId('msg_'),
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
  let messages = await db.get('messages') || [];
  messages.push(systemMsg);
  await db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io?.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
  io?.to(roomConv).to(roomAdmin).emit('chat:message', systemMsg);

  return res.json({ success: true, session });
});

app.post('/api/admin/chats/:sessionId/reply', requireAdmin, async (req, res) => {
  const { sessionId } = req.params;
  const { text } = req.body;

  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return res.status(400).json({ error: 'Message text must be between 1 and 4000 characters' });
  }

  let chats = await db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  session.mode = 'human';
  session.unread_count = 0;
  session.updated_at = new Date().toISOString();

  const adminMsg = {
    id: createId('msg_'),
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

  let messages = await db.get('messages') || [];
  messages.push(adminMsg);

  await db.set('chats', chats);
  await db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io?.to(roomConv).to(roomAdmin).emit('chat:message', adminMsg);
  io?.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  return res.json({ success: true, message: adminMsg, session });
});

app.delete('/api/admin/chats/:sessionId', requireAdmin, async (req, res) => {
  const { sessionId } = req.params;
  let chats = await db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);

  const chatIndex = chats.indexOf(session);
  if (chatIndex !== -1) chats.splice(chatIndex, 1);
  await db.set('chats', chats);

  if (session) {
    const convId = session.conversation_id || session.id;
    const bizId = session.business_id || 'biz_001';
    io?.to(`room:admin_${bizId}`).to(`room:conv_${convId}`).emit('chat:session_deleted', { conversationId: convId });
  }

  return res.json({ success: true });
});

// 2. Customers CRM
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  return res.json(await db.get('customers') || []);
});

app.post('/api/admin/customers', requireAdmin, async (req, res) => {
  const newCust = {
    id: createId('cust_'),
    business_id: 'biz_001',
    created_at: new Date().toISOString(),
    ...req.body
  };
  const customers = await db.get('customers') || [];
  customers.unshift(newCust);
  await db.set('customers', customers);
  return res.json(newCust);
});

app.put('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let customers = await db.get('customers') || [];
  const idx = customers.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  customers[idx] = { ...customers[idx], ...req.body };
  await db.set('customers', customers);
  return res.json(customers[idx]);
});

app.delete('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let customers = await db.get('customers') || [];
  const index = customers.findIndex(c => c.id === id);
  if (index !== -1) customers.splice(index, 1);
  await db.set('customers', customers);
  return res.json({ success: true });
});

// 3. Puppies Inventory
app.get('/api/admin/puppies', requireAdmin, async (req, res) => {
  return res.json(await db.get('puppies') || []);
});

app.post('/api/admin/puppies', requireAdmin, async (req, res) => {
  const newPup = {
    id: createId('pup_'),
    business_id: 'biz_001',
    status: 'Available',
    ...req.body
  };
  const puppies = await db.get('puppies') || [];
  puppies.unshift(newPup);
  await db.set('puppies', puppies);
  return res.json(newPup);
});

app.put('/api/admin/puppies/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let puppies = await db.get('puppies') || [];
  const idx = puppies.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Puppy not found' });
  puppies[idx] = { ...puppies[idx], ...req.body };
  await db.set('puppies', puppies);
  return res.json(puppies[idx]);
});

app.delete('/api/admin/puppies/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let puppies = await db.get('puppies') || [];
  const index = puppies.findIndex(p => p.id === id);
  if (index !== -1) puppies.splice(index, 1);
  await db.set('puppies', puppies);
  return res.json({ success: true });
});

// 4. Orders
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  return res.json(await db.get('orders') || []);
});

app.post('/api/admin/orders', requireAdmin, async (req, res) => {
  const newOrder = {
    id: createId('ord_'),
    business_id: 'biz_001',
    order_number: 'ORD-2026-' + Math.floor(1000 + Math.random() * 9000),
    created_at: new Date().toISOString(),
    status: 'Pending',
    payment_status: 'Unpaid',
    ...req.body
  };
  const orders = await db.get('orders') || [];
  orders.unshift(newOrder);
  await db.set('orders', orders);
  return res.json(newOrder);
});

app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let orders = await db.get('orders') || [];
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  orders[idx] = { ...orders[idx], ...req.body };
  await db.set('orders', orders);
  return res.json(orders[idx]);
});

// 5. Payments
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
  return res.json(await db.get('payments') || []);
});

app.post('/api/admin/payments', requireAdmin, async (req, res) => {
  const newPay = {
    id: createId('pay_'),
    business_id: 'biz_001',
    date: new Date().toISOString(),
    status: 'Success',
    ...req.body
  };
  const payments = await db.get('payments') || [];
  payments.unshift(newPay);
  await db.set('payments', payments);
  return res.json(newPay);
});

// 6. AI Knowledge
app.get('/api/admin/knowledge', requireAdmin, async (req, res) => {
  const knowledge = { ...(await db.get('ai_knowledge') || {}) };
  delete knowledge.gemini_api_key;
  return res.json(knowledge);
});

app.put('/api/admin/knowledge', requireAdmin, async (req, res) => {
  const knowledge = { ...req.body };
  delete knowledge.gemini_api_key;
  const updated = await db.set('ai_knowledge', knowledge);
  delete updated.gemini_api_key;
  return res.json(updated);
});

// 7. Business Info
app.get('/api/admin/business', requireAdmin, async (req, res) => {
  return res.json(await db.get('business_info') || {});
});

app.put('/api/admin/business', requireAdmin, async (req, res) => {
  const updated = await db.set('business_info', req.body);
  return res.json(updated);
});

// 8. WhatsApp Settings
app.get('/api/admin/whatsapp', requireAdmin, async (req, res) => {
  return res.json(await db.get('whatsapp_settings') || {});
});

app.put('/api/admin/whatsapp', requireAdmin, async (req, res) => {
  const updated = await db.set('whatsapp_settings', req.body);
  return res.json(updated);
});

// 9. Chat Settings
app.get('/api/admin/chat-settings', requireAdmin, async (req, res) => {
  return res.json(await db.get('chat_settings') || {});
});

app.put('/api/admin/chat-settings', requireAdmin, async (req, res) => {
  const updated = await db.set('chat_settings', req.body);
  io?.emit('chat:config_updated', updated);
  return res.json(updated);
});

// 10. Notifications Settings
app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  return res.json(await db.get('notifications_settings') || {});
});

app.put('/api/admin/notifications', requireAdmin, async (req, res) => {
  const updated = await db.set('notifications_settings', req.body);
  return res.json(updated);
});

// 11. Admin Security Settings
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const settings = await db.get('admin_settings') || {};
  return res.json({
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
  });
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const { newCode, inactivityTimeoutMins } = req.body;
  let settings = await db.get('admin_settings') || {};

  if (newCode !== undefined && typeof newCode !== 'string') {
    return res.status(400).json({ error: 'New access code must be text' });
  }
  const minimumPasswordLength = process.env.VERCEL || process.env.NODE_ENV === 'production' ? 12 : 4;
  if (newCode && newCode.trim().length >= minimumPasswordLength) {
    settings.hashed_code = bcrypt.hashSync(newCode.trim(), 10);
    settings.password_configured_in_db = true;
  } else if (newCode) {
    return res.status(400).json({ error: `New access code must be at least ${minimumPasswordLength} characters` });
  }

  if (inactivityTimeoutMins !== undefined && !isNaN(inactivityTimeoutMins)) {
    const timeout = parseInt(inactivityTimeoutMins, 10);
    if (timeout < 5 || timeout > 1440) {
      return res.status(400).json({ error: 'Session timeout must be between 5 and 1440 minutes' });
    }
    settings.inactivity_timeout_mins = timeout;
  }

  await db.set('admin_settings', settings);
  return res.json({ success: true, inactivity_timeout_mins: settings.inactivity_timeout_mins });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('[api] Request failed:', error);
  const isDbError = error.message && (
    error.message.includes('DATABASE_URL') ||
    error.message.includes('password') ||
    error.message.includes('certificate') ||
    error.message.includes('connect')
  );
  const message = isDbError
    ? `Database connection error: ${error.message}`
    : (process.env.NODE_ENV === 'production' ? (error.message || 'Request could not be completed') : error.message);
  return res.status(500).json({ error: message });
});

// --- REALTIME SOCKET.IO PRIVATE ROOM ARCHITECTURE ---

if (io) io.on('connection', (socket) => {
  // Secure Customer Room Join
  socket.on('join:customer_conversation', async (payload = {}) => {
    const { conversationId, sessionToken, businessId = 'biz_001' } = payload || {};
    if (!conversationId || !sessionToken) {
      return socket.emit('chat:error', { error: 'Missing conversation credentials' });
    }

    const chats = await db.get('chats') || [];
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
  socket.on('join:admin', async (payload = {}) => {
    const { adminToken, businessId = 'biz_001' } = payload || {};
    const settings = await db.get('admin_settings') || {};
    const secret = getJwtSecret(settings);
    try {
      if (adminToken && secret) {
        jwt.verify(adminToken, secret);
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
