// handlers.js — обработчик вебхука для Telegram бота

const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.API_URL || 'https://tst-production-c55e.up.railway.app/api/tg';
const APP_URL = process.env.APP_URL || 'https://gpuminer19.github.io/Game/';

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
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload);
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
  }
}

function getGameKeyboard() {
  return {
    inline_keyboard: [[{
      text: '🎮 ИГРАТЬ',
      web_app: { url: APP_URL }
    }]]
  };
}

async function handleStart(chatId, userId, userName, text) {
  const payload = text.split(' ')[1];
  let referrerId = null;

  if (payload) {
    if (payload.startsWith('ref_')) {
      referrerId = payload.replace('ref_', '');
    } else {
      referrerId = payload;
    }
  }

  if (referrerId && referrerId !== String(userId)) {
    try {
      await axios.post(API_URL, {
        action: 'register',
        user_id: userId,
        referrer_id: referrerId,
        name: userName
      }, {
        headers: {
          'x-bot-secret': TELEGRAM_BOT_TOKEN
        }
      });
      console.log(`👥 Реферал зарегистрирован: ${referrerId} → ${userId}`);
    } catch (e) {
      console.error('Referral error:', e.message);
    }
  }

  const welcomeText = `🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU, ${userName}!*\n\n👇 *Нажми на кнопку, чтобы начать!*`;
  await sendMessage(chatId, welcomeText, getGameKeyboard());
}

async function handleCallbackQuery(callbackQuery) {
  const { data, message, from } = callbackQuery;
  const [action, type, id] = data.split(':');

  console.log(`🔘 Callback: ${action} | ${type} | ${id} от ${from.id}`);

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    callback_query_id: callbackQuery.id,
    text: action === 'approve' ? '✅ Подтверждено' : '❌ Отклонено'
  });

  // ОБРАБОТКА ДЕПОЗИТОВ
  if (type === 'deposit') {
    if (action === 'approve') {
      try {
        console.log(`📤 Отправка confirmDeposit для депозита ${id}`);
        await axios.post(API_URL, {
          action: 'confirmDeposit',
          deposit_id: id,
          user_id: from.id
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`💎 Депозит ${id} подтверждён`);
      } catch (e) {
        console.error(`❌ Ошибка подтверждения депозита ${id}:`, e.response?.data || e.message);
      }
    } else if (action === 'reject') {
      try {
        console.log(`📤 Отправка rejectDeposit для депозита ${id}`);
        await axios.post(API_URL, {
          action: 'rejectDeposit',
          deposit_id: id,
          user_id: from.id
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`❌ Депозит ${id} отклонён`);
      } catch (e) {
        console.error(`❌ Ошибка отклонения депозита ${id}:`, e.response?.data || e.message);
      }
    }
  }

  // ОБРАБОТКА ВЫВОДОВ
  if (type === 'withdraw') {
    if (action === 'approve') {
      try {
        console.log(`📤 Отправка approveWithdraw для вывода ${id}`);
        await axios.post(API_URL, {
          action: 'approveWithdraw',
          withdraw_id: id,
          user_id: from.id.toString()
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`📤 Вывод ${id} подтверждён`);
      } catch (e) {
        console.error(`❌ Ошибка подтверждения вывода ${id}:`, e.response?.data || e.message);
      }
    } else if (action === 'reject') {
      try {
        console.log(`📤 Отправка rejectWithdraw для вывода ${id}`);
        await axios.post(API_URL, {
          action: 'rejectWithdraw',
          withdraw_id: id,
          user_id: from.id.toString()
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`❌ Вывод ${id} отклонён`);
      } catch (e) {
        console.error(`❌ Ошибка отклонения вывода ${id}:`, e.response?.data || e.message);
      }
    }
  }

  // ОБРАБОТКА ЗАДАНИЙ - ИСПРАВЛЕНО
  if (type === 'task') {
    if (action === 'approve') {
      try {
        console.log(`📋 Отправка подтверждения задания ${id}`);
        await axios.post(API_URL, {
          action: 'approveTask',
          task_user_id: id,
          user_id: from.id.toString()
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`📋 Задание ${id} подтверждено`);
      } catch (e) {
        console.error(`❌ Ошибка подтверждения задания ${id}:`, e.response?.data || e.message);
      }
    } else if (action === 'reject') {
      try {
        console.log(`📋 Отправка отклонения задания ${id}`);
        await axios.post(API_URL, {
          action: 'rejectTask',
          task_user_id: id,
          user_id: from.id.toString()
        }, {
          headers: {
            'x-bot-secret': TELEGRAM_BOT_TOKEN,
            'Content-Type': 'application/json'
          }
        });
        console.log(`❌ Задание ${id} отклонено`);
      } catch (e) {
        console.error(`❌ Ошибка отклонения задания ${id}:`, e.response?.data || e.message);
      }
    }
  }

  // Редактируем сообщение
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: message.text + '\n\n✅ Обработано!',
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.log(`Не удалось отредактировать сообщение: ${e.message}`);
  }
}

async function handleWebhook(reqBody) {
  const { message, callback_query } = reqBody;

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

  if (callback_query) {
    await handleCallbackQuery(callback_query);
    return { success: true };
  }

  return { success: false, message: 'No handler' };
}

module.exports = { handleWebhook };
