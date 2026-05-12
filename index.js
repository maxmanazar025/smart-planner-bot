require('dotenv').config();

const { Bot } = require('grammy');
const http = require('http');
const db = require('./db');
const cron = require('node-cron');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN in environment. Please set it in your .env file.');
  process.exit(1);
}

const bot = new Bot(token);

// In-memory user state to capture the next message as plan content.
// Structure: Map<telegramId, { expecting: 'plan', plan_type: 'daily'|'monthly'|'yearly' }>
const userStates = new Map();

// Extended state: when user submits text, we ask for priority before saving.
// state = { expecting: 'plan', plan_type, pendingContent }

// Main menu keyboard (shown to subscribed users)
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['📅 Kunlik', '🗓 Oylik', '🏆 Yillik'],
      ['📋 Rejalarim', '🗑 Tozalash']
    ],
    resize_keyboard: true
  }
};

// Helper to escape HTML in user content
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Helper to coerce various DB representations into a boolean
function parseBool(val) {
  if (val === true || val === 1 || val === '1') return true;
  if (val === false || val === 0 || val === '0') return false;
  if (typeof val === 'string') {
    const v = val.toLowerCase();
    return v === 'true' || v === 't' || v === 'yes' || v === 'y' || v === '1';
  }
  return Boolean(val);
}

// Subscription-check middleware
bot.use(async (ctx, next) => {
  try {
    // Allow start, pay, status and help commands through without subscription check
    const text = (ctx.message && ctx.message.text) || (ctx.updateType === 'callback_query' && ctx.callbackQuery.data) || '';
    const cmd = typeof text === 'string' ? text.split(' ')[0].trim().toLowerCase() : '';
    if (cmd === '/start' || cmd === '/pay' || cmd === '/status' || cmd === '/help') {
      return next();
    }

    const from = ctx.from;
    if (!from) return next();

    const telegramId = from.id;

    const res = await db.query('SELECT subscription_status, subscription_end_date FROM users WHERE telegram_id = $1', [telegramId]);
    if (res.rowCount === 0) {
      await ctx.reply("⚠️ Siz ro'yxatdan o'tmagansiz. Ro'yxatdan o'tish uchun /start buyrug'ini bosing.");
      return; // stop further middleware/handlers
    }

  const user = res.rows[0];
  const isSubscribed = parseBool(user.subscription_status);

    // If there's an end date and it's passed, expire the subscription
    if (user.subscription_end_date && new Date(user.subscription_end_date) < new Date()) {
      await db.query('UPDATE users SET subscription_status = $1 WHERE telegram_id = $2', [false, telegramId]);
      await ctx.reply("⚠️ Sizning obunangiz muddati tugagan. Yangilash uchun /pay buyrug'ini bosing.");
      return;
    }

    if (!isSubscribed) {
      await ctx.reply("⚠️ Botdan foydalanish uchun obuna bo'lishingiz kerak. To'lov qilish uchun /pay buyrug'ini bosing.");
      return; // block access
    }

    // user is subscribed and not expired
    return next();
  } catch (err) {
    console.error('Subscription middleware error:', err);
    // On error, be permissive to avoid locking all users out
    return next();
  }
});

// /start command: check if user exists, otherwise create
bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return; // shouldn't happen for commands

  const telegramId = from.id;
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ');

  try {
    // Try to insert the user atomically. If a user with the same telegram_id exists, do nothing.
    const insertRes = await db.query(
      'INSERT INTO users (telegram_id, full_name, subscription_status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (telegram_id) DO NOTHING RETURNING id',
      [telegramId, fullName || null, false]
    );

    if (insertRes.rowCount > 0) {
      await ctx.reply(`Welcome, ${fullName || 'there'}! Your account has been created. Use /help to see available commands.`);
    } else {
      // User already exists (or was inserted concurrently); confirm existence and welcome back.
      const res = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
      if (res.rowCount === 0) {
        // This is unexpected, but handle gracefully by informing the user.
        await ctx.reply(`Welcome, ${fullName || 'there'}! Your account creation is pending. Please try again.`);
      } else {
        await ctx.reply(`Welcome back, ${fullName || 'there'}!`);
      }
    }
  } catch (err) {
    console.error('DB error in /start handler:', err);
    await ctx.reply('Sorry, I had trouble accessing your account. Please try again later.');
  }
});

