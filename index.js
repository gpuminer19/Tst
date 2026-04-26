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
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
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
  role: { type: String, default: 'user' },
  invitedFriends: [{ 
    friendId: String, 
    friendName: String, 
    date: String,
    earnedGpu: { type: Number, default: 0 }
  }],
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
  type: { type: String, default: 'deposit' },
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

async function requireAuth(req, res, next) {
  if (!req.session.adminId) return res.redirect('/admin/login');
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
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, ton_earned, state, tonWallet } = req.body;
  
  try {
    const bannedUser = await User.findOne({ userId: user_id, isBanned: true });
    if (bannedUser) {
      return res.status(403).json({ success: false, error: 'BANNED', message: `Ваш аккаунт заблокирован. Причина: ${bannedUser.banReason || 'Нарушение правил'}` });
    }
    
    // РЕГИСТРАЦИЯ
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
              date: new Date().toLocaleDateString(),
              earnedGpu: 0
            });
            referrer.friends = referrer.invitedFriends.length;
            await referrer.save();
          }
        }
        await user.save();
      }
      
      const transactions = await Deposit.find({ userId: user_id }).sort({ createdAt: -1 }).limit(50);
      
      return res.json({
        success: true,
        data: {
          ton: user.ton,
          gpu: user.gpu,
          friends: user.friends,
          isBanned: user.isBanned,
          state: user.gameState || {},
          invitedFriends: user.invitedFriends || [],
          transactions: transactions.map(t => ({ id: t._id, amount: t.amount, type: t.type, status: t.status, createdAt: t.createdAt }))
        }
      });
    }
    
    // СОХРАНЕНИЕ
    if (action === 'save') {
      await User.findOneAndUpdate({ userId: user_id }, { ton, gpu, friends, gameState: state, lastSeen: new Date() }, { upsert: true });
      return res.json({ success: true });
    }
    
    // РЕФЕРАЛЫ (возвращаем с earnedGpu)
    if (action === 'getReferrals') {
      const user = await User.findOne({ userId: user_id });
      const referrals = (user?.invitedFriends || []).map(f => ({ 
        friend_name: f.friendName, 
        date: f.date,
        earnedGpu: f.earnedGpu || 0
      }));
      return res.json({ success: true, referrals });
    }
    
    // ПОПОЛНЕНИЕ
    if (action === 'createDeposit') {
      const pendingCount = await Deposit.countDocuments({ userId: user_id, status: 'pending', type: 'deposit' });
      if (pendingCount >= 2) {
        return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED', pendingCount, message: 'У вас уже есть 2 ожидающие заявки на пополнение.' });
      }
      const comment = `DEPOSIT_${user_id}_${Date.now()}`;
      const deposit = new Deposit({ userId: user_id, userName: name, amount, wallet: process.env.TON_WALLET || "EQD...", comment, type: 'deposit' });
      await deposit.save();
      return res.json({ success: true, deposit: { amount, wallet: process.env.TON_WALLET, comment }, pendingCount: pendingCount + 1 });
    }
    
    // ВЫВОД
    if (action === 'createWithdraw') {
      if (!amount || amount <= 0 || !tonWallet) return res.status(400).json({ success: false, error: 'Invalid withdraw data' });
      
      const pendingCount = await Deposit.countDocuments({ userId: user_id, status: 'pending', type: 'withdraw' });
      if (pendingCount >= 2) {
        return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED', pendingCount, message: 'У вас уже есть 2 ожидающие заявки на вывод.' });
      }
      
      const user = await User.findOne({ userId: user_id });
      if (!user || user.ton < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });
      
      user.ton -= amount;
      await user.save();
      
      const comment = `WITHDRAW_${user_id}_${Date.now()}`;
      const withdrawRequest = new Deposit({ userId: user_id, userName: name, amount, wallet: tonWallet, comment, type: 'withdraw', status: 'pending' });
      await withdrawRequest.save();
      
      return res.json({ success: true, message: 'Withdraw request created', pendingCount: pendingCount + 1 });
    }
    
    // ========== ОБНОВЛЕНИЕ СТАТИСТИКИ РЕФЕРАЛА ==========
    if (action === 'updateFriendEarned') {
      const { earnedGpu } = req.body;
      
      // Находим пользователя, который пригласил этого человека
      const referrer = await User.findOne({ "invitedFriends.friendId": user_id });
      if (referrer) {
        const friend = referrer.invitedFriends.find(f => f.friendId === user_id);
        if (friend) {
          friend.earnedGpu = (friend.earnedGpu || 0) + earnedGpu;
          await referrer.save();
          console.log(`📊 Реферер ${referrer.userId}: друг ${user_id} заработал +${earnedGpu} GPU (всего ${friend.earnedGpu})`);
        }
      }
      return res.json({ success: true });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.get('/admin/login', (req, res) => {
  res.send(`<!DOCTYPE html>
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Login</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0B0E1A;color:#fff;font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}.card{background:#1A1F35;padding:30px;border-radius:28px;width:100%;max-width:350px}h2{text-align:center;margin-bottom:24px}input{width:100%;padding:14px;margin:10px 0;background:#0B0E1A;border:1px solid #00D4FF;color:#fff;border-radius:16px;font-size:16px}button{background:linear-gradient(95deg,#00D4FF,#0066FF);color:#0B0E1A;padding:14px;border:none;border-radius:40px;width:100%;font-size:16px;font-weight:bold;cursor:pointer}</style>
  </head><body><div class="card"><h2>🔐 CryptoGPU Admin</h2><form method="POST" action="/admin/login"><input type="text" name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required><button type="submit">Войти</button></form></div></body></html>`);
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const bcrypt = require('bcrypt');
  const admin = await Admin.findOne({ username });
  if (admin && await bcrypt.compare(password, admin.passwordHash)) {
    req.session.adminId = admin._id;
    res.redirect('/admin');
  } else if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
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
    res.send('<h3>❌ Неверный логин или пароль</h3><a href="/admin/login">Попробовать снова</a>');
  }
});

