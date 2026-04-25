const TelegramBot = require('node-telegram-bot-api');

// ТОКЕН вашего бота (получите у @BotFather)
const TOKEN = '8663587522:AAEkCqnlOW3964GoFha7I8Smar9UFKbcBKA';  // Замените на реальный токен!

// Адрес вашей игры на GitHub Pages
const GAME_URL = 'https://gpuminer19.github.io/Tst';

// Создаём бота
const bot = new TelegramBot(TOKEN, { polling: true });

console.log('🤖 Бот @Testgpuuubot запущен!');

// ========== ОБРАБОТЧИК КОМАНДЫ /start ==========

// 1. С реферальным параметром (t.me/бот?start=ref_123)
bot.onText(/\/start ref_(.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const referrerId = match[1]; // ID пригласившего друга
  
  console.log(`📥 Новый пользователь! Реферер: ${referrerId}`);
  
  // Отправляем сообщение с кнопкой
  bot.sendMessage(chatId, 
    `🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU!*\n\n` +
    `💰 *Майни TON* и получай ежедневные бонусы\n` +
    `⚡ *Приглашай друзей* и зарабатывай до 10 TON\n` +
    `🎁 *За каждые 5 друзей* получаешь награду!\n\n` +
    `👇 *Нажми на кнопку, чтобы начать играть!*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { 
            text: '🚀 ЗАПУСТИТЬ ИГРУ', 
            web_app: { url: `${GAME_URL}/?startapp=ref_${referrerId}` }
          }
        ]]
      }
    }
  );
});

// 2. Обычный /start (без реферала)
bot.onText(/\/start$/, (msg) => {
  const chatId = msg.chat.id;
  
  console.log(`📥 Новый пользователь (без реферала)`);
  
  bot.sendMessage(chatId, 
    `🎮 *ДОБРО ПОЖАЛОВАТЬ В CRYPTOGPU!*\n\n` +
    `💰 *Майни TON* и получай ежедневные бонусы\n` +
    `⚡ *Приглашай друзей* и зарабатывай до 10 TON\n` +
    `🎁 *За каждые 5 друзей* получаешь награду!\n\n` +
    `👇 *Нажми на кнопку, чтобы начать играть!*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { 
            text: '🚀 ЗАПУСТИТЬ ИГРУ', 
            web_app: { url: GAME_URL }
          }
        ]]
      }
    }
  );
});

// ========== ОБРАБОТЧИК ЛЮБОГО СООБЩЕНИЯ (если написали не /start) ==========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Если это не команда /start
  if (text && !text.startsWith('/start')) {
    bot.sendMessage(chatId, 
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