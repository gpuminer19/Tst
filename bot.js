const TelegramBot = require('node-telegram-bot-api');
const TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL || 'https://tst-production-c55e.up.railway.app/api/tg';
const APP_URL = process.env.APP_URL || 'https://gpuminer19.github.io/Game/';

if (!TOKEN) {
    console.error('❌ ОШИБКА: BOT_TOKEN не найден!');
    process.exit(1);
}

// ❌ Убираем polling
// const bot = new TelegramBot(TOKEN, { polling: true });

// ✅ Бот без polling (вебхук будет на сервере)
const bot = new TelegramBot(TOKEN);

console.log('🤖 Бот запущен в режиме Webhook');
console.log(`📱 Mini App URL: ${APP_URL}`);
console.log(`🔗 API URL: ${API_URL}`);

// Регистрация реферала (та же функция)
async function registerReferral(userId, referrerId, userName) {
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'register',
                user_id: userId.toString(),
                referrer_id: referrerId.toString(),
                name: userName
            })
        });
        const result = await response.json();
        console.log(`📊 API ответ:`, result.success ? '✅ Успешно' : `❌ ${result.error}`);
        return result;
    } catch (error) {
        console.error('❌ Ошибка API:', error.message);
        return { success: false, error: error.message };
    }
}

// Отправка сообщения
async function sendGameKeyboard(chatId, text) {
    const keyboard = {
        reply_markup: {
            inline_keyboard: [[{
                text: '🎮 ИГРАТЬ',
                web_app: { url: APP_URL }
            }]]
        },
        parse_mode: 'Markdown'
    };
    try {
        await bot.sendMessage(chatId, text, keyboard);
    } catch (error) {
        console.error(`❌ Ошибка отправки ${chatId}:`, error.message);
    }
}

// Обработчик команды /start
bot.onText(/\/start(?:[ _-]?ref_?(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const userName = msg.from.first_name || msg.from.username || `User_${userId.slice(-5)}`;
    const referrerId = match[1] ? match[1].trim() : null;
    
    console.log(`📥 /start от ${userName} (${userId})`);
    if (referrerId && referrerId !== userId) {
        console.log(`🔗 Реферальная ссылка от ${referrerId}`);
    }
    
    if (referrerId && referrerId === userId) {
        await sendGameKeyboard(chatId, `🎮 *ДОБРО ПОЖАЛОВАТЬ, ${userName}!*\n\n👇 Нажми на кнопку!`);
        return;
    }
    
    if (referrerId && referrerId !== userId) {
        const result = await registerReferral(userId, referrerId, userName);
        if (result.success) {
            await sendGameKeyboard(chatId, `🎉 *БОНУС АКТИВИРОВАН!*\n\n👇 *Нажми на кнопку, чтобы начать!*`);
        } else {
            await sendGameKeyboard(chatId, `🎮 *ДОБРО ПОЖАЛОВАТЬ, ${userName}!*\n\n👇 Нажми на кнопку!`);
        }
    } else {
        await sendGameKeyboard(chatId, `🎮 *ДОБРО ПОЖАЛОВАТЬ, ${userName}!*\n\n💰 Майни TON и получай бонусы\n👥 Приглашай друзей\n\n👇 Нажми на кнопку!`);
    }
});

console.log('✅ Бот готов (режим Webhook)');