bot.command('help', (ctx) => {
  ctx.reply("Available commands:\n/start - register or welcome back\n/help - this message\n/pay - subscribe for 30 days\n/status - check subscription status");
});

// /pay command: set subscription_status true and subscription_end_date to now + 30 days
bot.command('pay', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id;
  try {
    const res = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
    if (res.rowCount === 0) {
      await ctx.reply("Siz ro'yxatdan o'tmagansiz. Iltimos /start buyrug'i orqali ro'yxatdan o'ting.");
      return;
    }

    const upd = await db.query(
      "UPDATE users SET subscription_status = $1, subscription_end_date = NOW() + INTERVAL '30 days' WHERE telegram_id = $2 RETURNING subscription_status, subscription_end_date",
      [true, telegramId]
    );

    const newStatus = upd.rows[0] && parseBool(upd.rows[0].subscription_status);
    console.log('Updated subscription for', telegramId, 'status:', upd.rows[0]);

    if (newStatus) {
      await ctx.reply('✅ To\'lov muvaffaqiyatli! Endi rejalaringizni boshqarishingiz mumkin.', mainMenu);
    } else {
      await ctx.reply('To\'lov amalga oshirildi, ammo serverda holat yangilanmadi. Iltimos keyinroq tekshiring.');
    }
  } catch (err) {
    console.error('DB error in /pay handler:', err);
    await ctx.reply('To\'lovni amalga oshirishda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
});

// /status command: show subscription end date or status
bot.command('status', async (ctx) => {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id;
  try {
    const res = await db.query('SELECT subscription_status, subscription_end_date FROM users WHERE telegram_id = $1', [telegramId]);
    if (res.rowCount === 0) {
      await ctx.reply("Siz ro'yxatdan o'tmagansiz. Iltimos /start buyrug'i orqali ro'yxatdan o'ting.");
      return;
    }

    const user = res.rows[0];
    if (user.subscription_status === true) {
      if (user.subscription_end_date) {
        await ctx.reply(`✅ Siz obunaga egasiz. Obuna muddati: ${new Date(user.subscription_end_date).toLocaleString()}`);
      } else {
        await ctx.reply('✅ Siz obunaga egasiz. Amaldagi tugash sanasi mavjud emas.');
      }
    } else {
      await ctx.reply("❌ Siz hozirda obunaga ega emassiz. Yangilash uchun /pay buyrug'ini bosing.");
    }
  } catch (err) {
    console.error('DB error in /status handler:', err);
    await ctx.reply('Holatni tekshirishda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
});

// Show main menu to subscribed users via a command
bot.command('menu', async (ctx) => {
  await ctx.reply('Asosiy menyu:', mainMenu);
});

// Handlers for plan buttons
bot.hears('📅 Kunlik', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  userStates.set(from.id, { expecting: 'plan', plan_type: 'daily' });
  await ctx.reply('Rejangizni yuboring');
});

bot.hears('🗓 Oylik', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  userStates.set(from.id, { expecting: 'plan', plan_type: 'monthly' });
  await ctx.reply('Rejangizni yuboring');
});

bot.hears('🏆 Yillik', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  userStates.set(from.id, { expecting: 'plan', plan_type: 'yearly' });
  await ctx.reply('Rejangizni yuboring');
});

