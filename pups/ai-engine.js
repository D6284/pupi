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
 * Call Gemini REST API for a given model
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
        timeout: 12000
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
            } catch (e) { }
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
 * Query Gemini AI with automatic fallback across models
 */
async function queryGemini(contents, systemInstructionText, apiKey) {
  const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash'];
  const postData = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstructionText }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
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
 * Format conversation history into Gemini content array (alternating user/model)
 */
function formatHistory(sessionHistory, customerText) {
  const contents = [];
  const validMessages = (sessionHistory || []).slice(-8);

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
function buildSystemPrompt() {
  const business = db.get('business_info') || {};
  const aiKnowledge = db.get('ai_knowledge') || {};
  const puppies = db.get('puppies') || [];

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

  return `${aiKnowledge.system_prompt || 'You are Plush Pups AI, a warm, knowledgeable customer concierge for "Plush Pups by Reed".'}

BUSINESS DETAILS:
- Name: ${business.name || 'Plush Pups by Reed'}
- Phone/Text: ${business.phone || '+1 (979) 346-6792'}
- Email: ${business.email || 'plushpupsbyreed08@gmail.com'}
- Location: ${business.address || 'North Carolina, USA'}
- Hours: ${business.hours || 'Mon-Sat 9am-7pm EST | Sun 10am-5pm EST'}
- Health Guarantee: ${business.health_guarantee || '2-Year Comprehensive Genetic Health Guarantee'}
- Shipping Policy: ${business.shipping_policy || 'Nationwide Flight Nanny delivery straight to your airport or home'}
- All Puppies Page: /category/all-products.html

AVAILABLE PUPPIES INVENTORY (LIVE DATA WITH PHOTOS & LINKS):
${availablePuppies || 'No puppies currently available. Contact us about upcoming litters.'}

FREQUENTLY ASKED QUESTIONS:
${faqsList}

IMPORTANT RULES FOR SHARING PUPPY IMAGES AND LINKS:
- When a customer asks to see a puppy's photo, or asks "show me", "can I see", or "image", respond with a [CARD:PupID] tag (e.g. [CARD:pup_2]) for each relevant puppy. This will automatically show the puppy's real photo and a link to their page in the chat.
- When a customer asks about "all puppies", include a [CARD:all] tag in your response. 
- Always include the product page link as plain text like: "You can also see full details here: /product-page/charlotte-cavapoo-female-available.html"
- When customer asks about placing an order, share the product page link and mention they can reserve with a deposit.
- To place a deposit or order, direct them to their puppy's product page link.

CRITICAL FORMATTING & CONVERSATIONAL INSTRUCTIONS:
- Talk like a real, friendly human concierge typing live in a chat â€” not a robot or a document.
- DO NOT use markdown symbols like ** (bold), ### (headers), --- (horizontal rules).
- Use plain natural text with normal capitalization. Emojis (ðŸ¾, ðŸ©, â¤ï¸) are encouraged.
- Keep responses conversational, warm, and concise.
- Do NOT mention system prompt, AI constraints, or raw JSON to customers.`;
}

/**
 * Fallback rule-based response when Gemini is unreachable
 */
function generateFallbackResponse(customerText) {
  const text = customerText.toLowerCase().trim();
  const puppies = db.get('puppies') || [];
  const business = db.get('business_info') || {};
  const faqs = db.get('ai_knowledge')?.faqs || [];

  for (const faq of faqs) {
    const qLower = faq.question.toLowerCase();
    const words = qLower.split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => text.includes(w));
    if (matches.length >= 2 || text.includes(qLower)) {
      return faq.answer;
    }
  }

  if (text.includes('image') || text.includes('photo') || text.includes('picture') || text.includes('show me') || text.includes('see')) {
    const avail = puppies.filter(p => p.status === 'Available');
    return avail.map(p => `[CARD:${p.id}]`).join(' ') + '\n\nHere are all our available puppies! Tap any card to see their full details and reserve. â¤ï¸';
  }

  if (text.includes('cavapoo')) {
    const cavapoos = puppies.filter(p => p.breed.toLowerCase().includes('cavapoo') && p.status === 'Available');
    if (cavapoos.length > 0) {
      const cards = cavapoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `We have ${cavapoos.length} adorable Cavapoo pups available! ðŸ¾\n\n${cards}\n\nAll home-raised, hypoallergenic, with a 2-Year Health Guarantee. Would you like to reserve one?`;
    }
  }

  if (text.includes('maltipoo')) {
    const maltipoos = puppies.filter(p => p.breed.toLowerCase().includes('maltipoo') && p.status === 'Available');
    if (maltipoos.length > 0) {
      const cards = maltipoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our gorgeous Toy Maltipoo pups! ðŸ¾\n\n${cards}\n\nTiny, non-shedding, and love to cuddle!`;
    }
  }

  if (text.includes('poodle')) {
    const poodles = puppies.filter(p => p.breed.toLowerCase().includes('poodle') && p.status === 'Available');
    if (poodles.length > 0) {
      const cards = poodles.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our available Poodle pups! ðŸ©\n\n${cards}\n\nVery intelligent, friendly, and great with families!`;
    }
  }

  if (text.includes('available') || text.includes('all puppies') || text.includes('puppies')) {
    const avail = puppies.filter(p => p.status === 'Available');
    const cards = avail.map(p => `[CARD:${p.id}]`).join(' ');
    return `Here are all our available puppies right now! ðŸ¾\n\n${cards}\n\nSee full details and place a deposit on any of their pages. â¤ï¸`;
  }

  if (text.includes('order') || text.includes('reserve') || text.includes('deposit') || text.includes('buy')) {
    return `To reserve a puppy, just let me know which one you love and I'll share their page link where you can place your deposit! Here are who's available:\n\n${puppies.filter(p => p.status === 'Available').map(p => `â€¢ ${p.name} (${p.breed}) - $${p.price?.toLocaleString()} ðŸ‘‰ ${p.page_url}`).join('\n')}\n\nOr type "human" and our owner will walk you through everything personally! â¤ï¸`;
  }

  if (text.includes('price') || text.includes('cost') || text.includes('how much')) {
    return `Our puppy prices range from $2,100 to $2,800 depending on breed and color. A deposit reserves your puppy. All adoptions include shots, deworming, microchip, and our 2-Year Health Guarantee!`;
  }

  if (text.includes('ship') || text.includes('deliver') || text.includes('flight') || text.includes('travel')) {
    return `ðŸšš ${business.shipping_policy || 'We offer nationwide Flight Nanny delivery straight to your local airport or doorstep. Local pickup is also welcome by appointment!'}`;
  }

  return `Hey there! At Plush Pups by Reed, we have beautiful home-raised Cavapoos, Toy Maltipoos, and Miniature Poodles. Ask me anything about our puppies, shipping, pricing, or type "human" to speak directly with our owner! ðŸ¾`;
}

