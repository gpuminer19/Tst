const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TOKEN_HERE';

// обязательно включаем polling
const bot = new TelegramBot(TOKEN, { polling: true });

/**
 * /start — корректный обработчик
 * Ловит:
 * /start
 * /start 123
 * /start anything
 */
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;

    // если есть payload после /start
    const payload = match[1];

    console.log('START triggered', payload);

    let text = 'Бот запущен 🚀';

    if (payload) {
        text += `\nPayload: ${payload}`;
    }

    bot.sendMessage(chatId, text);
});

/**
 * Обычные сообщения (не команды)
 */
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // игнорируем команды, чтобы не дублировать ответы
    if (msg.text && msg.text.startsWith('/')) return;

    bot.sendMessage(chatId, `Ты написал: ${msg.text}`);
});

/**
 * Обработка ошибок (очень желательно)
 */
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

module.exports = bot;
