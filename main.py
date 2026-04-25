import os
import json
import secrets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
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

# Пароль админки из переменных окружения Render (БЕЗОПАСНО!)
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change_me_immediately")

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

# ========== АДМИН-ПАНЕЛЬ (ПАРОЛЬ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ) ==========

@app.get("/admin")
async def admin_panel(request: Request):
    password = request.query_params.get("pass")
    
    if password != ADMIN_PASSWORD:
        return {"error": "Unauthorized", "hint": "Use ?pass=ваш_пароль"}
    
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
            h1 {{ margin-bottom: 20px; color: #00D4FF; }}
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
            <h1>🎮 CryptoGPU Admin Panel</h1>
            
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
                    <thead><tr><th>ID заявки</th><th>User ID</th><th>Сумма (TON)</th><th>Комментарий</th><th>Дата</th><th>Действия</th></tr>
                    </thead>
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
                <div class="search-box">
                    <input type="text" id="searchUserId" placeholder="Введите User ID">
                    <button onclick="searchPlayer()" style="background:#00D4FF; border:none; padding:10px 20px; border-radius:8px; margin-left:10px;">Найти</button>
                </div>
                <div id="searchResult"></div>
            </div>
        </div>
        
        <script>
            function showTab(tab) {
                document.getElementById('deposits-tab').classList.add('hidden');
                document.getElementById('players-tab').classList.add('hidden');
                document.getElementById('search-tab').classList.add('hidden');
                document.getElementById(tab + '-tab').classList.remove('hidden');
                
                document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                event.target.classList.add('active');
            }
            
            async function approveDeposit(depositId, amount, userId) {
                if(!confirm(`Подтвердить пополнение ${amount} TON для пользователя ${userId}?`)) return;
                const password = prompt('Введите пароль администратора');
                if(!password) return;
                const resp = await fetch(`/admin/approve_deposit?pass=${password}&deposit_id=${depositId}&user_id=${userId}&amount=${amount}`);
                const data = await resp.json();
                if(data.success) { alert('✅ Баланс пополнен!'); location.reload(); }
                else { alert('❌ Ошибка: ' + (data.error || 'Неверный пароль')); }
            }
            
            async function rejectDeposit(depositId) {
                if(!confirm('Отклонить заявку?')) return;
                const password = prompt('Введите пароль администратора');
                if(!password) return;
                const resp = await fetch(`/admin/reject_deposit?pass=${password}&deposit_id=${depositId}`);
                const data = await resp.json();
                if(data.success) { alert('✅ Заявка отклонена'); location.reload(); }
                else { alert('❌ Ошибка: ' + (data.error || 'Неверный пароль')); }
            }
            
            async function searchPlayer() {
                const userId = document.getElementById('searchUserId').value;
                if(!userId) return;
                const password = prompt('Введите пароль администратора');
                if(!password) return;
                const resp = await fetch(`/admin/player?pass=${password}&user_id=${userId}`);
                const data = await resp.json();
                if(data.success) {
                    document.getElementById('searchResult').innerHTML = `
                        <div style="background:rgba(255,255,255,0.1); border-radius:16px; padding:16px; margin-top:16px;">
                            <h4>📊 Данные игрока</h4>
                            <p><strong>User ID:</strong> ${data.player.user_id}</p>
                            <p><strong>Имя:</strong> ${data.player.name}</p>
                            <p><strong>💰 TON:</strong> ${data.player.ton}</p>
                            <p><strong>⚡ GPU:</strong> ${data.player.gpu}</p>
                            <p><strong>👥 Друзей:</strong> ${data.player.friends}</p>
                            <button onclick="giveBonus('${userId}')" style="background:#FFB347; border:none; padding:8px 16px; border-radius:8px;">🎁 Начислить бонус 10 TON</button>
                        </div>
                    `;
                } else {
                    document.getElementById('searchResult').innerHTML = '<p>❌ Игрок не найден</p>';
                }
            }
            
            async function giveBonus(userId) {
                const amount = prompt('Сколько TON начислить?', '10');
                if(!amount) return;
                const password = prompt('Введите пароль администратора');
                if(!password) return;
                const resp = await fetch(`/admin/give_bonus?pass=${password}&user_id=${userId}&amount=${amount}`);
                const data = await resp.json();
                if(data.success) alert(`✅ Начислено ${amount} TON!`);
                else alert('❌ Ошибка: ' + (data.error || 'Неверный пароль'));
            }
        </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html, status_code=200)

@app.get("/admin/approve_deposit")
async def approve_deposit(deposit_id: str, user_id: str, amount: float, passw: str = ""):
    if passw != ADMIN_PASSWORD:
        return {"success": False, "error": "Unauthorized"}
    
    with get_db() as conn:
        deposit = conn.execute("SELECT status FROM deposits WHERE id = ?", (deposit_id,)).fetchone()
        if not deposit or deposit["status"] != "pending":
            return {"success": False, "error": "Deposit not found or already processed"}
        
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
        conn.execute("UPDATE deposits SET status = 'approved' WHERE id = ?", (deposit_id,))
    
    return {"success": True}

@app.get("/admin/reject_deposit")
async def reject_deposit(deposit_id: str, passw: str = ""):
    if passw != ADMIN_PASSWORD:
        return {"success": False, "error": "Unauthorized"}
    
    with get_db() as conn:
        conn.execute("UPDATE deposits SET status = 'rejected' WHERE id = ?", (deposit_id,))
    
    return {"success": True}

@app.get("/admin/player")
async def get_player(user_id: str, passw: str = ""):
    if passw != ADMIN_PASSWORD:
        return {"success": False, "error": "Unauthorized"}
    
    with get_db() as conn:
        player = conn.execute(
            "SELECT user_id, name, ton, gpu, friends FROM players WHERE user_id = ?",
            (user_id,)
        ).fetchone()
    
    if player:
        return {"success": True, "player": dict(player)}
    return {"success": False}

@app.get("/admin/give_bonus")
async def give_bonus(user_id: str, amount: float, passw: str = ""):
    if passw != ADMIN_PASSWORD:
        return {"success": False, "error": "Unauthorized"}
    
    with get_db() as conn:
        conn.execute("UPDATE players SET ton = ton + ? WHERE user_id = ?", (amount, user_id))
    
    return {"success": True}

# ========== ЗАПУСК ==========
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
