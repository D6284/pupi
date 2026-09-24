const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'db.json');

// Default initial state
const defaultData = {
  admin_settings: {
    // Default admin code is: "admin123"
    hashed_code: bcrypt.hashSync('admin123', 10),
    inactivity_timeout_mins: 30,
    jwt_secret: 'plush_pups_super_secret_jwt_key_2026_' + Math.random().toString(36).substring(2)
  },
  business_info: {
    id: 'biz_001',
    name: 'Plush Pups by Reed',
    phone: '+1 (979) 346-6792',
    email: 'plushpupsbyreed08@gmail.com',
    hours: 'Mon - Sat: 9:00 AM - 7:00 PM EST | Sun: 10:00 AM - 5:00 PM EST',
    address: 'Reed Family Kennel, North Carolina, USA',
    health_guarantee: '2-Year Comprehensive Genetic Health Guarantee. All puppies arrive vaccinated, dewormed, and microchipped with a full vet health certificate.',
    shipping_policy: 'Flight Nanny delivery available nationwide directly to your local airport or door. Local pickup is also welcome by appointment.',
    about: 'We specialize in breeding premium, home-raised Toy Maltipoos, Cavapoos, and Miniature Poodles raised with love, care, and early socialization.'
  },
  whatsapp_settings: {
    business_id: 'biz_001',
    phone_number: '+19793466792',
    default_message: 'Hello! I am interested in adopting a puppy from Plush Pups by Reed.',
    enabled: true
  },
  chat_settings: {
    business_id: 'biz_001',
    widget_title: 'Plush Pups Concierge',
    primary_color: '#d97706',
    welcome_message: 'Hello! 🐾 Welcome to Plush Pups by Reed! How can we help you find your dream puppy today?',
    auto_open_delay: 5,
    offline_message: 'We are currently offline. Leave a message and our team will get back to you right away!'
  },
  notifications_settings: {
    business_id: 'biz_001',
    sound_enabled: true,
    desktop_notifs: true,
    email_alerts: true
  },
  ai_knowledge: {
    business_id: 'biz_001',
    system_prompt: `You are Plush Pups AI, a friendly, knowledgeable, and professional customer concierge for "Plush Pups by Reed", a high-end commercial puppy breeder specializing in Cavapoos, Toy Maltipoos, and Miniature Poodles.
    
Guidelines:
1. Always be warm, enthusiastic, polite, and helpful when talking about puppies.
2. Answer questions accurately using the inventory of available puppies, pricing, health guarantee, adoption process, and shipping options.
3. If a customer asks to speak with a human, book an appointment, or request custom pricing, offer to connect them with a live human representative.
4. Keep answers concise, clear, and easy to read.`,
    faqs: [
      {
        id: 'faq_1',
        question: 'What breeds do you offer?',
        answer: 'We specialize in hypoallergenic, home-raised Cavapoos, Toy Maltipoos, and Miniature Poodles.'
      },
      {
        id: 'faq_2',
        question: 'How does shipping and delivery work?',
        answer: 'We provide flight nanny transport straight to your nearest airport or home delivery nationwide. You can also arrange local pickup at our kennel.'
      },
      {
        id: 'faq_3',
        question: 'What comes with my adopted puppy?',
        answer: 'Each puppy comes with a 2-Year Health Guarantee, vet inspection report, current vaccinations & deworming, microchip, medical records, and a starter blanket with mom’s scent.'
      },
      {
        id: 'faq_4',
        question: 'How do I reserve a puppy?',
        answer: 'You can reserve any available puppy on our website by placing a deposit or contacting us directly through live chat or WhatsApp.'
      }
    ]
  },
  puppies: [
    {
      id: 'pup_1',
      business_id: 'biz_001',
      name: 'Baby Doll',
      breed: 'Small Miniature Poodle',
      gender: 'Female',
      price: 2200,
      status: 'Available',
      birth_date: '2026-01-10',
      weight: '3.2 lbs',
      color: 'Apricot / Red',
      image_url: '../static.wixstatic.com/media/c1934f_e36ea0ca6be9497ea281f7a0b0ddcf80_mv2.jpeg',
      description: 'Sweet and affectionate Small Miniature Poodle female. Loves cuddle time and gets along wonderfully with kids.'
    },
    {
      id: 'pup_2',
      business_id: 'biz_001',
      name: 'Charlotte',
      breed: 'Cavapoo',
      gender: 'Female',
      price: 2500,
      status: 'Available',
      birth_date: '2026-01-14',
      weight: '3.8 lbs',
      color: 'Ruby Red with White Chest',
      image_url: '../static.wixstatic.com/media/c1934f_e36ea0ca6be9497ea281f7a0b0ddcf80_mv2.jpeg',
      description: 'Playful and intelligent Cavapoo female. Hypoallergenic coat with gentle demeanor.'
    }
  ],
  orders: [],
  payments: [],
  customers: [],
  chats: [],
  messages: []
};

class DB {
  constructor() {
    this.data = defaultData;
    this.init();
  }

  init() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
        // Merge defaults
        this.data = { ...defaultData, ...this.data };
      } catch (err) {
        console.error('Error reading db.json, using defaultData:', err.message);
        this.save();
      }
    } else {
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error writing to db.json:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return this.data[key];
  }

  update(key, fn) {
    if (typeof fn === 'function') {
      this.data[key] = fn(this.data[key]);
      this.save();
    }
    return this.data[key];
  }
}

module.exports = new DB();
