import os
import json
import secrets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
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

# Список ID администраторов для Telegram (укажите свой ID)
ADMIN_IDS = [123456789]  # ⚠️ ЗАМЕНИТЕ НА ВАШ TELEGRAM ID!

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

# ========== ВЕБ-АДМИН ПАНЕЛЬ ==========

@app.get("/admin")
async def admin_panel(request: Request):
    if is_admin_authenticated(request):
        return await render_admin_dashboard(request)
    
    return HTMLResponse(content='''
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
        </style>
    </head>
    <body>
        <div class="login-container">
            <h1>Admin Login</h1>
            <div class="subtitle">Введите пароль для доступа</div>
            <form method="post" action="/admin/login">
                <input type="password" name="password" placeholder="Введите пароль" autofocus>
                <button type="submit">Войти</button>
            </form>
        </div>
    </body>
    </html>
    ''')

@app.post("/admin/login")
async def admin_login(request: Request):
    form = await request.form()
    password = form.get("password")
    
    if password == ADMIN_PASSWORD:
        admin_session["authenticated"] = True
        admin_session["expires_at"] = datetime.now() + timedelta(hours=24)
        
        response = RedirectResponse(url="/admin", status_code=303)
        response.set_cookie(
            key="admin_session",
            value=secrets.token_hex(32),
            max_age=86400,
            httponly=True,
            secure=True,
            samesite="lax"
        )
        return response
    
    return HTMLResponse(content='''
    <!DOCTYPE html>
    <html>
    <head><title>Error</title></head>
    <body><h1>Неверный пароль</h1><a href="/admin">Попробовать снова</a></body>
    </html>
    ''', status_code=401)

@app.get("/admin/logout")
async def admin_logout():
    admin_session["authenticated"] = False
    admin_session["expires_at"] = None
    response = RedirectResponse(url="/admin", status_code=303)
    response.delete_cookie("admin_session")
    return response

