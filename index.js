const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.set('view engine', 'ejs');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 часа
}));

// ========== MongoDB Schemas ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  ton: { type: Number, default: 5.0 },
  gpu: { type: Number, default: 0 },
  friends: { type: Number, default: 0 },
  referrerId: String,
  isBanned: { type: Boolean, default: false },
  banReason: String,
  role: { type: String, default: 'user' }, // user, admin, moderator
  invitedFriends: [{ friendId: String, friendName: String, date: String }],
  gameState: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  lastSeen: Date,
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 }
});

const depositSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  amount: Number,
  wallet: String,
  comment: String,
  status: { type: String, default: 'pending' },
  type: { type: String, default: 'deposit' }, // deposit, withdraw
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  processedBy: String
});

const adminSchema = new mongoose.Schema({
  username: String,
  passwordHash: String,
  role: { type: String, default: 'admin' }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Admin = mongoose.model('Admin', adminSchema);

// ========== Вспомогательные функции ==========
async function ensureAdminExists() {
  const existingAdmin = await Admin.findOne({ username: process.env.ADMIN_USER });
  if (!existingAdmin && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
    await Admin.create({ username: process.env.ADMIN_USER, passwordHash: hash });
    console.log('✅ Admin user created');
  }
}

// Middleware для проверки авторизации
async function requireAuth(req, res, next) {
  if (!req.session.adminId) return res.redirect('/admin/login');
  
  // Проверяем, что сессия валидна
  const admin = await Admin.findById(req.session.adminId);
  if (!admin) {
    req.session.destroy();
    return res.redirect('/admin/login');
  }
  req.admin = admin;
  next();
}

// ========== API для игры ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, ton_earned, state } = req.body;
  
  try {
    // Проверка бана
    const bannedUser = await User.findOne({ userId: user_id, isBanned: true });
    if (bannedUser) {
      return res.status(403).json({ 
        success: false, 
        error: 'BANNED', 
        message: `Ваш аккаунт заблокирован. Причина: ${bannedUser.banReason || 'Нарушение правил'}`
      });
    }
    
    if (action === 'register') {
      let user = await User.findOne({ userId: user_id });
      if (!user) {
        user = new User({ 
          userId: user_id, 
          name: name || 'Игрок',
          ton: 5.0,
          gpu: 0,
          friends: 0,
          invitedFriends: []
        });
        
        if (referrer_id && referrer_id !== user_id) {
          const referrer = await User.findOne({ userId: referrer_id });
          if (referrer && !referrer.isBanned) {
            referrer.invitedFriends.push({
              friendId: user_id,
              friendName: name,
              date: new Date().toLocaleDateString()
            });
            referrer.friends = referrer.invitedFriends.length;
            await referrer.save();
          }
        }
        await user.save();
      }
      
      return res.json({
        success: true,
        data: {
          ton: user.ton,
          gpu: user.gpu,
          friends: user.friends,
          isBanned: user.isBanned,
          state: user.gameState || {}
        }
      });
    }
    
    if (action === 'save') {
      await User.findOneAndUpdate(
        { userId: user_id },
        { 
          ton: ton !== undefined ? ton : undefined,
          gpu: gpu !== undefined ? gpu : undefined,
          friends: friends !== undefined ? friends : undefined,
          gameState: state,
          lastSeen: new Date()
        },
        { upsert: true }
      );
      return res.json({ success: true });
    }
    
    if (action === 'getReferrals') {
      const user = await User.findOne({ userId: user_id });
      const referrals = (user?.invitedFriends || []).map(f => ({
        friend_name: f.friendName,
        date: f.date
      }));
      return res.json({ success: true, referrals });
    }
    
    if (action === 'createDeposit') {
      const comment = `DEPOSIT_${user_id}_${Date.now()}`;
      const deposit = new Deposit({
        userId: user_id,
        userName: name,
        amount: amount,
        wallet: process.env.TON_WALLET || "EQD...",
        comment: comment,
        type: 'deposit'
      });
      await deposit.save();
      
      return res.json({
        success: true,
        deposit: { amount: amount, wallet: process.env.TON_WALLET, comment: comment }
      });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== Админ-панель (мобильная, с функциями) ==========

// Страница логина
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
      <title>Admin Login</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0B0E1A; color: white; font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
        .card { background: #1A1F35; padding: 30px; border-radius: 28px; width: 100%; max-width: 350px; }
        h2 { margin-bottom: 24px; text-align: center; }
        input { width: 100%; padding: 14px; margin: 10px 0; background: #0B0E1A; border: 1px solid #00D4FF; color: white; border-radius: 16px; font-size: 16px; }
        button { background: linear-gradient(95deg, #00D4FF, #0066FF); color: #0B0E1A; padding: 14px; border: none; border-radius: 40px; width: 100%; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; }
        .error { color: #FF6B6B; text-align: center; margin-top: 10px; }
      </style>
    </head>
    <body>
    <div class="card">
      <h2>🔐 CryptoGPU Admin</h2>
      <form method="POST" action="/admin/login">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Войти</button>
      </form>
    </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const bcrypt = require('bcrypt');
  const admin = await Admin.findOne({ username });
  
  if (admin && await bcrypt.compare(password, admin.passwordHash)) {
    req.session.adminId = admin._id;
    res.redirect('/admin');
  } else if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    // Fallback для первого запуска
    const fallbackAdmin = await Admin.findOne({ username });
    if (!fallbackAdmin) {
      const hash = await bcrypt.hash(password, 10);
      const newAdmin = await Admin.create({ username, passwordHash: hash });
      req.session.adminId = newAdmin._id;
    } else {
      req.session.adminId = fallbackAdmin._id;
    }
    res.redirect('/admin');
  } else {
    res.send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="background:#0B0E1A; color:white; display:flex; justify-content:center; align-items:center; height:100vh;">
      <div class="card" style="background:#1A1F35; padding:30px; border-radius:28px;">
        <h3>❌ Неверный логин или пароль</h3>
        <a href="/admin/login" style="color:#00D4FF;">Попробовать снова</a>
      </div></body></html>
    `);
  }
});

// Главная админ-панель (дашборд)
app.get('/admin', requireAuth, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  const pendingDeposits = await Deposit.find({ status: 'pending', type: 'deposit' }).sort('-createdAt');
  const pendingWithdraws = await Deposit.find({ status: 'pending', type: 'withdraw' }).sort('-createdAt');
  const completedDeposits = await Deposit.find({ status: 'completed', type: 'deposit' });
  const totalUsers = users.length;
  const totalTon = users.reduce((sum, u) => sum + u.ton, 0);
  const totalDeposited = completedDeposits.reduce((sum, d) => sum + d.amount, 0);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
      <title>Admin Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #0B0E1A; color: white; font-family: system-ui, -apple-system, sans-serif; padding: 16px; padding-bottom: 80px; }
        .header { background: linear-gradient(135deg, #1A2A5E, #0F1A3A); border-radius: 24px; padding: 20px; margin-bottom: 20px; }
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 20px; }
        .stat-card { background: rgba(26, 31, 53, 0.9); border-radius: 20px; padding: 16px; text-align: center; border: 1px solid rgba(0, 212, 255, 0.2); }
        .stat-value { font-size: 28px; font-weight: bold; color: #00D4FF; }
        .stat-label { font-size: 11px; color: #8EA3D4; margin-top: 4px; text-transform: uppercase; }
        .section { background: #1A1F35; border-radius: 24px; margin-bottom: 20px; overflow: hidden; }
        .section-header { padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: bold; font-size: 18px; background: rgba(0,0,0,0.2); }
        .nav-tabs { display: flex; gap: 4px; padding: 12px; background: #0B0E1A; flex-wrap: wrap; }
        .tab-btn { background: transparent; border: none; padding: 10px 16px; border-radius: 40px; color: #8EA3D4; font-size: 14px; cursor: pointer; transition: all 0.2s; }
        .tab-btn.active { background: #00D4FF; color: #0B0E1A; }
        .tab-content { display: none; padding: 16px; }
        .tab-content.active { display: block; }
        .user-card, .deposit-card { background: rgba(0,0,0,0.3); border-radius: 20px; padding: 12px; margin-bottom: 10px; border: 1px solid rgba(0, 212, 255, 0.15); }
        .user-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
        .user-name { font-weight: bold; font-size: 16px; }
        .user-id { font-size: 10px; color: #6B7CA8; font-family: monospace; }
        .user-stats { display: flex; gap: 12px; margin: 8px 0; font-size: 13px; flex-wrap: wrap; }
        .user-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        button { background: #1A2A5E; border: none; padding: 8px 12px; border-radius: 40px; color: white; font-size: 12px; cursor: pointer; transition: all 0.15s; }
        button:active { transform: scale(0.97); }
        .btn-success { background: #00A86B; }
        .btn-danger { background: #DC2626; }
        .btn-warning { background: #FF8C00; }
        .btn-info { background: #00D4FF; color: #0B0E1A; }
        .badge { background: rgba(0, 212, 255, 0.2); padding: 2px 8px; border-radius: 20px; font-size: 10px; }
        .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: #1A1F35; border-radius: 28px; padding: 24px; width: 90%; max-width: 350px; }
        .modal input { width: 100%; padding: 12px; margin: 10px 0; background: #0B0E1A; border: 1px solid #00D4FF; border-radius: 12px; color: white; }
        .search-box { width: 100%; padding: 12px; margin-bottom: 16px; background: #0B0E1A; border: 1px solid #00D4FF; border-radius: 40px; color: white; font-size: 14px; }
        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(8, 12, 24, 0.95); backdrop-filter: blur(20px); display: flex; justify-content: space-around; padding: 10px; border-top: 1px solid rgba(0, 212, 255, 0.2); z-index: 100; }
        .bottom-nav button { background: transparent; flex: 1; margin: 0 4px; }
        @media (max-width: 480px) {
          .stats-grid { grid-template-columns: 1fr; }
          .user-header { flex-direction: column; align-items: flex-start; }
        }
      </style>
    </head>
    <body>
    <div class="header">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h1>⚡ CryptoGPU</h1>
        <a href="/admin/logout" style="color:#FF8C00; text-decoration:none;">Выйти</a>
      </div>
      <div style="margin-top: 8px; font-size: 12px; color: #8EA3D4;">👋 Привет, ${req.admin?.username || 'Admin'}</div>
    </div>
    
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-value">${totalUsers}</div><div class="stat-label">👥 Всего игроков</div></div>
      <div class="stat-card"><div class="stat-value">${totalTon.toFixed(2)}</div><div class="stat-label">💰 TON в игре</div></div>
      <div class="stat-card"><div class="stat-value">${totalDeposited.toFixed(2)}</div><div class="stat-label">💎 Всего пополнений</div></div>
      <div class="stat-card"><div class="stat-value">${pendingDeposits.length + pendingWithdraws.length}</div><div class="stat-label">⏳ Ожидает проверки</div></div>
    </div>
    
    <div class="nav-tabs">
      <button class="tab-btn active" onclick="showTab('users')">👥 Пользователи</button>
      <button class="tab-btn" onclick="showTab('deposits')">💎 Пополнения</button>
      <button class="tab-btn" onclick="showTab('withdraws')">📤 Выводы</button>
    </div>
    
    <!-- Вкладка: Пользователи -->
    <div id="tab-users" class="tab-content active">
      <input type="text" class="search-box" id="searchUsers" placeholder="🔍 Поиск по ID или имени..." onkeyup="filterUsers()">
      <div id="usersList">
        ${users.map(user => `
          <div class="user-card" data-user-id="${user.userId}" data-user-name="${user.name.toLowerCase()}">
            <div class="user-header">
              <div>
                <span class="user-name">${user.name}</span>
                ${user.isBanned ? '<span class="badge" style="background:#DC2626;">🚫 Забанен</span>' : ''}
              </div>
              <span class="user-id">ID: ${user.userId}</span>
            </div>
            <div class="user-stats">
              <span>💰 ${user.ton.toFixed(2)} TON</span>
              <span>⚡ ${user.gpu} GPU</span>
              <span>👥 ${user.friends} друзей</span>
              <span>📅 ${new Date(user.createdAt).toLocaleDateString()}</span>
            </div>
            <div class="user-actions">
              <button class="btn-info" onclick="viewReferrals('${user.userId}', '${user.name}')">👥 Рефералы (${user.invitedFriends.length})</button>
              <button class="btn-warning" onclick="editBalance('${user.userId}', ${user.ton})">💰 Изменить баланс</button>
              ${user.isBanned ? 
                `<button class="btn-success" onclick="unbanUser('${user.userId}')">🔓 Разбанить</button>` : 
                `<button class="btn-danger" onclick="banUser('${user.userId}')">🔒 Забанить</button>`
              }
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    
    <!-- Вкладка: Пополнения -->
    <div id="tab-deposits" class="tab-content">
      ${pendingDeposits.length === 0 ? '<p style="text-align:center; color:#6B7CA8; padding:20px;">Нет ожидающих пополнений</p>' : ''}
      ${pendingDeposits.map(d => `
        <div class="deposit-card">
          <div><strong>👤 ${d.userName}</strong> <span style="font-size:11px; color:#6B7CA8;">${d.userId}</span></div>
          <div style="font-size:20px; font-weight:bold; margin:8px 0;">${d.amount} TON</div>
          <div style="font-size:11px; color:#8EA3D4;">Комментарий: ${d.comment}</div>
          <div style="display:flex; gap:8px; margin-top:12px;">
            <form method="POST" action="/admin/approve" style="flex:1;">
              <input type="hidden" name="id" value="${d._id}">
              <input type="hidden" name="type" value="deposit">
              <button type="submit" style="width:100%; background:#00A86B;">✅ Подтвердить</button>
            </form>
            <form method="POST" action="/admin/reject" style="flex:1;">
              <input type="hidden" name="id" value="${d._id}">
              <button type="submit" style="width:100%; background:#DC2626;">❌ Отклонить</button>
            </form>
          </div>
        </div>
      `).join('')}
    </div>
    
    <!-- Вкладка: Выводы -->
    <div id="tab-withdraws" class="tab-content">
      ${pendingWithdraws.length === 0 ? '<p style="text-align:center; color:#6B7CA8; padding:20px;">Нет заявок на вывод</p>' : ''}
      ${pendingWithdraws.map(w => `
        <div class="deposit-card">
          <div><strong>👤 ${w.userName}</strong> <span style="font-size:11px; color:#6B7CA8;">${w.userId}</span></div>
          <div style="font-size:20px; font-weight:bold; margin:8px 0;">${w.amount} TON</div>
          <div style="font-size:11px; word-break:break-all;">📤 Кошелёк: ${w.wallet}</div>
          <div style="display:flex; gap:8px; margin-top:12px;">
            <form method="POST" action="/admin/approve" style="flex:1;">
              <input type="hidden" name="id" value="${w._id}">
              <input type="hidden" name="type" value="withdraw">
              <button type="submit" style="width:100%; background:#FF8C00;">💰 Выполнить вывод</button>
            </form>
            <form method="POST" action="/admin/reject" style="flex:1;">
              <input type="hidden" name="id" value="${w._id}">
              <button type="submit" style="width:100%; background:#DC2626;">❌ Отклонить</button>
            </form>
          </div>
        </div>
      `).join('')}
    </div>
    
    <div class="bottom-nav">
      <button class="btn-info" onclick="showTab('users')">👥</button>
      <button class="btn-info" onclick="showTab('deposits')">💎</button>
      <button class="btn-info" onclick="showTab('withdraws')">📤</button>
    </div>
    
    <!-- Модальные окна -->
    <div id="referralModal" class="modal"><div class="modal-content"><div id="referralList"></div><button onclick="closeModal('referralModal')" style="margin-top:16px;">Закрыть</button></div></div>
    <div id="balanceModal" class="modal"><div class="modal-content"><h3>💰 Изменить баланс TON</h3><input type="number" id="newBalance" step="0.01"><input type="text" id="balanceReason" placeholder="Причина изменения"><button onclick="submitBalanceChange()">Сохранить</button><button onclick="closeModal('balanceModal')" style="margin-top:8px; background:#DC2626;">Отмена</button></div></div>
    <div id="banModal" class="modal"><div class="modal-content"><h3>🔒 Забанить пользователя</h3><input type="text" id="banReason" placeholder="Причина бана"><button onclick="submitBan()">Забанить</button><button onclick="closeModal('banModal')" style="margin-top:8px;">Отмена</button></div></div>
    
    <script>
      let currentUserId = null;
      
      function showTab(tab) {
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-' + tab).classList.add('active');
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        event.target.classList.add('active');
      }
      
      function filterUsers() {
        const search = document.getElementById('searchUsers').value.toLowerCase();
        const cards = document.querySelectorAll('.user-card');
        cards.forEach(card => {
          const name = card.getAttribute('data-user-name');
          const id = card.getAttribute('data-user-id');
          card.style.display = (name.includes(search) || id.includes(search)) ? 'block' : 'none';
        });
      }
      
      async function viewReferrals(userId, userName) {
        const res = await fetch('/admin/api/referrals/' + userId);
        const data = await res.json();
        const modal = document.getElementById('referralModal');
        const listDiv = document.getElementById('referralList');
        if (data.referrals && data.referrals.length > 0) {
          listDiv.innerHTML = '<h3>👥 Рефералы пользователя ' + userName + '</h3>' + 
            data.referrals.map(r => '<div class="user-card" style="margin-bottom:8px;"><strong>👤 ' + r.friendName + '</strong><br><span style="font-size:11px;">' + r.date + '</span></div>').join('');
        } else {
          listDiv.innerHTML = '<p>Нет приглашённых друзей</p>';
        }
        modal.style.display = 'flex';
      }
      
      function editBalance(userId, currentBalance) {
        currentUserId = userId;
        document.getElementById('newBalance').value = currentBalance;
        document.getElementById('balanceModal').style.display = 'flex';
      }
      
      async function submitBalanceChange() {
        const newBalance = parseFloat(document.getElementById('newBalance').value);
        const reason = document.getElementById('balanceReason').value;
        if (isNaN(newBalance)) return;
        const res = await fetch('/admin/api/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUserId, newBalance: newBalance, reason: reason })
        });
        const result = await res.json();
        if (result.success) {
          alert('✅ Баланс изменён');
          location.reload();
        } else {
          alert('❌ Ошибка: ' + result.error);
        }
        closeModal('balanceModal');
      }
      
      function banUser(userId) {
        currentUserId = userId;
        document.getElementById('banModal').style.display = 'flex';
      }
      
      async function submitBan() {
        const reason = document.getElementById('banReason').value;
        const res = await fetch('/admin/api/ban', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: currentUserId, reason: reason })
        });
        const result = await res.json();
        if (result.success) {
          alert('✅ Пользователь забанен');
          location.reload();
        } else {
          alert('❌ Ошибка');
        }
        closeModal('banModal');
      }
      
      async function unbanUser(userId) {
        if (confirm('Разблокировать пользователя?')) {
          const res = await fetch('/admin/api/unban', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId })
          });
          const result = await res.json();
          if (result.success) {
            alert('✅ Пользователь разбанен');
            location.reload();
          }
        }
      }
      
      function closeModal(id) {
        document.getElementById(id).style.display = 'none';
      }
      
      window.onclick = function(event) {
        if (event.target.classList.contains('modal')) {
          event.target.style.display = 'none';
        }
      }
    </script>
    </body>
    </html>
  `);
});

// API для админ-панели
app.get('/admin/api/referrals/:userId', requireAuth, async (req, res) => {
  const user = await User.findOne({ userId: req.params.userId });
  res.json({ referrals: user?.invitedFriends || [] });
});

app.post('/admin/api/balance', requireAuth, async (req, res) => {
  const { userId, newBalance, reason } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false, error: 'User not found' });
  user.ton = newBalance;
  await user.save();
  console.log(`💰 Admin ${req.admin.username} changed balance of ${userId}: ${newBalance} TON (${reason})`);
  res.json({ success: true });
});

app.post('/admin/api/ban', requireAuth, async (req, res) => {
  const { userId, reason } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.isBanned = true;
  user.banReason = reason;
  await user.save();
  console.log(`🔒 Admin ${req.admin.username} banned ${userId}: ${reason}`);
  res.json({ success: true });
});

app.post('/admin/api/unban', requireAuth, async (req, res) => {
  const { userId } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.isBanned = false;
  user.banReason = null;
  await user.save();
  console.log(`🔓 Admin ${req.admin.username} unbanned ${userId}`);
  res.json({ success: true });
});

// Обработка заявок
app.post('/admin/approve', requireAuth, async (req, res) => {
  const { id, type } = req.body;
  const transaction = await Deposit.findById(id);
  if (!transaction || transaction.status !== 'pending') {
    return res.redirect('/admin?error=Invalid transaction');
  }
  
  const user = await User.findOne({ userId: transaction.userId });
  if (!user) return res.redirect('/admin?error=User not found');
  
  if (type === 'deposit') {
    user.ton += transaction.amount;
    user.totalDeposited += transaction.amount;
    transaction.status = 'completed';
  } else if (type === 'withdraw') {
    if (user.ton >= transaction.amount) {
      user.ton -= transaction.amount;
      user.totalWithdrawn += transaction.amount;
      transaction.status = 'completed';
    } else {
      transaction.status = 'cancelled';
      return res.redirect('/admin?error=Insufficient balance');
    }
  }
  
  transaction.processedAt = new Date();
  transaction.processedBy = req.admin.username;
  await user.save();
  await transaction.save();
  
  res.redirect('/admin');
});

app.post('/admin/reject', requireAuth, async (req, res) => {
  const { id } = req.body;
  await Deposit.findByIdAndUpdate(id, { status: 'cancelled', processedBy: req.admin.username });
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Корневой маршрут
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'CryptoGPU Backend is running' });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URL)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    await ensureAdminExists();
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔐 Admin panel: https://your-domain.up.railway.app/admin`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  });
