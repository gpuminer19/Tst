import os
import json
import secrets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
import sqlite3
from contextlib import contextmanager

app = FastAPI()

# Разрешаем запросы от Telegram WebApp
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- База данных ---
DATABASE = "game.db"

@contextmanager
def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS players (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                ton REAL DEFAULT 5.0,
                gpu INTEGER DEFAULT 0,
                friends INTEGER DEFAULT 0,
                referrer_id TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                state TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS referrals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referrer_id TEXT,
                friend_id TEXT,
                friend_name TEXT,
                date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS deposits (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                amount REAL,
                wallet TEXT,
                comment TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

init_db()

# --- Эндпоинты ---
@app.post("/api/tg")
async def telegram_api(request: Request):
    try:
        data = await request.json()
        action = data.get("action")
        
        if action == "register":
            return await register_player(data)
        elif action == "save":
            return await save_player(data)
        elif action == "getReferrals":
            return await get_referrals(data)
        elif action == "createDeposit":
            return await create_deposit(data)
        else:
            return {"success": False, "error": "Unknown action"}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def register_player(data):
    user_id = data["user_id"]
    name = data["name"]
    referrer_id = data.get("referrer_id")
    
    with get_db() as conn:
        existing = conn.execute("SELECT * FROM players WHERE user_id = ?", (user_id,)).fetchone()
        
        if existing:
            state = json.loads(existing["state"]) if existing["state"] else {}
            return {
                "success": True,
                "data": {
                    "ton": existing["ton"],
                    "gpu": existing["gpu"],
                    "friends": existing["friends"],
                    "state": state
                }
            }
        
        if referrer_id and referrer_id != user_id:
            conn.execute(
                "INSERT INTO referrals (referrer_id, friend_id, friend_name) VALUES (?, ?, ?)",
                (referrer_id, user_id, name)
            )
            conn.execute(
                "UPDATE players SET friends = friends + 1 WHERE user_id = ?",
                (referrer_id,)
            )
        
        conn.execute(
            "INSERT INTO players (user_id, name, referrer_id) VALUES (?, ?, ?)",
            (user_id, name, referrer_id)
        )
        
        return {
            "success": True,
            "data": {
                "ton": 5.0,
                "gpu": 0,
                "friends": 0,
                "state": {}
            }
        }

async def save_player(data):
    user_id = data["user_id"]
    ton = data["ton"]
    gpu = data["gpu"]
    friends = data["friends"]
    ton_earned = data.get("ton_earned", 0)
    state = data.get("state")
    
    with get_db() as conn:
        state_json = json.dumps(state) if state else None
        conn.execute(
            "UPDATE players SET ton = ?, gpu = ?, friends = ?, state = ? WHERE user_id = ?",
            (ton, gpu, friends, state_json, user_id)
        )
        
        if ton_earned > 0:
            referrer = conn.execute(
                "SELECT referrer_id FROM players WHERE user_id = ?", (user_id,)
            ).fetchone()
            if referrer and referrer["referrer_id"]:
                commission = ton_earned * 0.1
                conn.execute(
                    "UPDATE players SET ton = ton + ? WHERE user_id = ?",
                    (commission, referrer["referrer_id"])
                )
    
    return {"success": True}

async def get_referrals(data):
    user_id = data["user_id"]
    
    with get_db() as conn:
        referrals = conn.execute(
            "SELECT friend_name, date FROM referrals WHERE referrer_id = ? ORDER BY date DESC",
            (user_id,)
        ).fetchall()
        
        return {
            "success": True,
            "referrals": [
                {"friend_name": r["friend_name"], "date": r["date"]}
                for r in referrals
            ]
        }

async def create_deposit(data):
    user_id = data["user_id"]
    name = data["name"]
    amount = float(data["amount"])
    
    deposit_id = secrets.token_hex(8)
    wallet = "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    comment = f"DEP_{user_id}_{deposit_id}"
    
    with get_db() as conn:
        conn.execute(
            "INSERT INTO deposits (id, user_id, amount, wallet, comment) VALUES (?, ?, ?, ?, ?)",
            (deposit_id, user_id, amount, wallet, comment)
        )
    
    return {
        "success": True,
        "deposit": {
            "amount": amount,
            "wallet": wallet,
            "comment": comment,
            "id": deposit_id
        }
    }

@app.get("/")
async def root():
    return {"message": "Telegram Game Backend is running!", "status": "ok"}

@app.get("/health")
async def health():
    return {"status": "alive"}