async def render_admin_dashboard(request: Request):
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
    
    html = '<!DOCTYPE html><html><head><title>Admin Panel</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>'
    html += '*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0B0E1A;color:#fff;padding:20px}'
    html += '.container{max-width:1200px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}'
    html += 'h1{color:#00D4FF}.logout-btn{background:#DC2626;padding:8px 16px;border-radius:8px;text-decoration:none;color:white}'
    html += '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}'
    html += '.stat-card{background:rgba(255,255,255,0.1);border-radius:16px;padding:16px}.stat-value{font-size:32px;font-weight:bold;color:#FFB347}'
    html += '.stat-label{font-size:12px;color:#8EA3D4;margin-top:8px}table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.05);border-radius:16px;margin-bottom:30px}'
    html += 'th,td{padding:12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1)}th{background:rgba(0,212,255,0.2);color:#00D4FF}'
    html += '.approve-btn{background:#00A86B;border:none;padding:6px 12px;border-radius:8px;color:white;cursor:pointer;margin-right:6px}'
    html += '.reject-btn{background:#DC2626;border:none;padding:6px 12px;border-radius:8px;color:white;cursor:pointer}'
    html += '.search-box{margin-bottom:20px}.search-box input{background:rgba(255,255,255,0.1);border:1px solid rgba(0,212,255,0.3);padding:10px;border-radius:8px;color:white;width:300px}'
    html += '.nav-tabs{display:flex;gap:10px;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.2);padding-bottom:10px}'
    html += '.nav-tab{padding:8px 16px;cursor:pointer;border-radius:8px}.nav-tab.active{background:#00D4FF;color:#0B0E1A}'
    html += '.hidden{display:none}button{cursor:pointer}</style></head><body><div class="container"><div class="header">'
    html += f'<h1>Game Admin Panel</h1><a href="/admin/logout" class="logout-btn">Выйти</a></div>'
    html += f'<div class="stats"><div class="stat-card"><div class="stat-value">{total_players}</div><div class="stat-label">Всего игроков</div></div>'
    html += f'<div class="stat-card"><div class="stat-value">{total_ton:.2f}</div><div class="stat-label">Всего TON</div></div>'
    html += f'<div class="stat-card"><div class="stat-value">{total_deposits_pending}</div><div class="stat-label">Заявок на пополнение</div></div></div>'
    
    html += '<div class="nav-tabs"><div class="nav-tab active" onclick="showTab(\'deposits\')">Заявки</div>'
    html += '<div class="nav-tab" onclick="showTab(\'players\')">Топ игроков</div>'
    html += '<div class="nav-tab" onclick="showTab(\'search\')">Поиск</div></div>'
    
    html += '<div id="deposits-tab"><h3>Ожидают подтверждения</h3><table><thead><tr><th>ID</th><th>User ID</th><th>Сумма</th><th>Комментарий</th><th>Дата</th><th>Действия</th></tr></thead><tbody>'
    for d in pending_deposits:
        html += f'<tr><td><code>{d["id"][:8]}</code></td><td>{d["user_id"]}</td><td>{d["amount"]} TON</td><td><code>{d["comment"]}</code></td><td>{d["created_at"]}</td>'
        html += f'<td><button class="approve-btn" onclick="approveDeposit(\'{d["id"]}\',{d["amount"]},\'{d["user_id"]}\')">Подтвердить</button>'
        html += f'<button class="reject-btn" onclick="rejectDeposit(\'{d["id"]}\')">Отклонить</button></td></tr>'
    html += '</tbody></table></div>'
    
    html += '<div id="players-tab" class="hidden"><h3>Топ игроков по TON</h3><table><thead><tr><th>User ID</th><th>Имя</th><th>TON</th><th>GPU</th><th>Друзей</th></tr></thead><tbody>'
    for p in top_players:
        html += f'<tr><td>{p["user_id"]}</td><td>{p["name"]}</td><td>{p["ton"]:.2f}</td><td>{p["gpu"]}</td><td>{p["friends"]}</td></tr>'
    html += '</tbody></table></div>'
    
    html += '<div id="search-tab" class="hidden"><h3>Поиск игрока</h3><div class="search-box">'
    html += '<input type="text" id="searchUserId" placeholder="Введите User ID">'
    html += '<button onclick="searchPlayer()" style="background:#00D4FF;padding:10px 20px;margin-left:10px;">Найти</button></div>'
    html += '<div id="searchResult"></div></div></div>'
    
    html += '''
    <script>
    function showTab(tab){
        document.getElementById('deposits-tab').classList.add('hidden');
        document.getElementById('players-tab').classList.add('hidden');
        document.getElementById('search-tab').classList.add('hidden');
        document.getElementById(tab+'-tab').classList.remove('hidden');
        event.target.classList.add('active');
    }
    async function approveDeposit(id,amount,uid){
        if(!confirm('Подтвердить пополнение '+amount+' TON?')) return;
        let r=await fetch('/admin/api/approve_deposit?deposit_id='+id+'&user_id='+uid+'&amount='+amount);
        let d=await r.json();
        if(d.success){alert('Пополнено!');location.reload();}
        else alert('Ошибка');
    }
    async function rejectDeposit(id){
        if(!confirm('Отклонить заявку?')) return;
        let r=await fetch('/admin/api/reject_deposit?deposit_id='+id);
        let d=await r.json();
        if(d.success){alert('Отклонено');location.reload();}
        else alert('Ошибка');
    }
    async function searchPlayer(){
        let uid=document.getElementById('searchUserId').value;
        if(!uid) return;
        let r=await fetch('/admin/api/player?user_id='+uid);
        let d=await r.json();
        if(d.success){
            document.getElementById('searchResult').innerHTML='<div><p><strong>ID:</strong> '+d.player.user_id+'</p><p><strong>Имя:</strong> '+d.player.name+'</p><p><strong>TON:</strong> '+d.player.ton+'</p><p><strong>GPU:</strong> '+d.player.gpu+'</p><p><strong>Друзей:</strong> '+d.player.friends+'</p><button onclick="giveBonus(\''+uid+'\')">Начислить бонус 10 TON</button></div>';
        } else { document.getElementById('searchResult').innerHTML='<p>Игрок не найден</p>'; }
    }
    async function giveBonus(uid){
        let amount=prompt('Сколько TON начислить?','10');
        if(!amount) return;
        let r=await fetch('/admin/api/give_bonus?user_id='+uid+'&amount='+amount);
        let d=await r.json();
        if(d.success) alert('Начислено '+amount+' TON!');
        else alert('Ошибка');
        searchPlayer();
    }
    </script></body></html>
    '''
    return HTMLResponse(content=html)