// ГЛАВНАЯ АДМИН-ПАНЕЛЬ
app.get('/admin', requireAuth, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  const pendingDeposits = await Deposit.find({ status: 'pending', type: 'deposit' }).sort('-createdAt');
  const pendingWithdraws = await Deposit.find({ status: 'pending', type: 'withdraw' }).sort('-createdAt');
  const totalUsers = users.length;
  const totalTon = users.reduce((sum, u) => sum + u.ton, 0);
  
  res.send(`<!DOCTYPE html>
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Dashboard</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0B0E1A;color:#fff;font-family:system-ui;padding:16px;padding-bottom:80px}.header{background:linear-gradient(135deg,#1A2A5E,#0F1A3A);border-radius:24px;padding:20px;margin-bottom:20px}.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px}.stat-card{background:rgba(26,31,53,0.9);border-radius:20px;padding:16px;text-align:center}.stat-value{font-size:28px;font-weight:bold;color:#00D4FF}.nav-tabs{display:flex;gap:4px;padding:12px;background:#0B0E1A;flex-wrap:wrap}.tab-btn{background:transparent;border:none;padding:10px 16px;border-radius:40px;color:#8EA3D4;cursor:pointer}.tab-btn.active{background:#00D4FF;color:#0B0E1A}.tab-content{display:none;padding:16px}.tab-content.active{display:block}.user-card,.deposit-card{background:rgba(0,0,0,0.3);border-radius:20px;padding:12px;margin-bottom:10px}.user-header{display:flex;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}button{background:#1A2A5E;border:none;padding:8px 12px;border-radius:40px;color:#fff;cursor:pointer;margin:2px}.btn-success{background:#00A86B}.btn-danger{background:#DC2626}.btn-warning{background:#FF8C00}.search-box{width:100%;padding:12px;margin-bottom:16px;background:#0B0E1A;border:1px solid #00D4FF;border-radius:40px;color:#fff}.bottom-nav{position:fixed;bottom:0;left:0;right:0;background:rgba(8,12,24,0.95);display:flex;justify-content:space-around;padding:10px}</style>
  </head><body>
  <div class="header"><div style="display:flex;justify-content:space-between;"><h1>⚡ CryptoGPU</h1><a href="/admin/logout" style="color:#FF8C00;">Выйти</a></div></div>
  <div class="stats-grid"><div class="stat-card"><div class="stat-value">${totalUsers}</div><div>👥 Игроков</div></div><div class="stat-card"><div class="stat-value">${totalTon.toFixed(2)}</div><div>💰 TON</div></div><div class="stat-card"><div class="stat-value">${pendingDeposits.length}</div><div>💎 Пополнений</div></div><div class="stat-card"><div class="stat-value">${pendingWithdraws.length}</div><div>📤 Выводов</div></div></div>
  <div class="nav-tabs"><button class="tab-btn active" onclick="showTab('users')">👥 Пользователи</button><button class="tab-btn" onclick="showTab('deposits')">💎 Пополнения</button><button class="tab-btn" onclick="showTab('withdraws')">📤 Выводы</button></div>
  <div id="tab-users" class="tab-content active"><input type="text" class="search-box" id="searchUsers" placeholder="🔍 Поиск..." onkeyup="filterUsers()"><div id="usersList">${users.map(u => `<div class="user-card" data-name="${u.name.toLowerCase()}" data-id="${u.userId}"><div class="user-header"><span><strong>${u.name}</strong> ${u.isBanned ? '🚫' : ''}</span><span style="font-size:11px;">${u.userId}</span></div><div>💰 ${u.ton.toFixed(2)} TON | ⚡ ${u.gpu} GPU | 👥 ${u.friends}</div><div style="margin-top:10px;"><button class="btn-warning" onclick="editBalance('${u.userId}', ${u.ton})">💰 Изменить баланс</button>${u.isBanned ? `<button class="btn-success" onclick="unbanUser('${u.userId}')">🔓 Разбанить</button>` : `<button class="btn-danger" onclick="banUser('${u.userId}')">🔒 Забанить</button>`}</div></div>`).join('')}</div></div>
  <div id="tab-deposits" class="tab-content">${pendingDeposits.map(d => `<div class="deposit-card"><div><strong>👤 ${d.userName}</strong> (${d.userId})</div><div style="font-size:20px;">${d.amount} TON</div><div style="font-size:11px;">${d.comment}</div><div style="display:flex;gap:8px;margin-top:10px;"><form method="POST" action="/admin/approve" style="flex:1;"><input type="hidden" name="id" value="${d._id}"><input type="hidden" name="type" value="deposit"><button type="submit" style="width:100%;background:#00A86B;">✅ Подтвердить</button></form><form method="POST" action="/admin/reject" style="flex:1;"><input type="hidden" name="id" value="${d._id}"><button type="submit" style="width:100%;background:#DC2626;">❌ Отклонить</button></form></div></div>`).join('') || '<p>Нет заявок</p>'}</div>
  <div id="tab-withdraws" class="tab-content">${pendingWithdraws.map(w => `<div class="deposit-card"><div><strong>👤 ${w.userName}</strong> (${w.userId})</div><div style="font-size:20px;">${w.amount} TON</div><div style="font-size:11px;">📤 ${w.wallet}</div><div style="display:flex;gap:8px;margin-top:10px;"><form method="POST" action="/admin/approve" style="flex:1;"><input type="hidden" name="id" value="${w._id}"><input type="hidden" name="type" value="withdraw"><button type="submit" style="width:100%;background:#FF8C00;">💰 Подтвердить вывод</button></form><form method="POST" action="/admin/reject" style="flex:1;"><input type="hidden" name="id" value="${w._id}"><button type="submit" style="width:100%;background:#DC2626;">❌ Отклонить</button></form></div></div>`).join('') || '<p>Нет заявок</p>'}</div>
  <div class="bottom-nav"><button onclick="showTab('users')">👥</button><button onclick="showTab('deposits')">💎</button><button onclick="showTab('withdraws')">📤</button></div>
  <script>
    function showTab(tab){document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));document.getElementById('tab-'+tab).classList.add('active');document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active');}
    function filterUsers(){const s=document.getElementById('searchUsers').value.toLowerCase();document.querySelectorAll('.user-card').forEach(c=>{c.style.display=(c.getAttribute('data-name').includes(s)||c.getAttribute('data-id').includes(s))?'block':'none'});}
    let currentUserId=null;
    function editBalance(id,bal){currentUserId=id;let nb=prompt('Новый баланс TON:',bal);if(nb&&!isNaN(parseFloat(nb))){fetch('/admin/api/balance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:currentUserId,newBalance:parseFloat(nb),reason:'Admin edit'})}).then(()=>location.reload());}}
    function banUser(id){if(confirm('Забанить?')){let r=prompt('Причина бана:');fetch('/admin/api/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id,reason:r})}).then(()=>location.reload());}}
    function unbanUser(id){if(confirm('Разбанить?')){fetch('/admin/api/unban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id})}).then(()=>location.reload());}}
  </script>
  </body></html>`);
});

