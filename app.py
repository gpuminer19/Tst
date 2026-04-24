import os
import sqlite3
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

BOT_TOKEN = os.environ.get("BOT_TOKEN", "8663587522:AAEkCqnlOW3964GoFha7I8Smar9UFKbcBKA")
ADMIN_IDS = [int(x) for x in os.environ.get("ADMIN_IDS", "7136928282").split(",") if x]
TON_WALLET = os.environ.get("TON_WALLET", "qwww")

app = Flask(__name__)

# РАЗРЕШАЕМ ВСЕ ЗАПРОСЫ СО ВСЕХ ДОМЕНОВ
CORS(app, resources={r"/*": {"origins": "*"}})

# ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА ОТ CORS — РУЧНЫЕ ЗАГОЛОВКИ
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response

bot = telebot.TeleBot(BOT_TOKEN)

# === БАЗА ДАННЫХ ===
def init_db():
    conn = sqlite3.connect('game.db')
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users
                 (user_id TEXT PRIMARY KEY, name TEXT, ton REAL DEFAULT 5.0,
                  gpu INTEGER DEFAULT 0, referrer_id TEXT, friends_count INTEGER DEFAULT 0,
                  mining_state TEXT)''')
    c.execute('''CREATE TABLE IF NOT EXISTS deposits
                 (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, amount REAL,
                  comment TEXT, status TEXT DEFAULT 'pending', created_at INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS referrals
                 (user_id TEXT, friend_id TEXT, friend_name TEXT, date TEXT)''')
    conn.commit()
    conn.close()

init_db()

# === API ДЛЯ ФРОНТЕНДА ===
@app.route('/api/tg', methods=['POST', 'OPTIONS'])
def api_handler():
    if request.method == 'OPTIONS':
        return '', 200
    
    data = request.json
    action = data.get('action')
    user_id = str(data.get('user_id'))
    conn = sqlite3.connect('game.db')
    c = conn.cursor()

    if action == 'register':
        name = data.get('name', 'Player')
        referrer_id = data.get('referrer_id', '').replace('ref_', '')
        c.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        if not c.fetchone():
            c.execute("INSERT INTO users (user_id, name, referrer_id, mining_state) VALUES (?,?,?,?)",
                      (user_id, name, referrer_id, '{}'))
            if referrer_id and referrer_id != user_id:
                c.execute("UPDATE users SET friends_count = friends_count + 1 WHERE user_id = ?", (referrer_id,))
                c.execute("INSERT INTO referrals (user_id, friend_id, friend_name, date) VALUES (?,?,?,?)",
                          (referrer_id, user_id, name, datetime.now().strftime("%d.%m.%Y")))
            conn.commit()
        c.execute("SELECT ton, gpu, friends_count, mining_state FROM users WHERE user_id = ?", (user_id,))
        row = c.fetchone()
        conn.close()
        print(f"Register OK for {user_id}")
        return jsonify({"success": True, "data": {"ton": row[0], "gpu": row[1], "friends": row[2], "state": json.loads(row[3])}})

    if action == 'save':
        ton = data.get('ton')
        gpu = data.get('gpu')
        state = json.dumps(data.get('state', {}))
        c.execute("UPDATE users SET ton = ?, gpu = ?, mining_state = ? WHERE user_id = ?", (ton, gpu, state, user_id))
        conn.commit()
        conn.close()
        print(f"Save OK for {user_id}")
        return jsonify({"success": True})

    if action == 'getReferrals':
        c.execute("SELECT friend_name, date FROM referrals WHERE user_id = ?", (user_id,))
        refs = [{"name": r[0], "date": r[1]} for r in c.fetchall()]
        conn.close()
        return jsonify({"success": True, "referrals": refs})

    if action == 'createDeposit':
        amount = float(data.get('amount'))
        comment = f"GPU-{user_id}-{int(datetime.now().timestamp())}"
        c.execute("INSERT INTO deposits (user_id, amount, comment, created_at) VALUES (?,?,?,?)",
                  (user_id, amount, comment, int(datetime.now().timestamp())))
        conn.commit()
        deposit_id = c.lastrowid
        conn.close()
        
        if ADMIN_IDS and BOT_TOKEN:
            markup = InlineKeyboardMarkup()
            markup.add(
                InlineKeyboardButton("✅ Да", callback_data=f"approve_{deposit_id}"),
                InlineKeyboardButton("❌ Нет", callback_data=f"reject_{deposit_id}")
            )
            for admin_id in ADMIN_IDS:
                try:
                    bot.send_message(admin_id, f"🔔 Заявка!\n👤 {user_id}\n💰 {amount} TON\n📝 {comment}", reply_markup=markup)
                except Exception as e:
                    print(f"Ошибка отправки админу: {e}")
        
        return jsonify({"success": True, "deposit": {"wallet": TON_WALLET, "comment": comment, "amount": amount}})

    conn.close()
    return jsonify({"success": False, "error": "Unknown action"})

# === ОБРАБОТЧИКИ БОТА ===
@bot.callback_query_handler(func=lambda call: call.data.startswith("approve_"))
def approve_deposit(call):
    if call.from_user.id not in ADMIN_IDS:
        bot.answer_callback_query(call.id, "Доступ запрещён")
        return
    
    deposit_id = int(call.data.split("_")[1])
    conn = sqlite3.connect('game.db')
    c = conn.cursor()
    c.execute("SELECT user_id, amount FROM deposits WHERE id = ? AND status = 'pending'", (deposit_id,))
    row = c.fetchone()
    
    if row:
        user_id, amount = row
        c.execute("UPDATE deposits SET status = 'approved' WHERE id = ?", (deposit_id,))
        c.execute("UPDATE users SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
        conn.commit()
        try:
            bot.send_message(int(user_id), f"✅ Баланс пополнен на {amount} TON!")
        except:
            pass
        bot.answer_callback_query(call.id, "Подтверждено")
        bot.edit_message_text(f"✅ Заявка #{deposit_id} подтверждена", call.message.chat.id, call.message.message_id)
    conn.close()

@bot.callback_query_handler(func=lambda call: call.data.startswith("reject_"))
def reject_deposit(call):
    if call.from_user.id not in ADMIN_IDS:
        bot.answer_callback_query(call.id, "Доступ запрещён")
        return
    
    deposit_id = int(call.data.split("_")[1])
    conn = sqlite3.connect('game.db')
    c = conn.cursor()
    c.execute("UPDATE deposits SET status = 'rejected' WHERE id = ?", (deposit_id,))
    conn.commit()
    conn.close()
    bot.answer_callback_query(call.id, "Отклонено")
    bot.edit_message_text(f"❌ Заявка #{deposit_id} отклонена", call.message.chat.id, call.message.message_id)

@app.route('/')
def home():
    return "OK"

# === ЗАПУСК БОТА В ПОТОКЕ ===
import threading
import time

def run_bot():
    while True:
        try:
            print("Бот запущен и слушает...")
            bot.infinity_polling(timeout=10, long_polling_timeout=5)
        except Exception as e:
            print(f"Ошибка бота: {e}")
            time.sleep(5)

if __name__ == '__main__':
    # Запускаем бота в фоне
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
    
    # Запускаем Flask
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)
