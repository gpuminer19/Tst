import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_sqlalchemy import SQLAlchemy
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

# ================= CONFIG =================

BOT_TOKEN = os.environ.get("BOT_TOKEN")
ADMIN_IDS = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x]
TON_WALLET = os.environ.get("TON_WALLET", "YOUR_TON_WALLET")
API_SECRET = os.environ.get("API_SECRET", "super-secret")

MIN_WITHDRAW = float(os.environ.get("MIN_WITHDRAW", 2))   # 🔥 минимум 2 TON
MAX_WITHDRAW = float(os.environ.get("MAX_WITHDRAW", 100))

app = Flask(__name__)

database_url = os.environ.get("DATABASE_URL", "sqlite:///game.db")
if database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret")

db = SQLAlchemy(app)
bot = telebot.TeleBot(BOT_TOKEN)

# ================= MODELS =================

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), unique=True, nullable=False)
    name = db.Column(db.String(200))
    ton = db.Column(db.Float, default=0.0)
    gpu = db.Column(db.Integer, default=0)
    referrer_id = db.Column(db.String(100))
    friends_count = db.Column(db.Integer, default=0)
    mining_state = db.Column(db.Text, default="{}")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Deposit(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    amount = db.Column(db.Float)
    comment = db.Column(db.String(200), unique=True)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.Integer)

class Withdraw(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    amount = db.Column(db.Float)
    wallet = db.Column(db.String(200))
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.Integer)

class Referral(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    friend_id = db.Column(db.String(100))
    friend_name = db.Column(db.String(200))
    date = db.Column(db.String(50))

# ================= ADMIN =================

class UserAdmin(ModelView):
    column_list = ['user_id', 'name', 'ton', 'gpu', 'friends_count', 'created_at']
    can_create = False

class DepositAdmin(ModelView):
    column_list = ['id', 'user_id', 'amount', 'status', 'created_at']

class WithdrawAdmin(ModelView):
    column_list = ['id', 'user_id', 'amount', 'wallet', 'status']

admin = Admin(app, name="Admin", template_mode="bootstrap4")
admin.add_view(UserAdmin(User, db.session))
admin.add_view(DepositAdmin(Deposit, db.session))
admin.add_view(WithdrawAdmin(Withdraw, db.session))
admin.add_view(ModelView(Referral, db.session))

# ================= HELPERS =================

def check_secret(req):
    return req.headers.get("X-API-KEY") == API_SECRET

def get_user(user_id):
    return User.query.filter_by(user_id=user_id).first()

# ================= API =================

@app.route('/api', methods=['POST'])
def api():
    if not check_secret(request):
        return jsonify({"success": False, "error": "Unauthorized"})

    data = request.json
    action = data.get('action')
    user_id = str(data.get('user_id'))

    if not user_id:
        return jsonify({"success": False})

    # ===== REGISTER =====
    if action == 'register':
        name = data.get('name', 'Player')
        referrer_id = data.get('referrer_id', '').replace('ref_', '')

        user = get_user(user_id)

        if not user:
            user = User(user_id=user_id, name=name, referrer_id=referrer_id)
            db.session.add(user)

            if referrer_id and referrer_id != user_id:
                ref = get_user(referrer_id)
                if ref:
                    ref.friends_count += 1
                    db.session.add(Referral(
                        user_id=referrer_id,
                        friend_id=user_id,
                        friend_name=name,
                        date=datetime.now().strftime("%d.%m.%Y")
                    ))

            db.session.commit()

        return jsonify({
            "success": True,
            "data": {
                "ton": user.ton,
                "gpu": user.gpu,
                "friends": user.friends_count,
                "state": json.loads(user.mining_state or "{}")
            }
        })

    # ===== SAVE STATE =====
    if action == 'save':
        user = get_user(user_id)
        if user and data.get('state'):
            user.mining_state = json.dumps(data.get('state'))
            db.session.commit()
        return jsonify({"success": True})

    # ===== MINE =====
    if action == 'mine':
        user = get_user(user_id)
        if user:
            reward = 0.01
            user.ton += reward
            db.session.commit()
            return jsonify({"success": True, "ton": user.ton})

    # ===== DEPOSIT =====
    if action == 'createDeposit':
        existing = Deposit.query.filter_by(user_id=user_id, status='pending').first()
        if existing:
            return jsonify({"success": False, "error": "Pending deposit exists"})

        amount = float(data.get('amount'))
        if amount < 0.1:
            return jsonify({"success": False})

        comment = f"GPU-{user_id}-{int(datetime.now().timestamp())}"

        deposit = Deposit(
            user_id=user_id,
            amount=amount,
            comment=comment,
            created_at=int(datetime.now().timestamp())
        )

        db.session.add(deposit)
        db.session.commit()

        markup = InlineKeyboardMarkup()
        markup.add(
            InlineKeyboardButton("Approve", callback_data=f"approve_{deposit.id}"),
            InlineKeyboardButton("Reject", callback_data=f"reject_{deposit.id}")
        )

        for admin_id in ADMIN_IDS:
            try:
                bot.send_message(admin_id, f"Deposit\nUser: {user_id}\nAmount: {amount}\nComment: {comment}", reply_markup=markup)
            except:
                pass

        return jsonify({
            "success": True,
            "deposit": {
                "wallet": TON_WALLET,
                "comment": comment,
                "amount": amount
            }
        })

    # ===== WITHDRAW =====
    if action == 'createWithdraw':
        user = get_user(user_id)
        amount = float(data.get('amount'))
        wallet = data.get('wallet')

        if not user:
            return jsonify({"success": False})

        if amount < MIN_WITHDRAW:
            return jsonify({
                "success": False,
                "error": f"Minimum withdraw is {MIN_WITHDRAW} TON"
            })

        if amount > MAX_WITHDRAW:
            return jsonify({
                "success": False,
                "error": "Too large amount"
            })

        if user.ton < amount:
            return jsonify({
                "success": False,
                "error": "Not enough balance"
            })

        user.ton -= amount

        withdraw = Withdraw(
            user_id=user_id,
            amount=amount,
            wallet=wallet,
            created_at=int(datetime.now().timestamp())
        )

        db.session.add(withdraw)
        db.session.commit()

        for admin_id in ADMIN_IDS:
            bot.send_message(admin_id, f"Withdraw\nUser: {user_id}\nAmount: {amount}\nWallet: {wallet}")

        return jsonify({"success": True})

    return jsonify({"success": False})

# ================= TELEGRAM =================

@bot.callback_query_handler(func=lambda c: c.data.startswith("approve_"))
def approve(c):
    if c.from_user.id not in ADMIN_IDS:
        return

    deposit_id = int(c.data.split("_")[1])
    dep = Deposit.query.get(deposit_id)

    if dep and dep.status == 'pending':
        dep.status = 'approved'
        user = get_user(dep.user_id)
        if user:
            user.ton += dep.amount
        db.session.commit()

        bot.edit_message_text("Approved", c.message.chat.id, c.message.message_id)

@bot.callback_query_handler(func=lambda c: c.data.startswith("reject_"))
def reject(c):
    if c.from_user.id not in ADMIN_IDS:
        return

    deposit_id = int(c.data.split("_")[1])
    dep = Deposit.query.get(deposit_id)

    if dep:
        dep.status = 'rejected'
        db.session.commit()

        bot.edit_message_text("Rejected", c.message.chat.id, c.message.message_id)

# ================= RUN =================

@app.route('/')
def home():
    return "OK"

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=8080)