// Handler for listing plans
bot.hears('📋 Rejalarim', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = from.id;
  try {
    const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
    if (userRes.rowCount === 0) {
      await ctx.reply("Siz ro'yxatdan o'tmagansiz. Iltimos /start buyrug'i orqali ro'yxatdan o'ting.");
      return;
    }

  // plans.telegram_id stores the Telegram ID
  const plansRes = await db.query('SELECT id, content, plan_type, is_completed, created_at FROM plans WHERE telegram_id = $1 AND is_completed = false ORDER BY created_at DESC', [telegramId]);
    if (plansRes.rowCount === 0) {
      await ctx.reply('Sizda hozircha faol (active) rejalar mavjud emas.');
      return;
    }

    // group by type
    const groups = { daily: [], monthly: [], yearly: [] };
    for (const p of plansRes.rows) {
      const key = (p.plan_type || '').toLowerCase();
      if (key === 'daily' || key === 'kunlik') groups.daily.push(p);
      else if (key === 'monthly' || key === 'oylik') groups.monthly.push(p);
      else if (key === 'yearly' || key === 'yillik') groups.yearly.push(p);
      else groups.daily.push(p);
    }

    // Build an HTML-formatted message with bold section headers
    let parts = [];
    const fmt = (p) => `• ${escapeHtml(p.content)} ${p.is_completed ? '✅' : ''}`;
    if (groups.daily.length) {
      parts.push('<b>📅 Kunlik</b>');
      parts.push(groups.daily.map(fmt).join('\n'));
    }
    if (groups.monthly.length) {
      parts.push('<b>🗓 Oylik</b>');
      parts.push(groups.monthly.map(fmt).join('\n'));
    }
    if (groups.yearly.length) {
      parts.push('<b>🏆 Yillik</b>');
      parts.push(groups.yearly.map(fmt).join('\n'));
    }

    const out = parts.join('\n\n');
    await ctx.reply(out || 'Sizda faol rejalar mavjud emas.', { parse_mode: 'HTML' });
  } catch (err) {
    console.error('DB error in Rejalarim handler:', err);
    await ctx.reply('Rejalarni olishda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
});

// Message handler to capture plan content when user is in expecting state
bot.on('message', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const state = userStates.get(from.id);
  if (!state || state.expecting !== 'plan') return; // not expecting a plan

  const content = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : null;
  if (!content) {
    await ctx.reply('Iltimos, matn ko\'rinishida reja yuboring.');
    return;
  }

  // Validate length
  if (content.length > 500) {
    await ctx.reply('Iltimos, reja matni 500 belgidan kam bo\'lsin.');
    return;
  }

  // persist plan
  try {
    const userRes = await db.query('SELECT id FROM users WHERE telegram_id = $1', [from.id]);
    if (userRes.rowCount === 0) {
      await ctx.reply("Siz ro'yxatdan o'tmagansiz. Iltimos /start buyrug'i orqali ro'yxatdan o'tинг.");
      userStates.delete(from.id);
      return;
    }

    // Normalize plan_type to expected values
    let planType = (state.plan_type || '').toString().toLowerCase();
    if (planType === 'kunlik') planType = 'daily';
    if (planType === 'oylik') planType = 'monthly';
    if (planType === 'yillik') planType = 'yearly';
    if (!['daily', 'monthly', 'yearly'].includes(planType)) planType = 'daily';

    // Ask for priority before saving
    userStates.set(from.id, { expecting: 'priority', plan_type: planType, pendingContent: content });
    const prioKb = {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔴 Muhim', callback_data: 'priority:high' },
          { text: '🟡 O\'rtacha', callback_data: 'priority:medium' },
          { text: '🟢 Oddiy', callback_data: 'priority:low' }
        ]]
      }
    };
    await ctx.reply('Bu vazifa qanchalik muhim?', prioKb);
    // do not delete the state here; wait for the priority callback to save the plan
  } catch (err) {
    // Print the exact DB error to the terminal for debugging
    console.error(err);
    await ctx.reply('Rejani saqlashda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
    userStates.delete(from.id);
  }
});

