import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView

# ========= CONFIG =========

API_SECRET = os.environ.get("API_SECRET", "123")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_IDS = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x]
TON_WALLET = os.environ.get("TON_WALLET", "UQXXXXXXXXXXXX")

app = Flask(__name__)

app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///game.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db = SQLAlchemy(app)

# ========= MODELS =========

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100), unique=True)
    name = db.Column(db.String(200))
    ton = db.Column(db.Float, default=5)
    gpu = db.Column(db.Integer, default=0)
    friends = db.Column(db.Integer, default=0)
    state = db.Column(db.Text, default="{}")

class Deposit(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    amount = db.Column(db.Float)
    comment = db.Column(db.String(200))
    status = db.Column(db.String(20), default="pending")

class Referral(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(100))
    friend_name = db.Column(db.String(200))
    date = db.Column(db.String(50))

# ========= ADMIN =========

admin = Admin(app, name="Admin")

admin.add_view(ModelView(User, db.session))
admin.add_view(ModelView(Deposit, db.session))
admin.add_view(ModelView(Referral, db.session))

# ========= HELPERS =========

def check_key(req):
    return req.headers.get("X-API-KEY") == API_SECRET

# ========= API =========

@app.route("/api", methods=["POST"])
def api():

    if not check_key(request):
        return jsonify({"success": False})

    data = request.json
    action = data.get("action")
    user_id = str(data.get("user_id"))

    user = User.query.filter_by(user_id=user_id).first()

    # ===== REGISTER =====
    if action == "register":
        if not user:
            user = User(user_id=user_id, name=data.get("name"))
            db.session.add(user)
            db.session.commit()

        return jsonify({
            "success": True,
            "data": {
                "ton": user.ton,
                "gpu": user.gpu,
                "friends": user.friends,
                "state": json.loads(user.state)
            }
        })

    # ===== SAVE =====
    if action == "save":
        if user:
            user.ton = data.get("ton", user.ton)
            user.gpu = data.get("gpu", user.gpu)
            if data.get("state"):
                user.state = json.dumps(data.get("state"))
            db.session.commit()

        return jsonify({"success": True})

    # ===== REFERRALS =====
    if action == "getReferrals":
        refs = Referral.query.filter_by(user_id=user_id).all()
        return jsonify({
            "success": True,
            "referrals": [
                {"name": r.friend_name, "date": r.date}
                for r in refs
            ]
        })

    # ===== CREATE DEPOSIT =====
    if action == "createDeposit":
        amount = float(data.get("amount"))
        comment = f"GPU-{user_id}-{int(datetime.now().timestamp())}"

        dep = Deposit(
            user_id=user_id,
            amount=amount,
            comment=comment
        )

        db.session.add(dep)
        db.session.commit()

        return jsonify({
            "success": True,
            "deposit": {
                "wallet": TON_WALLET,
                "amount": amount,
                "comment": comment
            }
        })

    return jsonify({"success": False})

# ========= ROOT =========

@app.route("/")
def home():
    return "OK"

# ========= RUN =========

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
    app.run(host="0.0.0.0", port=8080)
