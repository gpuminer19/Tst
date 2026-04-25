import os
import json
import secrets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from datetime import datetime, timedelta
import asyncpg
from contextlib import asynccontextmanager

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Railway сам подставит DATABASE_URL
DATABASE_URL = os.getenv("DATABASE_URL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change_me")

# Подключение к PostgreSQL
async def get_db():
    conn = await asyncpg.connect(DATABASE_URL)
    return conn

async def init_db():
    conn = await get_db()
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS players (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            ton REAL DEFAULT 5.0,
            gpu INTEGER DEFAULT 0,
            friends INTEGER DEFAULT 0,
            referrer_id TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            state TEXT
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS referrals (
            id SERIAL PRIMARY KEY,
            referrer_id TEXT,
            friend_id TEXT,
            friend_name TEXT,
            date TIMESTAMP DEFAULT NOW()
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS deposits (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            amount REAL,
            wallet TEXT,
            comment TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
        )
    """)
    await conn.close()

admin_session = {"authenticated": False, "expires_at": None}

def is_admin_authenticated(request: Request):
    if admin_session["authenticated"] and admin_session["expires_at"] > datetime.now():
        return True
    return False

@app.on_event("startup")
async def startup():
    await init_db()
    print("✅ Database initialized")

@app.post("/api/tg")
async def telegram_api(request: Request):
    try:
        data = await request.json()
        action = data.get("action")
        conn = await get_db()
        
        if action == "register":
            result = await register_player(conn, data)
        elif action == "save":
            result = await save_player(conn, data)
        elif action == "getReferrals":
            result = await get_referrals(conn, data)
        elif action == "createDeposit":
            result = await create_deposit(conn, data)
        else:
            result = {"success": False, "error": "Unknown action"}
        
        await conn.close()
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

async def register_player(conn, data):
    user_id = data["user_id"]
    name = data["name"]
    referrer_id = data.get("referrer_id")
    
    existing = await conn.fetchrow("SELECT * FROM players WHERE user_id = $1", user_id)
    
    if existing:
        return {
            "success": True,
            "data": {
                "ton": existing["ton"],
                "gpu": existing["gpu"],
                "friends": existing["friends"],
                "state": json.loads(existing["state"]) if existing["state"] else {}
            }
        }
    
    if referrer_id and referrer_id != user_id:
        await conn.execute("INSERT INTO referrals (referrer_id, friend_id, friend_name) VALUES ($1, $2, $3)", referrer_id, user_id, name)
        await conn.execute("UPDATE players SET friends = friends + 1 WHERE user_id = $1", referrer_id)
    
    await conn.execute("INSERT INTO players (user_id, name, referrer_id) VALUES ($1, $2, $3)", user_id, name, referrer_id)
    
    return {
        "success": True,
        "data": {
            "ton": 5.0,
            "gpu": 0,
            "friends": 0,
            "state": {}
        }
    }

async def save_player(conn, data):
    user_id = data["user_id"]
    ton = data["ton"]
    gpu = data["gpu"]
    friends = data["friends"]
    ton_earned = data.get("ton_earned", 0)
    state = data.get("state")
    
    state_json = json.dumps(state) if state else None
    
    await conn.execute("UPDATE players SET ton = $1, gpu = $2, friends = $3, state = $4 WHERE user_id = $5", ton, gpu, friends, state_json, user_id)
    
    if ton_earned > 0:
        referrer_id = await conn.fetchval("SELECT referrer_id FROM players WHERE user_id = $1", user_id)
        if referrer_id:
            commission = ton_earned * 0.1
            await conn.execute("UPDATE players SET ton = ton + $1 WHERE user_id = $2", commission, referrer_id)
    
    return {"success": True}

async def get_referrals(conn, data):
    user_id = data["user_id"]
    referrals = await conn.fetch("SELECT friend_name, date FROM referrals WHERE referrer_id = $1 ORDER BY date DESC", user_id)
    return {
        "success": True,
        "referrals": [{"friend_name": r["friend_name"], "date": str(r["date"])} for r in referrals]
    }

async def create_deposit(conn, data):
    user_id = data["user_id"]
    amount = float(data["amount"])
    deposit_id = secrets.token_hex(8)
    wallet = "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    comment = f"DEP_{user_id}_{deposit_id}"
    
    await conn.execute("INSERT INTO deposits (id, user_id, amount, wallet, comment) VALUES ($1, $2, $3, $4, $5)", deposit_id, user_id, amount, wallet, comment)
    
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
    return {"message": "Game Backend Running on Railway!", "status": "ok"}

# ... (остальная админка - такая же как в прошлом коде)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
