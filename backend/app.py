import sqlite3
import json
import os
from datetime import datetime
from flask import Flask, request, jsonify
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_sqlalchemy import SQLAlchemy
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_IDS = [int(x) for x in os.environ.get("ADMIN_IDS", "0").split(",") if x]
TON_WALLET = os.environ.get("TON_WALLET", "")

app = Flask(__name__)

database_url = os.environ.get("DATABASE_URL", "sqlite:///game.db")
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-key")

db = SQLAlchemy(app)
bot = telebot.TeleBot(BOT_TOKEN)

class User(db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), unique=True, nullable=False)
    name = db.Column(db.String(200))
    ton = db.Column(db.Float, default=5.0)
    gpu = db.Column(db.Integer, default=0)
    referrer_id = db.Column(db.String(100))
    friends_count = db.Column(db.Integer, default=0)
    mining_state = db.Column(db.Text, default="{}")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

class Deposit(db.Model):
    __tablename__ = 'deposits'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), nullable=False)
    amount = db.Column(db.Float, nullable=False)
    comment = db.Column(db.String(200), unique=True)
    status = db.Column(db.String(20), default='pending')
    created_at = db.Column(db.Integer)

class Referral(db.Model):
    __tablename__ = 'referrals'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), nullable=False)
    friend_id = db.Column(db.String(100), nullable=False)
    friend_name = db.Column(db.String(200))
    date = db.Column(db.String(50))

class UserAdmin(ModelView):
    column_list = ['user_id', 'name', 'ton', 'gpu', 'friends_count', 'created_at']
    column_searchable_list = ['user_id', 'name']
    can_create = False

class DepositAdmin(ModelView):
    column_list = ['id', 'user_id', 'amount', 'comment', 'status', 'created_at']
    column_filters = ['status', 'user_id']

admin = Admin(app, name="Game Admin", template_mode="bootstrap4")
admin.add_view(UserAdmin(User, db.session))
admin.add_view(DepositAdmin(Deposit, db.session))
admin.add_view(ModelView(Referral, db.session))

@app.route('/api/tg', methods=['POST'])
def api_handler():
    data = request.json
    action = data.get('action')
    user_id = str(data.get('user_id'))
    
    if action == 'register':
        name = data.get('name', 'Player')
        referrer_id = data.get('referrer_id', '').replace('ref_', '')
        user = User.query.filter_by(user_id=user_id).first()
        if not user:
            user = User(user_id=user_id, name=name, referrer_id=referrer_id)
            db.session.add(user)
            if referrer_id and referrer_id != user_id:
                referrer = User.query.filter_by(user_id=referrer_id).first()
                if referrer:
                    referrer.friends_count = (referrer.friends_count or 0) + 1
                    ref_record = Referral(user_id=referrer_id, friend_id=user_id, friend_name=name, date=datetime.now().strftime("%d.%m.%Y"))
                    db.session.add(ref_record)
            db.session.commit()
        mining_state = json.loads(user.mining_state) if user.mining_state else {}
        return jsonify({"success": True, "data": {"ton": user.ton, "gpu": user.gpu, "friends": user.friends_count, "state": mining_state}})
    
    if action == 'save':
        user = User.query.filter_by(user_id=user_id).first()
        if user:
            user.ton = data.get('ton', user.ton)
            user.gpu = data.get('gpu', user.gpu)
            if data.get('state'):
                user.mining_state = json.dumps(data.get('state'))
            db.session.commit()
        return jsonify({"success": True})
    
    if action == 'getReferrals':
        referrals = Referral.query.filter_by(user_id=user_id).all()
        return jsonify({"success": True, "referrals": [{"name": r.friend_name, "date": r.date} for r in referrals]})
    
    if action == 'createDeposit':
        amount = float(data.get('amount'))
        comment = f"GPU-{user_id}-{int(datetime.now().timestamp())}"
        deposit = Deposit(user_id=user_id, amount=amount, comment=comment, created_at=int(datetime.now().timestamp()))
        db.session.add(deposit)
        db.session.commit()
        markup = InlineKeyboardMarkup()
        markup.add(InlineKeyboardButton("Approve", callback_data=f"approve_{deposit.id}"), InlineKeyboardButton("Reject", callback_data=f"reject_{deposit.id}"))
        for admin_id in ADMIN_IDS:
            try:
                bot.send_message(admin_id, f"New deposit!\nUser: {user_id}\nAmount: {amount} TON\nComment: {comment}", reply_markup=markup)
            except:
                pass
        return jsonify({"success": True, "deposit": {"wallet": TON_WALLET, "comment": comment, "amount": amount}})
    
    return jsonify({"success": False, "error": "Unknown action"})

@bot.callback_query_handler(func=lambda call: call.data.startswith("approve_"))
def approve_deposit(call):
    if call.from_user.id not in ADMIN_IDS:
        bot.answer_callback_query(call.id, "Access denied")
        return
    deposit_id = int(call.data.split("_")[1])
    deposit = Deposit.query.get(deposit_id)
    if deposit and deposit.status == 'pending':
        deposit.status = 'approved'
        user = User.query.filter_by(user_id=deposit.user_id).first()
        if user:
            user.ton = (user.ton or 0) + deposit.amount
        db.session.commit()
        bot.edit_message_text(f"Deposit #{deposit_id} approved", call.message.chat.id, call.message.message_id)
        bot.answer_callback_query(call.id, "Approved")

@bot.callback_query_handler(func=lambda call: call.data.startswith("reject_"))
def reject_deposit(call):
    if call.from_user.id not in ADMIN_IDS:
        bot.answer_callback_query(call.id, "Access denied")
        return
    deposit_id = int(call.data.split("_")[1])
    deposit = Deposit.query.get(deposit_id)
    if deposit and deposit.status == 'pending':
        deposit.status = 'rejected'
        db.session.commit()
        bot.edit_message_text(f"Deposit #{deposit_id} rejected", call.message.chat.id, call.message.message_id)
        bot.answer_callback_query(call.id, "Rejected")

@app.route('/')
def home():
    return "Bot is running!"

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(host='0.0.0.0', port=8080)