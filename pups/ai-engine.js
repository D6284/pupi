const https = require('https');
const db = require('./db');

/**
 * Clean markdown bold/header syntax so responses read like natural human chat
 */
function cleanHumanText(text) {
  if (!text) return '';
  return text
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/---\s*/g, '')
    .replace(/_{1,2}/g, '')
    .trim();
}

/**
 * Call Gemini REST API for a given model with strict timeout
 */
function callGeminiAPI(model, apiKey, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text && text.trim()) return resolve(text.trim());
            } catch (e) {}
          }
          reject(new Error(`Status ${res.statusCode}: ${data.substring(0, 100)}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Query Gemini AI with automatic fallback across fast models
 */
async function queryGemini(contents, systemInstructionText, apiKey) {
  // Ultra-fast flash-lite models benchmarked under 1.5s
  const models = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite-preview'];
  const postData = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstructionText }] },
    contents,
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: 600
    }
  });

  for (const model of models) {
    try {
      const text = await callGeminiAPI(model, apiKey, postData);
      if (text) return cleanHumanText(text);
    } catch (err) {
      console.warn(`[Gemini AI] Model ${model} failed, trying next: ${err.message}`);
    }
  }
  return null;
}

/**
 * Format conversation history into Gemini alternating user/model roles
 */
function formatHistory(sessionHistory, customerText) {
  const contents = [];
  const validMessages = (sessionHistory || []).slice(-10);

  for (const m of validMessages) {
    if (!m.text || !m.text.trim()) continue;
    const role = m.sender === 'customer' ? 'user' : 'model';
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += '\n' + m.text.trim();
    } else {
      contents.push({ role, parts: [{ text: m.text.trim() }] });
    }
  }

  const trimmedText = customerText.trim();
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: trimmedText }] });
  } else if (!contents[contents.length - 1].parts[0].text.includes(trimmedText)) {
    contents.push({ role: 'user', parts: [{ text: trimmedText }] });
  }

  return contents;
}

/**
 * Build rich system prompt with live inventory, images, page links, and business info
 */
async function buildSystemPrompt() {
  const [businessData, knowledgeData, puppyData] = await Promise.all([
    db.get('business_info'),
    db.get('ai_knowledge'),
    db.get('puppies')
  ]);
  const business = businessData || {};
  const aiKnowledge = knowledgeData || {};
  const puppies = puppyData || [];

  const availablePuppies = puppies
    .filter(p => p.status === 'Available')
    .map(p => {
      const lines = [
        `- ${p.name} (${p.breed}, ${p.gender}): $${p.price?.toLocaleString()}`,
        `  Color: ${p.color} | Weight: ${p.weight || 'N/A'} | Born: ${p.birth_date || 'N/A'}`,
        `  About: ${p.description || ''}`,
        `  Photo: ${p.image_url || 'N/A'}`,
        `  Product page: ${p.page_url || 'N/A'}`,
        `  PupID: ${p.id}`
      ];
      return lines.join('\n');
    })
    .join('\n\n');

  const faqsList = (aiKnowledge.faqs || [])
    .map(f => `Q: ${f.question}\nA: ${f.answer}`)
    .join('\n\n');

  return `You are the Plush Pups Concierge, a warm, polite, and caring virtual assistant for "Plush Pups by Reed", a premier breeder specializing in home-raised Cavapoos, Toy Maltipoos, and Miniature Poodles.

CORE PERSONALITY & GUIDELINES:
1. Warm, human-like, and conversational: Sound like an attentive, friendly adoption concierge typing live in a chat. Never sound robotic or copy-paste identical paragraphs.
2. Understand greetings naturally: For "hello", "hi", "good morning", "hey", warmly welcome the customer and ask how you can help them find their perfect puppy today.
3. Forgiving of spelling mistakes: Seamlessly understand typos like "cavapo", "maltipo", "podle", "shippng", "how mch" without pointing them out.
4. Memory & Context: Remember previous messages in this conversation. If the customer previously mentioned a breed, size, or gender preference, keep that in mind when answering follow-up questions.
5. Truthful & Grounded: ONLY state verified facts from the business details and live puppy inventory below. NEVER invent puppy names, prices, or medical information. If unsure, offer to connect them with Reed (the owner).
6. Transparency: Never pretend to be a human. If asked, state you are the Plush Pups virtual concierge, and you can connect them directly with Reed at any time.
7. Helpful Follow-Ups: Ask relevant, natural follow-up questions when helpful (e.g. "Are you looking for a boy or girl?", "Do you have a specific size in mind?").
8. Formatting: Keep responses conversational, concise, and easy to read on mobile. Use natural paragraphs and tasteful emojis (🐾, 🐶, ❤️, ✨). DO NOT use markdown bold (**) or headers (###).

LIVE PUPPY INVENTORY (CURRENTLY AVAILABLE):
${availablePuppies || 'No puppies currently available. Contact us about upcoming litters.'}

BUSINESS DETAILS & POLICIES:
- Business: ${business.name || 'Plush Pups by Reed'}
- Phone/Text: ${business.phone || '+1 (979) 346-6792'}
- Email: ${business.email || 'plushpupsbyreed08@gmail.com'}
- Location: ${business.address || 'Reed Family Kennel, North Carolina, USA'}
- Hours: ${business.hours || 'Mon - Sat: 9:00 AM - 7:00 PM EST | Sun: 10:00 AM - 5:00 PM EST'}
- Health Guarantee: ${business.health_guarantee || '2-Year Comprehensive Genetic Health Guarantee. All puppies arrive vaccinated, dewormed, and microchipped with a full vet health certificate.'}
- Nationwide Delivery: ${business.shipping_policy || 'Flight Nanny delivery available nationwide directly to your local airport or door. Local pickup is also welcome by appointment.'}
- All Puppies Directory: /category/all-products.html

FREQUENTLY ASKED QUESTIONS:
${faqsList}

INTERACTIVE CARD DISPLAY RULES:
- When discussing or recommending a specific puppy, include their card tag: [CARD:PupID] (e.g. [CARD:pup_1], [CARD:pup_2]). This dynamically renders a rich card with photo and reservation link in the customer's chat.
- When a customer asks to see all puppies, include [CARD:all] or the tags of the available puppies.
- When discussing reservations or deposits, share the puppy's product page link so they can easily secure their puppy.`;
}

/**
 * Intelligent, dynamic fallback response when Gemini is unreachable
 */
async function generateFallbackResponse(customerText) {
  const text = (customerText || '').toLowerCase().trim();
  const [puppyData, businessData, knowledgeData] = await Promise.all([
    db.get('puppies'),
    db.get('business_info'),
    db.get('ai_knowledge')
  ]);
  const puppies = (puppyData || []).filter(p => p.status === 'Available');
  const business = businessData || {};
  const faqs = knowledgeData?.faqs || [];

  // Match FAQs first
  for (const faq of faqs) {
    const qLower = faq.question.toLowerCase();
    const words = qLower.split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => text.includes(w));
    if (matches.length >= 2 || text.includes(qLower)) {
      return faq.answer;
    }
  }

  // Helper for random choice
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // 1. Natural greetings
  const greetings = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'howdy', 'greetings'];
  if (greetings.some(g => text === g || text.startsWith(g + ' ') || text.startsWith(g + '!'))) {
    const welcomes = [
      `Hi there! 🐾 Welcome to Plush Pups by Reed! How can I help you find your dream puppy today?`,
      `Hello! 🐶 So glad you stopped by! Are you looking for a Cavapoo, Toy Maltipoo, or Miniature Poodle?`,
      `Hi! 🐾 Welcome to Plush Pups! We have some wonderful puppies available right now. What breed are you most interested in?`
    ];
    return pick(welcomes);
  }

  // 2. Photos, images, show me
  if (text.includes('photo') || text.includes('picture') || text.includes('image') || text.includes('show me') || text.includes('see')) {
    if (puppies.length > 0) {
      const cards = puppies.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are photos of our available puppies right now! 🐾\n\n${cards}\n\nYou can tap any card to view their full photo gallery and details. Let me know if one catches your heart! ❤️`;
    }
    return `We don't have available puppies listed right this moment, but we have upcoming litters soon! Reach out to us at ${business.phone || '+1 (979) 346-6792'} to join our priority waitlist. 🐾`;
  }

  // 3. Cavapoo inquiries (with typo tolerance)
  if (text.includes('cavapoo') || text.includes('cavapo') || text.includes('cava poo')) {
    const cavapoos = puppies.filter(p => p.breed.toLowerCase().includes('cavapoo'));
    if (cavapoos.length > 0) {
      const cards = cavapoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `We currently have ${cavapoos.length} adorable Cavapoo ${cavapoos.length === 1 ? 'puppy' : 'puppies'} available! 🐾\n\n${cards}\n\nOur Cavapoos are home-raised, hypoallergenic, and come with our 2-Year Health Guarantee. Would you like to know more about reserving one?`;
    }
    return `Our Cavapoo puppies are very popular! We don't have any Cavapoos looking for homes right now, but we have new litters expected soon. Would you like to get on our notification list? 🐾`;
  }

  // 4. Maltipoo inquiries (with typo tolerance)
  if (text.includes('maltipoo') || text.includes('maltipo') || text.includes('malti poo')) {
    const maltipoos = puppies.filter(p => p.breed.toLowerCase().includes('maltipoo'));
    if (maltipoos.length > 0) {
      const cards = maltipoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our precious Toy Maltipoo puppies! 🐶\n\n${cards}\n\nThey are non-shedding, sweet-tempered, and love cuddles. Tap any card to see their details!`;
    }
    return `We specialize in gorgeous Toy Maltipoos! All current litters are currently reserved, but you can text us at ${business.phone || '+1 (979) 346-6792'} to hear about upcoming pups. ✨`;
  }

  // 5. Poodle inquiries (with typo tolerance)
  if (text.includes('poodle') || text.includes('podle') || text.includes('miniature poodle')) {
    const poodles = puppies.filter(p => p.breed.toLowerCase().includes('poodle'));
    if (poodles.length > 0) {
      const cards = poodles.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our intelligent, loving Poodle puppies! 🐩\n\n${cards}\n\nAll of them are vet-checked, microchipped, and raised with early socialization. Would you like to reserve one?`;
    }
    return `Our Miniature Poodles are intelligent and allergy-friendly! Text us at ${business.phone || '+1 (979) 346-6792'} for upcoming Poodle litter announcements. 🐩`;
  }

  // 6. Availability inquiries
  if (text.includes('available') || text.includes('what puppies') || text.includes('who is ready') || text.includes('any puppies')) {
    if (puppies.length > 0) {
      const cards = puppies.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are all of our available puppies ready to find their forever homes! 🐾\n\n${cards}\n\nAre you looking for a particular breed or gender?`;
    }
    return `All of our current puppies have found wonderful homes! New litters are arriving soon. Please contact us at ${business.email || 'plushpupsbyreed08@gmail.com'} to reserve early. 🐾`;
  }

  // 7. Pricing inquiries
  if (text.includes('price') || text.includes('cost') || text.includes('how much') || text.includes('prce') || text.includes('fee')) {
    const prices = puppies.map(p => p.price).filter(Boolean);
    const min = prices.length ? Math.min(...prices) : 2100;
    const max = prices.length ? Math.max(...prices) : 2800;
    return `Our puppies range from $${min.toLocaleString()} to $${max.toLocaleString()} depending on breed, coat color, and size. Every adoption includes all age-appropriate vaccinations, microchip, deworming, and our 2-Year Comprehensive Genetic Health Guarantee! 🛡️\n\nIs there a specific puppy you'd like pricing on?`;
  }

  // 8. Shipping & Delivery
  if (text.includes('ship') || text.includes('deliver') || text.includes('flight') || text.includes('transport') || text.includes('travel') || text.includes('pickup')) {
    return `🚚 ${business.shipping_policy || 'We provide nationwide Flight Nanny delivery straight to your local airport or door! Local pickup is also welcome by appointment at our North Carolina kennel.'}\n\nWhat city or airport are you located near? I can give you more details on delivery to your area! ✈️`;
  }

  // 9. Health Guarantee / Vet care
  if (text.includes('health') || text.includes('guarantee') || text.includes('vaccin') || text.includes('shot') || text.includes('vet') || text.includes('deworm')) {
    return `🛡️ Every Plush Pups puppy comes with our comprehensive 2-Year Genetic Health Guarantee. Before joining your family, each puppy receives full vet examinations, age-appropriate vaccines, deworming, and microchip documentation. We take health very seriously! ❤️`;
  }

  // 10. Reservation & Orders
  if (text.includes('reserve') || text.includes('deposit') || text.includes('order') || text.includes('buy') || text.includes('hold') || text.includes('adopt')) {
    return `To reserve your puppy, a deposit can be placed directly on their product page! Once reserved, we begin coordinating your delivery or pickup date. 🐾\n\nWould you like me to share the link to a specific puppy?`;
  }

  // 11. Conversational Default
  const conversationalDefaults = [
    `I'd love to help you with that! At Plush Pups by Reed, we specialize in premium Cavapoos, Toy Maltipoos, and Miniature Poodles. Are you interested in seeing who is available, or do you have a question about shipping and pricing? 🐾`,
    `Happy to help! 🐶 We have home-raised puppies with a 2-Year Health Guarantee and nationwide delivery. Tell me what breed or details you are looking for!`,
    `I'm here to help you find your dream puppy! 🐾 Ask me about our available puppies, pricing, delivery options, or type "human" if you'd like to talk directly with Reed.`
  ];
  return pick(conversationalDefaults);
}

/**
 * Main AI response generator with human takeover detection, fast Gemini AI, and intelligent dynamic fallback
 */
async function generateAIResponse(customerText, sessionHistory = [], businessId = 'biz_001') {
  const text = (customerText || '').toLowerCase().trim();
  const [businessData, knowledgeData] = await Promise.all([
    db.get('business_info'),
    db.get('ai_knowledge')
  ]);
  const business = businessData || {};

  // 1. Human takeover keywords
  const humanKeywords = [
    'human', 'person', 'owner', 'reed', 'talk to someone', 'real agent',
    'representative', 'speak with someone', 'call me', 'phone number', 'live support',
    'speak with human', 'speak with a person'
  ];
  if (humanKeywords.some(k => text.includes(k))) {
    return {
      text: `Certainly! I will connect you with Reed right now. 🐾 You can also call or text us directly at ${business.phone || '+1 (979) 346-6792'} or email ${business.email || 'plushpupsbyreed08@gmail.com'}. An owner will be with you shortly!`,
      requestTakeover: true
    };
  }

  // 2. High-speed Gemini AI response (flash-lite models benchmarked ~1.4s)
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const contents = formatHistory(sessionHistory, customerText);
      const systemPrompt = await buildSystemPrompt();
      const aiReply = await queryGemini(contents, systemPrompt, apiKey);
      if (aiReply) {
        return { text: aiReply, requestTakeover: false };
      }
    } catch (err) {
      console.error('[AI Engine] Gemini query error:', err.message);
    }
  }

  // 3. Dynamic contextual fallback
  const fallbackText = await generateFallbackResponse(customerText);
  return { text: fallbackText, requestTakeover: false };
}

module.exports = { generateAIResponse };