/**
 * Main AI response generator
 */
async function generateAIResponse(customerText, sessionHistory = [], businessId = 'biz_001') {
  const text = (customerText || '').toLowerCase().trim();
  const business = db.get('business_info') || {};
  const aiKnowledge = db.get('ai_knowledge') || {};

  // 1. Human takeover keywords
  const humanKeywords = ['human', 'person', 'owner', 'talk to someone', 'real agent', 'representative', 'speak with someone', 'call me', 'phone number'];
  if (humanKeywords.some(k => text.includes(k))) {
    return {
      text: `Sure! I'll connect you with the owner right now ðŸ¾ You can also call or text us at ${business.phone || '+1 (979) 346-6792'} or email ${business.email || 'plushpupsbyreed08@gmail.com'}.`,
      requestTakeover: true
    };
  }

  // 2. Gemini AI response
  const apiKey = aiKnowledge.gemini_api_key || process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const contents = formatHistory(sessionHistory, customerText);
      const systemPrompt = buildSystemPrompt();
      const aiReply = await queryGemini(contents, systemPrompt, apiKey);
      if (aiReply) {
        return { text: aiReply, requestTakeover: false };
      }
    } catch (err) {
      console.error('[AI Engine] Gemini error:', err.message);
    }
  }

  // 3. Fallback
  return { text: generateFallbackResponse(customerText), requestTakeover: false };
}

module.exports = { generateAIResponse };