app.post('/admin/api/balance', requireAuth, async (req, res) => {
  await User.findOneAndUpdate({ userId: req.body.userId }, { ton: req.body.newBalance });
  res.json({ success: true });
});
app.post('/admin/api/ban', requireAuth, async (req, res) => {
  await User.findOneAndUpdate({ userId: req.body.userId }, { isBanned: true, banReason: req.body.reason });
  res.json({ success: true });
});
app.post('/admin/api/unban', requireAuth, async (req, res) => {
  await User.findOneAndUpdate({ userId: req.body.userId }, { isBanned: false, banReason: null });
  res.json({ success: true });
});

app.post('/admin/approve', requireAuth, async (req, res) => {
  const transaction = await Deposit.findById(req.body.id);
  if (!transaction || transaction.status !== 'pending') return res.redirect('/admin');
  const user = await User.findOne({ userId: transaction.userId });
  if (req.body.type === 'deposit') {
    user.ton += transaction.amount;
    user.totalDeposited += transaction.amount;
    transaction.status = 'completed';
  } else if (req.body.type === 'withdraw') {
    user.totalWithdrawn += transaction.amount;
    transaction.status = 'completed';
  }
  transaction.processedAt = new Date();
  transaction.processedBy = req.admin.username;
  await user.save();
  await transaction.save();
  res.redirect('/admin');
});

