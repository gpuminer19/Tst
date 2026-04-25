import os
import json
import secrets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from datetime import datetime, timedelta
from supabase import create_client, Client

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Supabase подключение
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "change_me")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise Exception("SUPABASE_URL and SUPABASE_KEY must be set in environment variables")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

admin_session = {"authenticated": False, "expires_at": None}

def is_admin_authenticated(request: Request):
    if admin_session["authenticated"] and admin_session["expires_at"] > datetime.now():
        return True
    return False

def safe_json_loads(data):
    try:
        return json.loads(data) if data else {}
    except:
        return {}

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
        return {"success": False, "error": "Unknown action"}
    except Exception as e:
        return {"success": False, "error": str(e)}

async def register_player(data):
    user_id = data["user_id"]
    name = data["name"]
    referrer_id = data.get("referrer_id")
    
    # Проверяем существование
    existing = supabase.table("players").select("*").eq("user_id", user_id).execute()
    
    if existing.data:
        player = existing.data[0]
        return {
            "success": True,
            "data": {
                "ton": player["ton"],
                "gpu": player["gpu"],
                "friends": player["friends"],
                "state": safe_json_loads(player.get("state"))
            }
        }
    
    # Новый игрок
    if referrer_id and referrer_id != user_id:
        try:
            supabase.table("referrals").insert({
                "referrer_id": referrer_id,
                "friend_id": user_id,
                "friend_name": name
            }).execute()
            # Увеличиваем счётчик друзей у реферера
            referrer = supabase.table("players").select("friends").eq("user_id", referrer_id).execute()
            if referrer.data:
                new_friends = referrer.data[0]["friends"] + 1
                supabase.table("players").update({"friends": new_friends}).eq("user_id", referrer_id).execute()
        except Exception as e:
            print(f"Referral error: {e}")
    
    supabase.table("players").insert({
        "user_id": user_id,
        "name": name,
        "referrer_id": referrer_id,
        "ton": 5.0,
        "gpu": 0,
        "friends": 0
    }).execute()
    
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
    
    state_json = json.dumps(state) if state else None
    
    supabase.table("players").update({
        "ton": ton,
        "gpu": gpu,
        "friends": friends,
        "state": state_json
    }).eq("user_id", user_id).execute()
    
    # Реферальная комиссия
    if ton_earned > 0:
        try:
            referrer = supabase.table("players").select("referrer_id").eq("user_id", user_id).execute()
            if referrer.data and referrer.data[0].get("referrer_id"):
                ref_id = referrer.data[0]["referrer_id"]
                commission = ton_earned * 0.1
                current = supabase.table("players").select("ton").eq("user_id", ref_id).execute()
                if current.data:
                    new_ton = current.data[0]["ton"] + commission
                    supabase.table("players").update({"ton": new_ton}).eq("user_id", ref_id).execute()
        except Exception as e:
            print(f"Commission error: {e}")
    
    return {"success": True}

async def get_referrals(data):
    user_id = data["user_id"]
    referrals = supabase.table("referrals").select("friend_name, date").eq("referrer_id", user_id).order("date", desc=True).execute()
    return {
        "success": True,
        "referrals": [{"friend_name": r["friend_name"], "date": r["date"]} for r in referrals.data]
    }

async def create_deposit(data):
    user_id = data["user_id"]
    amount = float(data["amount"])
    deposit_id = secrets.token_hex(8)
    wallet = "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    comment = f"DEP_{user_id}_{deposit_id}"
    
    supabase.table("deposits").insert({
        "id": deposit_id,
        "user_id": user_id,
        "amount": amount,
        "wallet": wallet,
        "comment": comment
    }).execute()
    
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
    return {"message": "Game Backend Running", "status": "ok"}

# ========== АДМИНКА ==========

