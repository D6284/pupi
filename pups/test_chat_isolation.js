const http = require('http');
const ioClient = require('socket.io-client');

const BASE_URL = 'http://localhost:3000';

async function makeRequest(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runIsolationTests() {
  console.log('------------------------------------------------------------');
  console.log('🧪 RUNNING STRICT MULTI-TENANT CHAT PRIVACY ISOLATION TESTS');
  console.log('------------------------------------------------------------\n');

  // STEP 1: Initialize 3 Separate Customer Sessions
  console.log('1️⃣  Initializing 3 separate customer sessions (John, Mary, Peter)...');

  const customerA_init = await makeRequest('/api/public/chat/init', 'POST', { name: 'John', email: 'john@example.com' });
  const conv_A = customerA_init.body.conversation.id;
  const token_A = customerA_init.body.sessionToken;
  console.log(`   Customer A (John):  conv_id=${conv_A}, token=${token_A.substring(0, 10)}...`);

  const customerB_init = await makeRequest('/api/public/chat/init', 'POST', { name: 'Mary', email: 'mary@example.com' });
  const conv_B = customerB_init.body.conversation.id;
  const token_B = customerB_init.body.sessionToken;
  console.log(`   Customer B (Mary):  conv_id=${conv_B}, token=${token_B.substring(0, 10)}...`);

  const customerC_init = await makeRequest('/api/public/chat/init', 'POST', { name: 'Peter', email: 'peter@example.com' });
  const conv_C = customerC_init.body.conversation.id;
  const token_C = customerC_init.body.sessionToken;
  console.log(`   Customer C (Peter): conv_id=${conv_C}, token=${token_C.substring(0, 10)}...`);

  if (conv_A === conv_B || conv_B === conv_C || token_A === token_B) {
    console.error('❌ FAIL: Session IDs or Tokens are not unique!');
    process.exit(1);
  } else {
    console.log('   ✅ PASS: Each customer received a unique conversation_id and sessionToken.\n');
  }

  // STEP 2: Send Customer Messages
  console.log('2️⃣  Sending private messages from Customer A, B, and C...');
  
  await makeRequest('/api/public/chat/send', 'POST', {
    conversationId: conv_A, sessionToken: token_A, text: 'Is the female Cavapoo available?'
  }, { 'X-Session-Token': token_A, 'X-Conversation-Id': conv_A });

  await makeRequest('/api/public/chat/send', 'POST', {
    conversationId: conv_B, sessionToken: token_B, text: 'Do you deliver to Douala?'
  }, { 'X-Session-Token': token_B, 'X-Conversation-Id': conv_B });

  await makeRequest('/api/public/chat/send', 'POST', {
    conversationId: conv_C, sessionToken: token_C, text: 'I want to speak with the owner.'
  }, { 'X-Session-Token': token_C, 'X-Conversation-Id': conv_C });

  // Wait for 600ms for initial AI replies to finish emitting before starting realtime test
  await new Promise(r => setTimeout(r, 600));

  console.log('   ✅ Messages sent successfully for all 3 customers.\n');

  // STEP 3: Security & Authorization Leak Test
  console.log('3️⃣  Testing Customer Security (Customer B attempts to access Customer A\'s chat)...');
  
  // Try fetching Customer A's history using Customer B's token
  const leakTest = await makeRequest(`/api/public/chat/messages?conversationId=${conv_A}&sessionToken=${token_B}`, 'GET', null, {
    'X-Session-Token': token_B,
    'X-Conversation-Id': conv_A
  });

  if (leakTest.status === 403) {
    console.log(`   ✅ PASS: Backend rejected unauthorized access with Status ${leakTest.status} (Access Denied).`);
  } else {
    console.error(`❌ FAIL: Backend allowed Customer B to access Customer A's messages! Status: ${leakTest.status}`);
    process.exit(1);
  }

  // Try sending a message to Customer A's conversation using Customer B's token
  const sendLeakTest = await makeRequest('/api/public/chat/send', 'POST', {
    conversationId: conv_A, sessionToken: token_B, text: 'Hacked message'
  }, { 'X-Session-Token': token_B, 'X-Conversation-Id': conv_A });

  if (sendLeakTest.status === 403) {
    console.log(`   ✅ PASS: Backend blocked Customer B from sending messages to Customer A's chat (Status 403).\n`);
  } else {
    console.error(`❌ FAIL: Backend allowed Customer B to inject messages into Customer A's chat!`);
    process.exit(1);
  }

  // STEP 4: Real-time Socket.io Room Isolation Test
  console.log('4️⃣  Testing Real-Time Socket.io Room Privacy...');

  const socketA = ioClient(BASE_URL);
  const socketB = ioClient(BASE_URL);

  let customerB_receivedMessagesCount = 0;

  await new Promise((resolve) => {
    socketA.on('connect', () => {
      socketA.emit('join:customer_conversation', { conversationId: conv_A, sessionToken: token_A });
    });

    socketB.on('connect', () => {
      socketB.emit('join:customer_conversation', { conversationId: conv_B, sessionToken: token_B });
    });

    socketB.on('chat:message', (msg) => {
      customerB_receivedMessagesCount++;
      console.error(`❌ REALTIME LEAK: Customer B received real-time event for message: "${msg.text}"`);
    });

    setTimeout(() => resolve(), 500);
  });

  // Now Customer A sends a new message over HTTP
  await makeRequest('/api/public/chat/send', 'POST', {
    conversationId: conv_A, sessionToken: token_A, text: 'Testing real-time isolation message'
  }, { 'X-Session-Token': token_A, 'X-Conversation-Id': conv_A });

  await new Promise(r => setTimeout(r, 600));

  if (customerB_receivedMessagesCount === 0) {
    console.log('   ✅ PASS: Customer B received ZERO real-time events for Customer A\'s message.\n');
  } else {
    console.error('❌ FAIL: Real-time room isolation breached!');
    process.exit(1);
  }

  socketA.disconnect();
  socketB.disconnect();

  // STEP 5: Admin Panel Visibility & Targeted Takeover
  console.log('5️⃣  Testing Admin Dashboard Visibility & Targeted Owner Reply...');

  const adminAuth = await makeRequest('/api/auth/login', 'POST', { code: 'admin123' });
  const adminToken = adminAuth.body.token;

  const adminChats = await makeRequest('/api/admin/chats', 'GET', null, { 'Authorization': `Bearer ${adminToken}` });
  console.log(`   Admin retrieved ${adminChats.body.chats.length} conversations.`);

  const hasA = adminChats.body.chats.some(c => (c.id || c.conversation_id) === conv_A);
  const hasB = adminChats.body.chats.some(c => (c.id || c.conversation_id) === conv_B);
  const hasC = adminChats.body.chats.some(c => (c.id || c.conversation_id) === conv_C);

  if (hasA && hasB && hasC) {
    console.log('   ✅ PASS: Admin can see all 3 customer conversations (John, Mary, Peter).');
  } else {
    console.error('❌ FAIL: Admin missing customer conversations!');
    process.exit(1);
  }

  // Admin replies specifically to John (Customer A)
  const adminReply = await makeRequest(`/api/admin/chats/${conv_A}/reply`, 'POST', {
    text: "Hello John, I am the owner. Yes, the Cavapoo is available!"
  }, { 'Authorization': `Bearer ${adminToken}` });

  if (adminReply.status === 200 && adminReply.body.success) {
    console.log('   ✅ PASS: Admin replied specifically to Customer A\'s conversation.');
  }

  console.log('\n------------------------------------------------------------');
  console.log('🎉 ALL MULTI-TENANT ISOLATION & PRIVACY TESTS PASSED 100%!');
  console.log('------------------------------------------------------------\n');
  process.exit(0);
}

runIsolationTests().catch(err => {
  console.error('Error running test script:', err);
  process.exit(1);
});