# API эндпоинты админки
@app.get("/admin/api/approve_deposit")
async def admin_api_approve_deposit(request: Request, deposit_id: str, user_id: str, amount: float):
    if not is_admin_authenticated(request):
        return {"success": False, "error": "Unauthorized"}
    with get_db() as conn:
        deposit = conn.execute("SELECT status FROM deposits WHERE id = ?", (deposit_id,)).fetchone()
        if not deposit or deposit["status"] != "pending":
            return {"success": False, "error": "Deposit not found"}
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
        conn.execute("UPDATE deposits SET status = 'approved' WHERE id = ?", (deposit_id,))
    return {"success": True}

@app.get("/admin/api/reject_deposit")
async def admin_api_reject_deposit(request: Request, deposit_id: str):
    if not is_admin_authenticated(request):
        return {"success": False, "error": "Unauthorized"}
    with get_db() as conn:
        conn.execute("UPDATE deposits SET status = 'rejected' WHERE id = ?", (deposit_id,))
    return {"success": True}

@app.get("/admin/api/player")
async def admin_api_get_player(request: Request, user_id: str):
    if not is_admin_authenticated(request):
        return {"success": False, "error": "Unauthorized"}
    with get_db() as conn:
        player = conn.execute("SELECT user_id, name, ton, gpu, friends FROM players WHERE user_id = ?", (user_id,)).fetchone()
    if player:
        return {"success": True, "player": dict(player)}
    return {"success": False}

@app.get("/admin/api/give_bonus")
async def admin_api_give_bonus(request: Request, user_id: str, amount: float):
    if not is_admin_authenticated(request):
        return {"success": False, "error": "Unauthorized"}
    with get_db() as conn:
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
    return {"success": True}

# ========== ТЕЛЕГРАМ АДМИН-ПАНЕЛЬ ==========

async def send_telegram_message(chat_id: int, text: str, reply_markup: dict = None):
    import httpx
    bot_token = os.getenv("BOT_TOKEN")
    if not bot_token:
        return
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    async with httpx.AsyncClient() as client:
        await client.post(url, json=payload)

async def show_admin_menu(chat_id: int):
    keyboard = {"keyboard": [["📊 Статистика", "👥 Игроки"], ["💎 Заявки", "🎁 Бонус"], ["ℹ️ Помощь"]], "resize_keyboard": True}
    text = "<b>Admin Panel</b>\n\nSelect action:"
    await send_telegram_message(chat_id, text, keyboard)

async def show_statistics(chat_id: int):
    with get_db() as conn:
        total_players = conn.execute("SELECT COUNT(*) as count FROM players").fetchone()["count"]
        total_ton = conn.execute("SELECT SUM(ton) as sum FROM players").fetchone()["sum"] or 0
        pending = conn.execute("SELECT COUNT(*) as count FROM deposits WHERE status = 'pending'").fetchone()["count"]
        top = conn.execute("SELECT name, ton FROM players ORDER BY ton DESC LIMIT 5").fetchall()
    top_text = "\n".join([f"{i+1}. {p['name'][:20]} — {p['ton']:.2f} TON" for i, p in enumerate(top)])
    text = f"Statistics:\nPlayers: {total_players}\nTotal TON: {total_ton:.2f}\nPending deposits: {pending}\n\nTop 5:\n{top_text}"
    await send_telegram_message(chat_id, text)