// /ai command - analyze current active plans and return a 2-sentence motivational/advice message
bot.command('ai', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const telegramId = from.id;
  try {
    const plansRes = await db.query('SELECT content, plan_type FROM plans WHERE telegram_id = $1 AND is_completed = false ORDER BY created_at ASC', [telegramId]);
    if (plansRes.rowCount === 0) {
      await ctx.reply('Faol rejalar topilmadi. Iltimos avval reja qo\'shing.');
      return;
    }

    const tasksSummary = plansRes.rows.map((p, i) => `${i + 1}. (${p.plan_type}) ${p.content}`).join('\n');

    // If GEMINI_API_KEY is not set, fallback to a simple heuristic reply
    if (!process.env.GEMINI_API_KEY) {
      const summary = tasksSummary;
      await ctx.reply(`Sizning aktiv rejalaringiz:\n${summary}\n\nQisqacha maslahat: tanlang eng muhim bir vazifani va uni 25 daqiqaga ajrating (Pomodoro).`);
      return;
    }

  // Build a concise prompt asking for exactly two sentences in Uzbek
  const prompt = `Siz do'stona mahsuldorlik murabbiyisiz. Quyidagi vazifalar ro'yxatini hisobga olgan holda, aniq va qisqa ikki jumlali motivatsion/maslahat xabarini yuboring (raqamlash yoki qo'shimcha sharh qo'shmang). Vazifalar:\n${tasksSummary}\n\nIltimos, javobni aniq ikkita jumlada yuboring va javob O'zbek tilida bo'lsin.`;

    // Try to load a supported client library. Support either '@google-ai/generativelanguage' or 'google-generative-ai'.
    let TextServiceClient = null;
    try {
      TextServiceClient = require('@google-ai/generativelanguage').TextServiceClient;
    } catch (e1) {
      try {
        TextServiceClient = require('google-generative-ai').TextServiceClient;
      } catch (e2) {
        TextServiceClient = null;
      }
    }

    if (!TextServiceClient) {
      await ctx.reply('AI kutubxonasi o\'rnatilmagan. Iltimos `npm install @google-ai/generativelanguage` (yoki `google-generative-ai`) deb o\'rnatib, qaytadan urinib ko\'ring.');
      return;
    }

    try {
      const client = new TextServiceClient({ apiKey: process.env.GEMINI_API_KEY });

      // Try a few invocation shapes depending on client version. We stop at the first successful non-empty result.
      let aiResponse = null;

      // 1) generateText with model + input or prompt
      try {
        if (client.generateText) {
          // some clients accept { model, input } or { model, prompt }
          try {
            aiResponse = await client.generateText({ model: 'models/text-bison-001', input: prompt });
          } catch (e) {
            aiResponse = await client.generateText({ model: 'models/text-bison-001', prompt });
          }
        }
      } catch (errGen) {
        // ignore and try next
      }

      // 2) generate (alternative name)
      if (!aiResponse && client.generate) {
        try { aiResponse = await client.generate({ model: 'models/text-bison-001', prompt }); } catch (e) { /* ignore */ }
      }

      // 3) some clients return an array or different wrapper
      if (!aiResponse && typeof client === 'function') {
        try { aiResponse = await client(prompt); } catch (e) { /* ignore */ }
      }

      // Extract text from the various possible response shapes
      let advice = '';
      if (aiResponse) {
        // common shapes
        advice = aiResponse.text || aiResponse.output || aiResponse.content || '';
        if (!advice) {
          if (aiResponse.result && aiResponse.result.candidates && aiResponse.result.candidates[0]) {
            advice = aiResponse.result.candidates[0].content || aiResponse.result.candidates[0].message || '';
          }
          if (!advice && aiResponse.candidates && aiResponse.candidates[0]) {
            const cand = aiResponse.candidates[0];
            advice = cand.output?.[0]?.content || cand.content || cand.message?.content || '';
          }
        }
      }

      // As a last resort, stringify a small portion of the response
      if (!advice) advice = (typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse)).slice(0, 1000);

      // Ensure we send only two sentences. Split on punctuation while preserving sentences.
      const sentenceMatch = advice.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [advice];
      const twoSentences = sentenceMatch.slice(0, 2).join(' ').trim();

      // If model returned nothing meaningful, fallback to heuristic
      if (!twoSentences || twoSentences.length === 0) {
        await ctx.reply('AI javob bera olmadi. Mana qisqacha maslahat: tanlang eng muhim vazifa va unga 25 daqiqa bag\'ishlang.');
      } else {
        await ctx.reply(twoSentences);
      }
    } catch (aiErr) {
      console.error('Gemini AI error:', aiErr);
      await ctx.reply('AI yordamida tahlil qilishda xatolik yuz berdi. Iltimos keyinroq urinib ko\'ring.');
    }
  } catch (err) {
    console.error('Error in /ai handler:', err);
    await ctx.reply('AI tahlilida xatolik yuz berdi.');
  }
});

// /clear command to delete all completed plans for the user
bot.command('clear', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  try {
  await db.query('DELETE FROM plans WHERE telegram_id = $1 AND is_completed = true', [from.id]);
    await ctx.reply('Barcha bajatilgan (completed) rejalar o\'chirildi.');
  } catch (err) {
    console.error('Error clearing completed plans:', err);
    await ctx.reply('Rejalarni tozalashda xatolik yuz berdi.');
  }
});

bot.hears('🗑 Tozalash', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  // Ask the user to confirm archive/delete options
  await ctx.reply('Tozalash: nimani xohlaysiz?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Arxivlanganlarni o\'chirish', callback_data: 'archive:confirm' }],
        [{ text: '❌ Bajarilmaganlarni o\'chirish', callback_data: 'archive:delete_uncompleted' }],
        [{ text: '↩️ Bekor qilish', callback_data: 'archive:cancel' }]
      ]
    }
  });
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

