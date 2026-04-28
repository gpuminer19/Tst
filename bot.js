const TelegramBot = require('node-telegram-bot-api');

// ТОКЕН вашего бота (замените на реальный)
const TOKEN = '8663587522:AAEkCqnlOW3964GoFha7I8Smar9UFKbcBKA';

// Адрес вашей игры на GitHub Pages
const GAME_URL = 'https://gpuminer19.github.io/Tst';

// API бэкенда для засчёта рефералов
const API_URL = 'https://tst-production-c55e.up.railway.app/api/tg';

const bot = new TelegramBot(TOKEN, { polling: true });

console.log('🤖 Бот @Testgpuuubot запущен!');
console.log('✅ Рефералы засчитываются сразу после /start');

// Функция для засчёта реферала через бэкенд
async function countReferral(userId, referrerId, userName) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        userId: userId.toString(), 
        referrerId: referrerId.toString(),
        name: userName 
      })
    });
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Ошибка при запросе к API:', error);
    return { success: false, error: error.message };
  }
}

// ========== ОБРАБОТЧИК /start С РЕФЕРАЛОМ ==========
bot.onText(/\/start ref_(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const userName = msg.from.first_name || msg.from.username || `User_${userId.slice(-5)}`;
  const referrerId = match[1];
  
  console.log(`📥 /start ref_${referrerId} от ${userName} (${userId})`);
  
  // ЗАСЧИТЫВАЕМ РЕФЕРАЛА СРАЗУ!
  const result = await countReferral(userId, referrerId, userName);
  
  if (result.success) {
    await bot.sendMessage(chatId, 
      `🎉 *БОНУС АКТИВИРОВАН!* 🎉\n\n` +
      `Вы перешли по реферальной ссылке от *${userName}*.\n` +
      `Ваш друг уже получил бонус за приглашение!\n\n` +
      `👇 *Нажми на кнопку, чтобы начать играть!*`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await bot.sendMessage(chatId, 
      `🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU!*\n\n` +
      `👇 *Нажми на кнопку, чтобы начать играть!*`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Отправляем кнопку с игрой
  await bot.sendMessage(chatId, `🚀 *Запустить игру*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🚀 ИГРАТЬ',
        web_app: { url: GAME_URL }
      }]]
    }
  });
});

// ========== ОБЫЧНЫЙ /start (без реферала) ==========
bot.onText(/\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || msg.from.username || 'Игрок';
  
  console.log(`📥 /start от ${userName} (${msg.from.id})`);
  
  await bot.sendMessage(chatId, 
    `🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU, ${userName}!*\n\n` +
    `💰 Майни TON и получай бонусы\n` +
    `👥 Приглашай друзей и зарабатывай\n\n` +
    `👇 *Нажми на кнопку, чтобы начать!*`,
    { parse_mode: 'Markdown' }
  );
  
  await bot.sendMessage(chatId, `🚀 *Запустить игру*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🚀 ИГРАТЬ',
        web_app: { url: GAME_URL }
      }]]
    }
  });
});

// ========== ОБРАБОТКА ЛЮБЫХ ДРУГИХ СООБЩЕНИЙ ==========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Если это не команда /start
  if (text && !text.startsWith('/start')) {
    await bot.sendMessage(chatId, 
      `🎮 *CRYPTOGPU*\n\nНажми на кнопку ниже, чтобы начать играть!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🚀 ИГРАТЬ', web_app: { url: GAME_URL } }
          ]]
        }
      }
    );
  }
});

console.log('✅ Бот готов к работе!');