async def show_deposits_list(chat_id: int):
    with get_db() as conn:
        deposits = conn.execute("SELECT id, user_id, amount, comment FROM deposits WHERE status = 'pending' LIMIT 10").fetchall()
    if not deposits:
        await send_telegram_message(chat_id, "No pending deposits")
        return
    text = "Pending deposits:\n\n"
    for d in deposits:
        text += f"ID: {d['id'][:8]}\nUser: {d['user_id']}\nAmount: {d['amount']} TON\nComment: {d['comment']}\n"
        text += f"Confirm: confirm_{d['id']}_{d['user_id']}_{d['amount']}\nReject: reject_{d['id']}\n\n"
    await send_telegram_message(chat_id, text)

async def show_bonus_menu(chat_id: int):
    text = "Send: bonus_USERID_AMOUNT\nExample: bonus_123456789_10"
    await send_telegram_message(chat_id, text)

async def show_player_info(chat_id: int, user_id: str):
    with get_db() as conn:
        player = conn.execute("SELECT user_id, name, ton, gpu, friends FROM players WHERE user_id = ?", (user_id,)).fetchone()
    if not player:
        await send_telegram_message(chat_id, f"Player {user_id} not found")
        return
    text = f"Player info:\nID: {player['user_id']}\nName: {player['name']}\nTON: {player['ton']:.2f}\nGPU: {player['gpu']}\nFriends: {player['friends']}"
    await send_telegram_message(chat_id, text)

async def approve_deposit_telegram(chat_id: int, deposit_id: str, user_id: str, amount: float):
    with get_db() as conn:
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
        conn.execute("UPDATE deposits SET status = 'approved' WHERE id = ?", (deposit_id,))
    await send_telegram_message(chat_id, f"Approved! {amount} TON added to {user_id}")

async def reject_deposit_telegram(chat_id: int, deposit_id: str):
    with get_db() as conn:
        conn.execute("UPDATE deposits SET status = 'rejected' WHERE id = ?", (deposit_id,))
    await send_telegram_message(chat_id, f"Deposit {deposit_id} rejected")

async def give_bonus_telegram(chat_id: int, user_id: str, amount: float):
    with get_db() as conn:
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
    await send_telegram_message(chat_id, f"Bonus {amount} TON added to {user_id}")

@app.post("/webhook_telegram")
async def webhook_telegram(request: Request):
    try:
        data = await request.json()
        if "message" not in data:
            return {"ok": True}
        msg = data["message"]
        chat_id = msg["chat"]["id"]
        text = msg.get("text", "")
        user_id = msg["from"]["id"]
        
        if user_id not in ADMIN_IDS:
            await send_telegram_message(chat_id, "Access denied")
            return {"ok": True}
        
        if text == "/admin":
            await show_admin_menu(chat_id)
        elif text == "📊 Статистика":
            await show_statistics(chat_id)
        elif text == "💎 Заявки":
            await show_deposits_list(chat_id)
        elif text == "🎁 Бонус":
            await show_bonus_menu(chat_id)
        elif text == "🔙 Назад" or text == "/start":
            await show_admin_menu(chat_id)
        elif text.startswith("confirm_"):
            parts = text.split("_")
            if len(parts) == 4:
                await approve_deposit_telegram(chat_id, parts[1], parts[2], float(parts[3]))
        elif text.startswith("reject_"):
            parts = text.split("_")
            if len(parts) == 2:
                await reject_deposit_telegram(chat_id, parts[1])
        elif text.startswith("bonus_"):
            parts = text.split("_")
            if len(parts) == 3:
                await give_bonus_telegram(chat_id, parts[1], float(parts[2]))
        elif text.isdigit() and len(text) > 5:
            await show_player_info(chat_id, text)
        else:
            await send_telegram_message(chat_id, "Unknown command. Use /admin")
        
        return {"ok": True}
    except Exception as e:
        print(f"Error: {e}")
        return {"ok": True}

# ========== ЗАПУСК ==========
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
