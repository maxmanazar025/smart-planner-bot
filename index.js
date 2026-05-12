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

    // plans.user_id stores the Telegram ID (not the DB serial id)
    const plansRes = await db.query('SELECT id, content, plan_type, is_completed, created_at FROM plans WHERE user_id = $1 AND is_completed = false ORDER BY created_at DESC', [telegramId]);
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

    console.log('Saving plan', { telegramId: from.id, planType, content });

    // Use the Telegram ID as plans.user_id (your schema references users(telegram_id))
    await db.query('INSERT INTO plans (user_id, content, plan_type) VALUES ($1, $2, $3)', [from.id, content, planType]);

    await ctx.reply('Reja saqlandi.');
    userStates.delete(from.id);
  } catch (err) {
    // Print the exact DB error to the terminal for debugging
    console.error(err);
    await ctx.reply('Rejani saqlashda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
    userStates.delete(from.id);
  }
});

// /clear command to delete all completed plans for the user
bot.command('clear', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  try {
    await db.query('DELETE FROM plans WHERE user_id = $1 AND is_completed = true', [from.id]);
    await ctx.reply('Barcha bajatilgan (completed) rejalar o\'chirildi.');
  } catch (err) {
    console.error('Error clearing completed plans:', err);
    await ctx.reply('Rejalarni tozalashda xatolik yuz berdi.');
  }
});

bot.hears('🗑 Tozalash', async (ctx) => {
  // Mirror /clear button
  await bot.invoke(ctx.update, ctx);
});

bot.catch((err) => {
  console.error('Bot error:', err);
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
          "UPDATE plans SET is_completed = true WHERE plan_type = 'daily' AND is_completed = false AND created_at < date_trunc('day', NOW()) RETURNING user_id"
        );
        const userIds = [...new Set(res.rows.map(r => r.user_id))];
        for (const tg of userIds) {
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
          "UPDATE plans SET is_completed = true WHERE plan_type = 'monthly' AND is_completed = false AND created_at < date_trunc('month', NOW()) RETURNING user_id"
        );
        const userIds = [...new Set(res.rows.map(r => r.user_id))];
        for (const tg of userIds) {
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
          "UPDATE plans SET is_completed = true WHERE plan_type = 'yearly' AND is_completed = false AND created_at < date_trunc('year', NOW()) RETURNING user_id"
        );
        const userIds = [...new Set(res.rows.map(r => r.user_id))];
        for (const tg of userIds) {
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
