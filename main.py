import os
import json
import secrets
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import datetime, timedelta
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

# Пароль админки из переменных окружения Render
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change_me_immediately")

# Простая сессия (в памяти, для одного админа)
admin_session = {
    "authenticated": False,
    "expires_at": None
}

def is_admin_authenticated(request: Request):
    """Проверяет, есть ли валидная сессия"""
    session_token = request.cookies.get("admin_session")
    if session_token and admin_session["authenticated"] and admin_session["expires_at"] > datetime.now():
        return True
    return False

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

# --- Эндпоинты игры ---
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

# ========== АДМИН-ПАНЕЛЬ С СЕССИЕЙ ==========

@app.get("/admin")
async def admin_panel(request: Request):
    # Проверяем сессию
    if is_admin_authenticated(request):
        return await render_admin_dashboard(request)
    
    # Показываем форму входа
    return HTMLResponse(content="""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: system-ui, -apple-system, sans-serif;
                background: linear-gradient(135deg, #0B0E1A 0%, #1A1F35 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                color: #fff;
            }
            .login-container {
                background: rgba(12, 18, 32, 0.95);
                backdrop-filter: blur(20px);
                border-radius: 32px;
                padding: 40px;
                width: 90%;
                max-width: 400px;
                border: 1px solid rgba(0, 212, 255, 0.3);
                box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            }
            h1 {
                text-align: center;
                margin-bottom: 10px;
                color: #00D4FF;
                font-size: 28px;
            }
            .subtitle {
                text-align: center;
                color: #8EA3D4;
                margin-bottom: 30px;
                font-size: 14px;
            }
            input {
                width: 100%;
                padding: 14px 16px;
                margin-bottom: 20px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(0, 212, 255, 0.3);
                border-radius: 16px;
                color: white;
                font-size: 16px;
                outline: none;
                transition: all 0.3s;
            }
            input:focus {
                border-color: #00D4FF;
                box-shadow: 0 0 10px rgba(0, 212, 255, 0.3);
            }
            button {
                width: 100%;
                padding: 14px;
                background: linear-gradient(95deg, #00D4FF, #0066FF);
                border: none;
                border-radius: 16px;
                color: white;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: transform 0.2s;
            }
            button:hover {
                transform: translateY(-2px);
            }
            button:active {
                transform: translateY(0);
            }
            .error {
                background: rgba(220, 38, 38, 0.2);
                border: 1px solid #DC2626;
                border-radius: 12px;
                padding: 12px;
                margin-bottom: 20px;
                text-align: center;
                color: #FF8A8A;
                font-size: 14px;
            }
        </style>
    </head>
    <body>
        <div class="login-container">
            <h1>🔐 Admin Login</h1>
            <div class="subtitle">Введите пароль для доступа к панели управления</div>
            <form method="post" action="/admin/login">
                <input type="password" name="password" placeholder="Введите пароль" autofocus>
                <button type="submit">Войти</button>
            </form>
        </div>
    </body>
    </html>
    """)

@app.post("/admin/login")
async def admin_login(request: Request):
    form = await request.form()
    password = form.get("password")
    
    if password == ADMIN_PASSWORD:
        # Устанавливаем сессию на 24 часа
        admin_session["authenticated"] = True
        admin_session["expires_at"] = datetime.now() + timedelta(hours=24)
        
        response = RedirectResponse(url="/admin", status_code=303)
        response.set_cookie(
            key="admin_session",
            value=secrets.token_hex(32),
            max_age=86400,  # 24 часа
            httponly=True,
            secure=True,
            samesite="lax"
        )
        return response
    
    # Неверный пароль
    return HTMLResponse(content="""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Admin Login</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: system-ui, -apple-system, sans-serif;
                background: linear-gradient(135deg, #0B0E1A 0%, #1A1F35 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                color: #fff;
            }
            .login-container {
                background: rgba(12, 18, 32, 0.95);
                backdrop-filter: blur(20px);
                border-radius: 32px;
                padding: 40px;
                width: 90%;
                max-width: 400px;
                border: 1px solid rgba(0, 212, 255, 0.3);
            }
            h1 { text-align: center; margin-bottom: 10px; color: #00D4FF; }
            .subtitle { text-align: center; color: #8EA3D4; margin-bottom: 30px; }
            input {
                width: 100%;
                padding: 14px 16px;
                margin-bottom: 20px;
                background: rgba(0, 0, 0, 0.4);
                border: 1px solid rgba(0, 212, 255, 0.3);
                border-radius: 16px;
                color: white;
                font-size: 16px;
            }
            button {
                width: 100%;
                padding: 14px;
                background: linear-gradient(95deg, #00D4FF, #0066FF);
                border: none;
                border-radius: 16px;
                color: white;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
            }
            .error {
                background: rgba(220, 38, 38, 0.2);
                border: 1px solid #DC2626;
                border-radius: 12px;
                padding: 12px;
                margin-bottom: 20px;
                text-align: center;
                color: #FF8A8A;
            }
        </style>
    </head>
    <body>
        <div class="login-container">
            <h1>🔐 Admin Login</h1>
            <div class="subtitle">Неверный пароль</div>
            <form method="post" action="/admin/login">
                <input type="password" name="password" placeholder="Введите пароль">
                <button type="submit">Попробовать снова</button>
            </form>
        </div>
    </body>
    </html>
    """, status_code=401)

