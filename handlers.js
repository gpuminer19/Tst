// handlers.js — обработчик вебхука для Telegram бота

const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.API_URL || 'https://tst-production-c55e.up.railway.app/api/tg';
const APP_URL = process.env.APP_URL || 'https://gpuminer19.github.io/Game/';

// ========== ОТПРАВКА СООБЩЕНИЯ ==========
async function sendMessage(chatId, text, keyboard = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };

    if (keyboard) {
      payload.reply_markup = keyboard;
    }

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload
    );
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
  }
}

// ========== КЛАВИАТУРА ==========
function getGameKeyboard() {
  return {
    inline_keyboard: [[{
      text: '🎮 ИГРАТЬ',
      web_app: { url: APP_URL }
    }]]
  };
}

// ========== /START (ИСПРАВЛЕНО) ==========
async function handleStart(chatId, userId, userName, text) {
  // 🔧 FIX: корректно забираем payload после /start
  const payload = text.split(' ')[1]; // /start XXXX

  let referrerId = null;

  if (payload) {
    if (payload.startsWith('ref_')) {
      referrerId = payload.replace('ref_', '');
    } else {
      referrerId = payload;
    }
  }

  // ========== РЕФЕРАЛКА ==========
  if (referrerId && referrerId !== String(userId)) {
    try {
      await axios.post(API_URL, {
        action: 'register',
        user_id: userId,
        referrer_id: referrerId,
        name: userName
      });

      console.log(`👥 Реферал зарегистрирован: ${referrerId} → ${userId}`);
    } catch (e) {
      console.error('Referral error:', e.message);
    }
  }

  // ========== ПРИВЕТСТВИЕ ==========
  const welcomeText =
`🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU, ${userName}!*

👇 *Нажми на кнопку, чтобы начать!*`;

  await sendMessage(chatId, welcomeText, getGameKeyboard());
}

// ========== CALLBACK КНОПОК ==========
async function handleCallbackQuery(callbackQuery) {
  const { data, message, from } = callbackQuery;
  const [action, type, id] = data.split(':');

  console.log(`🔘 Callback: ${action} | ${type} | ${id} от ${from.id}`);

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      callback_query_id: callbackQuery.id,
      text: action === 'approve' ? '✅ Подтверждено' : '❌ Отклонено'
    }
  );

  if (type === 'deposit') {
    if (action === 'approve') {
      console.log(`💎 Депозит ${id} подтверждён`);
    } else {
      console.log(`❌ Депозит ${id} отклонён`);
    }
  }

  if (type === 'withdraw') {
    if (action === 'approve') {
      console.log(`📤 Вывод ${id} подтверждён`);
    } else {
      console.log(`❌ Вывод ${id} отклонён`);
    }
  }

  if (type === 'task') {
    if (action === 'approve') {
      console.log(`📋 Задание ${id} подтверждено`);
    } else {
      console.log(`❌ Задание ${id} отклонено`);
    }
  }

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: message.text + '\n\n✅ Обработано!',
      parse_mode: 'HTML'
    }
  );
}

// ========== WEBHOOK ==========
async function handleWebhook(reqBody) {
  const { message, callback_query } = reqBody;

  // ===== текстовые команды =====
  if (message && message.text) {
    const chatId = message.chat.id;
    const userId = message.from.id.toString();
    const userName = message.from.first_name || 'Игрок';
    const text = message.text;

    console.log(`📩 Сообщение: "${text}" от ${userName} (${userId})`);

    if (text.startsWith('/start')) {
      await handleStart(chatId, userId, userName, text);
    }

    return { success: true };
  }

  // ===== callback кнопки =====
  if (callback_query) {
    await handleCallbackQuery(callback_query);
    return { success: true };
  }

  return { success: false, message: 'No handler' };
}

module.exports = { handleWebhook };