LOGIN_HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#0B0E1A 0%,#1A1F35 100%);min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}
.login-card{background:rgba(18,25,45,0.95);backdrop-filter:blur(20px);border-radius:32px;padding:32px 24px;width:100%;max-width:340px;border:1px solid rgba(0,212,255,0.3)}
h1{font-size:28px;text-align:center;margin-bottom:8px;background:linear-gradient(135deg,#00D4FF,#0066FF);-webkit-background-clip:text;background-clip:text;color:transparent}
.subtitle{text-align:center;color:#8EA3D4;font-size:14px;margin-bottom:32px}
input{width:100%;padding:14px 16px;background:rgba(0,0,0,0.4);border:1px solid rgba(0,212,255,0.3);border-radius:16px;color:#fff;font-size:16px;outline:none;margin-bottom:20px}
input:focus{border-color:#00D4FF}
button{width:100%;padding:14px;background:linear-gradient(95deg,#00D4FF,#0066FF);border:none;border-radius:16px;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button:active{transform:scale(0.97)}
</style>
</head>
<body>
<div class="login-card">
<h1>Admin Panel</h1>
<div class="subtitle">Enter password</div>
<form method="post" action="/admin/login">
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Login</button>
</form>
</div>
</body>
</html>'''

@app.get("/admin")
async def admin_panel(request: Request):
    if is_admin_authenticated(request):
        return await render_admin()
    return HTMLResponse(content=LOGIN_HTML)

@app.post("/admin/login")
async def admin_login(request: Request):
    form = await request.form()
    if form.get("password") == ADMIN_PASSWORD:
        admin_session["authenticated"] = True
        admin_session["expires_at"] = datetime.now() + timedelta(hours=24)
        response = RedirectResponse(url="/admin", status_code=303)
        response.set_cookie("admin_session", secrets.token_hex(32), max_age=86400, httponly=True)
        return response
    return HTMLResponse(content="<h1>Wrong password</h1><a href='/admin'>Try again</a>", status_code=401)

@app.get("/admin/logout")
async def admin_logout():
    admin_session["authenticated"] = False
    response = RedirectResponse(url="/admin", status_code=303)
    response.delete_cookie("admin_session")
    return response

async def render_admin():
    # Получаем данные из Supabase
    players_data = supabase.table("players").select("*").execute()
    total_players = len(players_data.data) if players_data.data else 0
    total_ton = sum(p["ton"] for p in players_data.data) if players_data.data else 0
    total_gpu = sum(p["gpu"] for p in players_data.data) if players_data.data else 0
    
    deposits = supabase.table("deposits").select("*").eq("status", "pending").order("created_at", desc=True).limit(30).execute()
    pending_count = len(deposits.data) if deposits.data else 0
    
    top = supabase.table("players").select("user_id,name,ton,gpu,friends").order("ton", desc=True).limit(10).execute()
    recent = supabase.table("players").select("user_id,name,ton,created_at").order("created_at", desc=True).limit(10).execute()
    
    deposits_html = ""
    if deposits.data:
        for d in deposits.data:
            deposits_html += f'''
            <div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px;margin-bottom:12px;border-left:3px solid #FFB347">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:20px;font-weight:700;color:#FFB347">{d["amount"]} TON</span><span style="font-size:11px;color:#6B7CA8">{d["created_at"][:16] if d["created_at"] else ""}</span></div>
                <div style="font-size:12px;margin-bottom:8px">ID: <code style="background:rgba(0,0,0,0.4);padding:4px 8px;border-radius:8px">{d["user_id"]}</code></div>
                <div style="font-size:12px;margin-bottom:12px">Comment: <code style="background:rgba(0,0,0,0.4);padding:4px 8px;border-radius:8px">{d["comment"]}</code></div>
                <div style="display:flex;gap:8px"><button onclick="approve('{d["id"]}','{d["user_id"]}',{d["amount"]})" style="background:#00A86B;border:none;padding:8px 16px;border-radius:30px;color:#fff">Confirm</button><button onclick="reject('{d["id"]}')" style="background:#DC2626;border:none;padding:8px 16px;border-radius:30px;color:#fff">Reject</button></div>
            </div>'''
    else:
        deposits_html = '<div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px;text-align:center;color:#6B7CA8">No pending deposits</div>'
    
    top_html = ""
    if top.data:
        for i, p in enumerate(top.data):
            top_html += f'''<div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between"><span><span style="background:rgba(0,212,255,0.15);padding:4px 10px;border-radius:20px;font-size:11px">#{i+1}</span> <strong>{p["name"][:25]}</strong></span><span style="color:#00D4FF;font-weight:700">{p["ton"]:.2f} TON</span></div><div style="font-size:11px;color:#6B7CA8;margin-top:8px">GPU: {p["gpu"]} | Friends: {p["friends"]} | ID: {p["user_id"][:12]}...</div></div>'''
    
    recent_html = ""
    if recent.data:
        for p in recent.data:
            recent_html += f'''<div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between"><strong>{p["name"][:25]}</strong><span style="color:#00D4FF">{p["ton"]:.2f} TON</span></div><div style="font-size:11px;color:#6B7CA8;margin-top:8px">ID: <code>{p["user_id"]}</code> | {p["created_at"][:16] if p["created_at"] else ""}</div></div>'''
    
    html = f'''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>CryptoGPU Admin</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0B0E1A;color:#fff;padding:16px;padding-bottom:32px}}
.header{{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}}
h1{{font-size:24px;background:linear-gradient(135deg,#00D4FF,#0066FF);-webkit-background-clip:text;background-clip:text;color:transparent}}
.logout-btn{{background:rgba(220,38,38,0.2);padding:8px 16px;border-radius:30px;text-decoration:none;color:#FF6B6B;font-size:14px}}
.stats-grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:24px}}
.stat-card{{background:linear-gradient(135deg,rgba(0,50,100,0.4),rgba(0,20,50,0.6));border-radius:20px;padding:16px;border:1px solid rgba(0,212,255,0.2)}}
.stat-value{{font-size:28px;font-weight:800;background:linear-gradient(135deg,#FFF,#A0C4FF);-webkit-background-clip:text;background-clip:text;color:transparent}}
.stat-label{{font-size:12px;color:#8EA3D4;margin-top:6px}}
.tabs{{display:flex;gap:8px;margin-bottom:20px;background:rgba(12,18,32,0.8);padding:6px;border-radius:60px;position:sticky;top:10px;backdrop-filter:blur(20px)}}
.tab-btn{{flex:1;padding:10px 0;background:transparent;border:none;color:#6B7CA8;font-size:13px;font-weight:600;border-radius:40px;cursor:pointer}}
.tab-btn.active{{background:linear-gradient(95deg,#00D4FF,#0066FF);color:#0B0E1A}}
.tab-content{{display:none;animation:fadeIn 0.25s}}
.tab-content.active{{display:block}}
@keyframes fadeIn{{from{{opacity:0;transform:translateY(8px)}}to{{opacity:1;transform:translateY(0)}}}}
.search-box{{display:flex;gap:8px;margin-bottom:16px}}
.search-box input{{flex:1;background:rgba(0,0,0,0.4);border:1px solid rgba(0,212,255,0.3);padding:12px 16px;border-radius:40px;color:#fff;font-size:14px;outline:none}}
button{{cursor:pointer}}
button:active{{transform:scale(0.96)}}
</style>
</head>
<body>
<div class="header">
<h1>GPU Crypto Admin</h1>
<a href="/admin/logout" class="logout-btn">Logout</a>
</div>
<div class="stats-grid">
<div class="stat-card"><div class="stat-value">{total_players}</div><div class="stat-label">Players</div></div>
<div class="stat-card"><div class="stat-value">{total_ton:.1f}</div><div class="stat-label">Total TON</div></div>
<div class="stat-card"><div class="stat-value">{total_gpu}</div><div class="stat-label">Total GPU</div></div>
<div class="stat-card"><div class="stat-value">{pending_count}</div><div class="stat-label">Deposits</div></div>
</div>
<div class="tabs">
<button class="tab-btn active" onclick="switchTab('deposits')">Deposits</button>
<button class="tab-btn" onclick="switchTab('top')">Top Players</button>
<button class="tab-btn" onclick="switchTab('recent')">New</button>
<button class="tab-btn" onclick="switchTab('search')">Search</button>
</div>
<div id="deposits" class="tab-content active">{deposits_html}</div>
<div id="top" class="tab-content">{top_html}</div>
<div id="recent" class="tab-content">{recent_html}</div>
<div id="search" class="tab-content">
<div class="search-box"><input type="text" id="searchUserId" placeholder="Enter Telegram ID"><button onclick="searchPlayer()">Search</button></div>
<div id="searchResult"></div>
</div>
<script>
function switchTab(tabId){{
document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
document.getElementById(tabId).classList.add('active');
event.target.classList.add('active');
}}
async function approve(id,uid,amt){{
if(!confirm('Confirm '+amt+' TON?')) return;
let r=await fetch(`/admin/api/approve?deposit_id=${{id}}&user_id=${{uid}}&amount=${{amt}}`);
let d=await r.json();
if(d.success){{alert('Approved!');location.reload();}}else{{alert('Error');}}
}}
async function reject(id){{
if(!confirm('Reject deposit?')) return;
let r=await fetch(`/admin/api/reject?deposit_id=${{id}}`);
let d=await r.json();
if(d.success){{alert('Rejected');location.reload();}}else{{alert('Error');}}
}}
async function searchPlayer(){{
let uid=document.getElementById('searchUserId').value.trim();
if(!uid){{alert('Enter ID');return;}}
let r=await fetch(`/admin/api/player?user_id=${{uid}}`);
let d=await r.json();
let c=document.getElementById('searchResult');
if(d.success&&d.player){{
c.innerHTML=`<div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px"><div><strong>${{d.player.name||'No name'}}</strong></div><div>TON: <strong>${{d.player.ton?.toFixed(2)||0}}</strong></div><div>GPU: <strong>${{d.player.gpu||0}}</strong></div><div>Friends: <strong>${{d.player.friends||0}}</strong></div><div style="font-size:11px;margin:12px 0">ID: <code>${{d.player.user_id}}</code></div><hr style="border-color:rgba(255,255,255,0.1);margin:12px 0"><div style="display:flex;gap:8px"><input type="number" id="bonusAmount" placeholder="Amount" value="10" style="flex:1;background:#0B0E1A;border:1px solid #00D4FF30;border-radius:30px;padding:8px 12px;color:#fff"><button onclick="giveBonus('${{d.player.user_id}}')" style="background:#FFB347;border:none;padding:8px 16px;border-radius:30px">Give Bonus</button></div></div>`;
}}else{{
c.innerHTML='<div style="background:rgba(12,18,32,0.75);border-radius:20px;padding:16px;text-align:center;color:#DC2626">Player not found</div>';
}}
}}
async function giveBonus(uid){{
let amt=document.getElementById('bonusAmount')?.value;
if(!amt) amt=prompt('Bonus amount (TON):','10');
if(!amt) return;
let r=await fetch(`/admin/api/bonus?user_id=${{uid}}&amount=${{amt}}`);
let d=await r.json();
if(d.success){{alert(`Added ${{amt}} TON!`);searchPlayer();}}else{{alert('Error');}}
}}
</script>
</body>
</html>'''
    return HTMLResponse(content=html)

@app.get("/admin/api/approve")
async def api_approve(request: Request, deposit_id: str, user_id: str, amount: float):
    if not is_admin_authenticated(request):
        return {"success": False}
    try:
        player = supabase.table("players").select("ton").eq("user_id", user_id).execute()
        if player.data:
            new_ton = player.data[0]["ton"] + amount
            supabase.table("players").update({"ton": new_ton}).eq("user_id", user_id).execute()
        supabase.table("deposits").update({"status": "approved"}).eq("id", deposit_id).execute()
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/admin/api/reject")
async def api_reject(request: Request, deposit_id: str):
    if not is_admin_authenticated(request):
        return {"success": False}
    try:
        supabase.table("deposits").update({"status": "rejected"}).eq("id", deposit_id).execute()
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/admin/api/player")
async def api_player(request: Request, user_id: str):
    if not is_admin_authenticated(request):
        return {"success": False}
    try:
        player = supabase.table("players").select("user_id,name,ton,gpu,friends").eq("user_id", user_id).execute()
        if player.data:
            return {"success": True, "player": player.data[0]}
        return {"success": False}
    except Exception as e:
        return {"success": False}

@app.get("/admin/api/bonus")
async def api_bonus(request: Request, user_id: str, amount: float):
    if not is_admin_authenticated(request):
        return {"success": False}
    try:
        player = supabase.table("players").select("ton").eq("user_id", user_id).execute()
        if player.data:
            new_ton = player.data[0]["ton"] + amount
            supabase.table("players").update({"ton": new_ton}).eq("user_id", user_id).execute()
        return {"success": True}
    except Exception as e:
        return {"success": False}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