@app.get("/admin/logout")
async def admin_logout():
    admin_session["authenticated"] = False
    admin_session["expires_at"] = None
    response = RedirectResponse(url="/admin", status_code=303)
    response.delete_cookie("admin_session")
    return response

async def render_admin_dashboard(request: Request):
    """Рендерит админ-панель (требует авторизации)"""
    with get_db() as conn:
        total_players = conn.execute("SELECT COUNT(*) as count FROM players").fetchone()["count"]
        total_deposits_pending = conn.execute("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'").fetchone()["count"]
        total_ton = conn.execute("SELECT SUM(ton) as sum FROM players").fetchone()["sum"] or 0
        
        pending_deposits = conn.execute(
            "SELECT id, user_id, amount, comment, created_at FROM deposits WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
        
        top_players = conn.execute(
            "SELECT user_id, name, ton, gpu, friends FROM players ORDER BY ton DESC LIMIT 10"
        ).fetchall()
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Game Admin Panel</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{ font-family: system-ui, -apple-system, sans-serif; background: #0B0E1A; color: #fff; padding: 20px; }}
            .container {{ max-width: 1200px; margin: 0 auto; }}
            .header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }}
            h1 {{ color: #00D4FF; }}
            .logout-btn {{ background: #DC2626; padding: 8px 16px; border-radius: 8px; text-decoration: none; color: white; }}
            .stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 30px; }}
            .stat-card {{ background: rgba(255,255,255,0.1); border-radius: 16px; padding: 16px; backdrop-filter: blur(10px); }}
            .stat-value {{ font-size: 32px; font-weight: bold; color: #FFB347; }}
            .stat-label {{ font-size: 12px; color: #8EA3D4; margin-top: 8px; }}
            table {{ width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.05); border-radius: 16px; overflow: hidden; margin-bottom: 30px; }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }}
            th {{ background: rgba(0,212,255,0.2); color: #00D4FF; }}
            .approve-btn {{ background: #00A86B; border: none; padding: 6px 12px; border-radius: 8px; color: white; cursor: pointer; margin-right: 6px; }}
            .reject-btn {{ background: #DC2626; border: none; padding: 6px 12px; border-radius: 8px; color: white; cursor: pointer; }}
            .search-box {{ margin-bottom: 20px; }}
            .search-box input {{ background: rgba(255,255,255,0.1); border: 1px solid rgba(0,212,255,0.3); padding: 10px; border-radius: 8px; color: white; width: 300px; }}
            .nav-tabs {{ display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px; }}
            .nav-tab {{ padding: 8px 16px; cursor: pointer; border-radius: 8px; }}
            .nav-tab.active {{ background: #00D4FF; color: #0B0E1A; }}
            .hidden {{ display: none; }}
            button {{ cursor: pointer; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎮 CryptoGPU Admin Panel</h1>
                <a href="/admin/logout" class="logout-btn">🚪 Выйти</a>
            </div>
            
            <div class="stats">
                <div class="stat-card"><div class="stat-value">{total_players}</div><div class="stat-label">👥 Всего игроков</div></div>
                <div class="stat-card"><div class="stat-value">{total_ton:.2f}</div><div class="stat-label">💰 Всего TON на балансах</div></div>
                <div class="stat-card"><div class="stat-value">{total_deposits_pending}</div><div class="stat-label">⏳ Заявок на пополнение</div></div>
            </div>
            
            <div class="nav-tabs">
                <div class="nav-tab active" onclick="showTab('deposits')">💎 Заявки на пополнение</div>
                <div class="nav-tab" onclick="showTab('players')">🏆 Топ игроков</div>
                <div class="nav-tab" onclick="showTab('search')">🔍 Поиск игрока</div>
            </div>
            
            <div id="deposits-tab">
                <h3>⏳ Ожидают подтверждения</h3>
                <table>
                    <thead><tr><th>ID заявки</th><th>User ID</th><th>Сумма (TON)</th><th>Комментарий</th><th>Дата</th><th>Действия</th></tr></thead>
                    <tbody>
    """
    
    for d in pending_deposits:
        html += f"""
        <tr>
            <td><code>{d['id']}</code></td>
            <td>{d['user_id']}</td>
            <td>{d['amount']}</td>
            <td><code>{d['comment']}</code></td>
            <td>{d['created_at']}</td>
            <td>
                <button class="approve-btn" onclick="approveDeposit('{d['id']}', {d['amount']}, '{d['user_id']}')">✅ Подтвердить</button>
                <button class="reject-btn" onclick="rejectDeposit('{d['id']}')">❌ Отклонить</button>
            </td>
        </tr>
        """
    
    html += """
                    </tbody>
                </table>
            </div>
            
            <div id="players-tab" class="hidden">
                <h3>🏆 Топ игроков по TON</h3>
                <table>
                    <thead><tr><th>User ID</th><th>Имя</th><th>TON</th><th>GPU</th><th>Друзей</th></tr></thead>
                    <tbody>
    """
    
    for p in top_players:
        html += f"""
        <tr>
            <td>{p['user_id']}</td>
            <td>{p['name']}</td>
            <td>{p['ton']:.2f}</td>
            <td>{p['gpu']}</td>
            <td>{p['friends']}</td>
        </tr>
        """
    
    html += """
                    </tbody>
                </table>
            </div>
            
            <div id="search-tab" class="hidden">
                <h3>🔍 Поиск игрока</h3>
         