// Handle inline callback queries for completing or deleting plans
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const from = ctx.from;
  if (!from) return ctx.answerCallbackQuery({ text: 'Foydalanuvchi aniqlanmadi.' });

  const telegramId = from.id;
  const [action, idStr] = data.split(':');
  const planId = Number(idStr);
  if (!planId) return ctx.answerCallbackQuery({ text: "Noto'g'ri reja ID." });

  try {
    // Verify plan belongs to this user
    const planRes = await db.query('SELECT id, telegram_id, content, is_completed FROM plans WHERE id = $1', [planId]);
    if (planRes.rowCount === 0) {
      await ctx.answerCallbackQuery({ text: "Reja topilmadi." });
      return;
    }

    const plan = planRes.rows[0];
    if (String(plan.telegram_id) !== String(telegramId)) {
      await ctx.answerCallbackQuery({ text: "Bu rejaga ruxsatingiz yo'q." });
      return;
    }

    if (action === 'complete') {
      await db.query('UPDATE plans SET is_completed = true WHERE id = $1', [planId]);
      // Edit original message to say task completed
      try {
        await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, `Tabriklayman! Vazifa bajarildi\n\n${escapeHtml(plan.content)}`);
      } catch (e) {
        // Fallback: answer callback and send a new message
        await ctx.reply(`Tabriklayman! Vazifa bajarildi\n\n${escapeHtml(plan.content)}`);
      }
  await ctx.answerCallbackQuery({ text: "Vazifa belgilandi: bajarildi" });
    } else if (action === 'delete') {
      await db.query('DELETE FROM plans WHERE id = $1', [planId]);
      try {
        await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, `Vazifa o'chirildi\n\n${escapeHtml(plan.content)}`);
      } catch (e) {
        await ctx.reply(`Vazifa o'chirildi\n\n${escapeHtml(plan.content)}`);
      }
  await ctx.answerCallbackQuery({ text: "Vazifa o'chirildi" });
    } else {
      await ctx.answerCallbackQuery({ text: "Noma'lum amal." });
    }
  } catch (err) {
    console.error('Error handling callback query:', err);
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.' });
  }
});

// Additional callback handling: priority selection and archive confirmation
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const from = ctx.from;
  if (!from) return ctx.answerCallbackQuery({ text: 'Foydalanuvchi aniqlanmadi.' });
  const telegramId = from.id;

  // priority:high|medium|low
  if (data.startsWith('priority:')) {
    const priority = data.split(':')[1];
    const state = userStates.get(telegramId);
    if (!state || state.expecting !== 'priority') {
      await ctx.answerCallbackQuery({ text: 'Hech qanday reja kutilmayapti.' });
      return;
    }

    const content = state.pendingContent;
    const planType = state.plan_type || 'daily';
    try {
      const insertRes = await db.query('INSERT INTO plans (telegram_id, content, plan_type, priority) VALUES ($1, $2, $3, $4) RETURNING id', [telegramId, content, planType, priority]);
      const planId = insertRes.rows[0].id;
      // edit the priority prompt message to confirm
      try {
        await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, `Reja saqlandi. Priority: ${priority}`);
      } catch (e) {
        await ctx.reply(`Reja saqlandi. Priority: ${priority}`);
      }
      // send inline buttons for task management
      await ctx.reply('Bajarish imkoniyatlari:', {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Bajarildi', callback_data: `complete:${planId}` },
            { text: "🗑 O'chirish", callback_data: `delete:${planId}` }
          ]]
        }
      });
      userStates.delete(telegramId);
      await ctx.answerCallbackQuery({ text: 'Reja saqlandi.' });
    } catch (err) {
      console.error('Error saving plan with priority:', err);
      await ctx.answerCallbackQuery({ text: 'Rejani saqlashda xatolik yuz berdi.' });
    }
    return;
  }

  // archive:confirm and archive:delete_uncompleted
  if (data === 'archive:confirm') {
    try {
      const delRes = await db.query('DELETE FROM plans WHERE telegram_id = $1 AND is_completed = true RETURNING id', [telegramId]);
      const count = delRes.rowCount;
      await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, `Arxivlandi: ${count} ta reja o'chirildi.`);
      await ctx.answerCallbackQuery({ text: `${count} ta rejalar arxivlandi.` });
    } catch (err) {
      console.error('Error archiving completed plans:', err);
      await ctx.answerCallbackQuery({ text: 'Arxivlashda xatolik yuz berdi.' });
    }
    return;
  }

  if (data === 'archive:delete_uncompleted') {
    try {
      const delRes = await db.query('DELETE FROM plans WHERE telegram_id = $1 AND is_completed = false RETURNING id', [telegramId]);
      const count = delRes.rowCount;
      await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, `O'chirildi: ${count} ta bajarilmagan reja o'chirildi.`);
      await ctx.answerCallbackQuery({ text: `${count} ta bajarilmagan reja o'chirildi.` });
    } catch (err) {
      console.error('Error deleting uncompleted plans:', err);
      await ctx.answerCallbackQuery({ text: 'O\'chirishda xatolik yuz berdi.' });
    }
    return;
  }

  if (data === 'archive:cancel') {
    try {
      await ctx.api.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, 'Tozalash bekor qilindi.');
      await ctx.answerCallbackQuery({ text: 'Bekor qilindi.' });
    } catch (err) {
      console.error('Error handling archive cancel:', err);
      await ctx.answerCallbackQuery({ text: 'Bekor qilishda xatolik.' });
    }
    return;
  }
});