app.post('/admin/reject', requireAuth, async (req, res) => {
  const transaction = await Deposit.findById(req.body.id);
  if (transaction && transaction.type === 'withdraw' && transaction.status === 'pending') {
    const user = await User.findOne({ userId: transaction.userId });
    if (user) { user.ton += transaction.amount; await user.save(); }
  }
  await Deposit.findByIdAndUpdate(req.body.id, { status: 'cancelled', processedBy: req.admin.username });
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });
app.get('/', (req, res) => { res.json({ status: 'OK', message: 'CryptoGPU Backend is running' }); });

// ========== API ДЛЯ БОТА (засчёт реферала) ==========
app.post('/api/bot/registerRef', async (req, res) => {
  const { userId, referrerId } = req.body;
  
  try {
    const existingUser = await User.findOne({ userId: userId });
    if (existingUser) {
      return res.json({ success: false, error: 'User already exists' });
    }
    
    const referrer = await User.findOne({ userId: referrerId });
    if (!referrer) {
      return res.json({ success: false, error: 'Referrer not found' });
    }
    
    const alreadyInvited = referrer.invitedFriends.some(f => f.friendId === userId);
    if (alreadyInvited) {
      return res.json({ success: false, error: 'Already invited' });
    }
    
    referrer.invitedFriends.push({
      friendId: userId,
      friendName: `User_${userId.slice(-5)}`,
      date: new Date().toLocaleDateString(),
      earnedGpu: 0
    });
    referrer.friends = referrer.invitedFriends.length;
    await referrer.save();
    
    console.log(`✅ Реферал засчитан! ${referrerId} → ${userId}`);
    res.json({ success: true, message: 'Referral counted' });
    
  } catch (error) {
    console.error('Error in /api/bot/registerRef:', error);
    res.json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URL).then(async () => {
  console.log('✅ Connected to MongoDB');
  await ensureAdminExists();
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}\n🔐 Admin: https://your-domain.up.railway.app/admin/login`));
}).catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });