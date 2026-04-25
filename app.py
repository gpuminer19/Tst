import os
import json
import threading
from datetime import datetime
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

# ================= CONFIG =================

BOT_TOKEN = os.environ.get("BOT_TOKEN")
ADMIN_IDS = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x]
API_SECRET = os.environ.get("API_SECRET", "secret")
TON_WALLET = os.environ.get("TON_WALLET", "wallet")

def get_env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except:
        return default

MIN_WITHDRAW = get_env_float("MIN_WITHDRAW", 2)
MAX_WITHDRAW = get_env_float("MAX_WITHDRAW", 100)

# ================= APP =================

app = Flask(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL")

if not DATABASE_URL:
    DATABASE_URL = "sqlite:///game.db"
elif DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "secret"

db = SQLAlchemy(app)
bot = telebot.TeleBot(BOT_TOKEN)

# ================= MODELS =================

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), unique=True)
    name = db.Column(db.String(200))
    ton = db.Column(db.Float, default=0)
    gpu = db.Column(db.Integer, default=0)
    friends_count = db.Column(db.Integer, default=0)
    referrer_id = db.Column(db.String(100))
    mining_state = db.Column(db.Text, default="{}")

class Deposit(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    amount = db.Column(db.Float)
    status = db.Column(db.String(20), default="pending")

class Withdraw(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    amount = db.Column(db.Float)
    wallet = db.Column(db.String(200))
    status = db.Column(db.String(20), default="pending")

# ================= ADMIN =================

admin = Admin(app, name="Admin")  # 🔥 без template_mode

admin.add_view(ModelView(User, db.session))
admin.add_view(ModelView(Deposit, db.session))
admin.add_view(ModelView(Withdraw, db.session))

# ================= API =================

def check_secret(req):
    return req.headers.get("X-API-KEY") == API_SECRET

def get_user(uid):
    return User.query.filter_by(user_id=uid).first()

@app.route("/api", methods=["POST"])
def api():
    if not check_secret(request):
        return jsonify({"success": False})

    data = request.json
    action = data.get("action")
    user_id = str(data.get("user_id"))

    if not user_id:
        return jsonify({"success": False})

    # REGISTER
    if action == "register":
        user = get_user(user_id)
        if not user:
            user = User(user_id=user_id, name=data.get("name", "Player"))
            db.session.add(user)
            db.session.commit()

        return jsonify({
            "success": True,
            "data": {
                "ton": user.ton,
                "gpu": user.gpu
            }
        })

    # MINE
    if action == "mine":
        user = get_user(user_id)
        if user:
            user.ton += 0.01
            db.session.commit()
            return jsonify({"success": True, "ton": user.ton})

    # WITHDRAW
    if action == "withdraw":
        user = get_user(user_id)
        amount = float(data.get("amount", 0))
        wallet = data.get("wallet")

        if not user:
            return jsonify({"success": False})

        if amount < MIN_WITHDRAW:
            return jsonify({"success": False, "error": "Min 2 TON"})

        if amount > MAX_WITHDRAW:
            return jsonify({"success": False, "error": "Too much"})

        if user.ton < amount:
            return jsonify({"success": False, "error": "No balance"})

        user.ton -= amount

        w = Withdraw(user_id=user_id, amount=amount, wallet=wallet)
        db.session.add(w)
        db.session.commit()

        for admin in ADMIN_IDS:
            bot.send_message(admin, f"Withdraw\n{user_id}\n{amount}\n{wallet}")

        return jsonify({"success": True})

    return jsonify({"success": False})

# ================= BOT =================

def run_bot():
    bot.infinity_polling()

# ================= RUN =================

@app.route("/")
def home():
    return "OK"

if __name__ == "__main__":
    with app.app_context():
        db.create_all()

threading.Thread(target=run_bot).start()