(async () => {
  try {
    console.log('Starting Smart Planner Bot...');
    // Simple HTTP server for Render (or other hosts) to detect an open port
    const port = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running');
    });
    server.listen(port, () => console.log(`HTTP server listening on ${port}`));
    // Schedule cron jobs
    // Daily at 00:00 - archive yesterday's daily plans
    cron.schedule('0 0 * * *', async () => {
      try {
        console.log('Running daily archive job...');
        // Mark daily plans created before today as completed
        const res = await db.query(
          "UPDATE plans SET is_completed = true WHERE plan_type = 'daily' AND is_completed = false AND created_at < date_trunc('day', NOW()) RETURNING telegram_id"
        );
        const telegramIds = [...new Set(res.rows.map(r => r.telegram_id))];
        for (const tg of telegramIds) {
          // plans.user_id stores Telegram IDs now, send directly
          try {
            await bot.api.sendMessage(tg, "Yangi kun boshlandi! Kechagi rejalaringiz arxivga o'tkazildi.");
          } catch (sendErr) {
            console.error('Failed to send daily archive notification to', tg, sendErr);
          }
        }
      } catch (err) {
        console.error('Error in daily archive cron:', err);
      }
    });

    // Monthly on 1st at 00:00 - archive last month's monthly plans
    cron.schedule('0 0 1 * *', async () => {
      try {
        console.log('Running monthly archive job...');
        // Mark monthly plans created before the first day of this month as completed
        const res = await db.query(
          "UPDATE plans SET is_completed = true WHERE plan_type = 'monthly' AND is_completed = false AND created_at < date_trunc('month', NOW()) RETURNING telegram_id"
        );
        const telegramIds = [...new Set(res.rows.map(r => r.telegram_id))];
        for (const tg of telegramIds) {
          try {
            await bot.api.sendMessage(tg, "Yangi oy boshlandi! O'tgan oy rejalaringiz arxivga o'tkazildi.");
          } catch (sendErr) {
            console.error('Failed to send monthly archive notification to', tg, sendErr);
          }
        }
      } catch (err) {
        console.error('Error in monthly archive cron:', err);
      }
    });

    // Yearly on Jan 1 at 00:00 - archive last year's yearly plans
    cron.schedule('0 0 1 1 *', async () => {
      try {
        console.log('Running yearly archive job...');
        // Mark yearly plans created before the first day of this year as completed
        const res = await db.query(
          "UPDATE plans SET is_completed = true WHERE plan_type = 'yearly' AND is_completed = false AND created_at < date_trunc('year', NOW()) RETURNING telegram_id"
        );
        const telegramIds = [...new Set(res.rows.map(r => r.telegram_id))];
        for (const tg of telegramIds) {
          try {
            await bot.api.sendMessage(tg, "Yangi yil boshlandi! O'tgan yil rejalaringiz arxivga o'tkazildi.");
          } catch (sendErr) {
            console.error('Failed to send yearly archive notification to', tg, sendErr);
          }
        }
      } catch (err) {
        console.error('Error in yearly archive cron:', err);
      }
    });

    await bot.start();
  } catch (err) {
    console.error('Failed to start bot:', err);
    process.exit(1);
  }
})();
