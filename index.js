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
  ton: { type: Number, default: 0 },
  gpu: { type: Number, default: 15 },
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
  gameState: { type: Object, default: { minerQuantities: {} } },
  createdAt: { type: Date, default: Date.now },
  lastSeen: Date,
  lastMiningUpdate: { type: Date, default: Date.now },
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

const taskSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  description: String,
  rewardTon: Number,
  rewardGpu: Number,
  type: { type: String, default: 'manual' },
  taskUrl: String,
  isDaily: { type: Boolean, default: true },
  cooldown: { type: Number, default: 86400000 },
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 }
});

const userTaskSchema = new mongoose.Schema({
  userId: String,
  taskId: String,
  completedAt: Date,
  expiresAt: Date,
  claimed: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Admin = mongoose.model('Admin', adminSchema);
const Task = mongoose.model('Task', taskSchema);
const UserTask = mongoose.model('UserTask', userTaskSchema);

// ========== РЕЙТЫ МАЙНЕРОВ (доход в час) ==========
const MINERS_RATES = {
  basic: { tonPerHour: 0.01 / 24, gpuPerHour: 15 / 24, price: 1, priceCurrency: "gpu", maxQuantity: 30 },
  normal: { tonPerHour: 0.02 / 24, gpuPerHour: 15 / 24, price: 2, priceCurrency: "ton", maxQuantity: null },
  pro: { tonPerHour: 0.1 / 24, gpuPerHour: 75 / 24, price: 10, priceCurrency: "ton", maxQuantity: null },
  ultra: { tonPerHour: 0.6 / 24, gpuPerHour: 380 / 24, price: 50, priceCurrency: "ton", maxQuantity: null },
  legendary: { tonPerHour: 1.4 / 24, gpuPerHour: 780 / 24, price: 100, priceCurrency: "ton", maxQuantity: null },
  minex: { tonPerHour: 7 / 24, gpuPerHour: 1800 / 24, price: 500, priceCurrency: "ton", maxQuantity: null },
  friend: { tonPerHour: 0.1 / 24, gpuPerHour: 15 / 24, price: 0, priceCurrency: "ref", isReferral: true, requiredActive: 10, requiredEarned: 30 },
  bro: { tonPerHour: 0.5 / 24, gpuPerHour: 75 / 24, price: 0, priceCurrency: "ref", isReferral: true, requiredActive: 50, requiredEarned: 30 },
  nexus: { tonPerHour: 1.5 / 24, gpuPerHour: 200 / 24, price: 0, priceCurrency: "ref", isReferral: true, requiredActive: 150, requiredEarned: 30 }
};

// ========== ФУНКЦИЯ ОФЛАЙН-МАЙНИНГА ==========
async function updateMiningRewards(userId) {
  const user = await User.findOne({ userId });
  if (!user) return { ton: 0, gpu: 0 };
  
  const now = Date.now();
  const lastUpdate = user.lastMiningUpdate || user.createdAt || now;
  const deltaHours = (now - new Date(lastUpdate).getTime()) / (1000 * 3600);
  
  if (deltaHours <= 0 || deltaHours > 720) { // максимум 30 дней
    user.lastMiningUpdate = new Date(now);
    await user.save();
    return { ton: 0, gpu: 0 };
  }
  
  const minerQuantities = user.gameState?.minerQuantities || {};
  
  let totalTon = 0;
  let totalGpu = 0;
  
  for (const [minerId, quantity] of Object.entries(minerQuantities)) {
    const rate = MINERS_RATES[minerId];
    if (rate && quantity > 0 && !rate.isReferral) {
      totalTon += rate.tonPerHour * quantity * deltaHours;
      totalGpu += rate.gpuPerHour * quantity * deltaHours;
    }
  }
  
  if (totalTon > 0 || totalGpu > 0) {
    user.ton += totalTon;
    user.gpu += totalGpu;
    user.lastMiningUpdate = new Date(now);
    await user.save();
    console.log(`💰 Offline mining for ${userId}: +${totalTon.toFixed(6)} TON, +${totalGpu.toFixed(4)} GPU (${deltaHours.toFixed(2)} hours)`);
  }
  
  return { ton: totalTon, gpu: totalGpu };
}

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

async function addEarnedGpuToReferrer(userId, earnedGpu) {
  if (!earnedGpu || earnedGpu <= 0) return false;
  try {
    const referrer = await User.findOne({ "invitedFriends.friendId": userId });
    if (referrer && referrer.invitedFriends && Array.isArray(referrer.invitedFriends)) {
      const friendIndex = referrer.invitedFriends.findIndex(f => f.friendId === userId);
      if (friendIndex !== -1) {
        const currentEarned = referrer.invitedFriends[friendIndex].earnedGpu || 0;
        referrer.invitedFriends[friendIndex].earnedGpu = currentEarned + earnedGpu;
        await referrer.save();
        console.log(`✅ Начислено ${earnedGpu} GPU рефереру ${referrer.userId}`);
        return true;
      }
    }
  } catch (error) {
    console.error("Ошибка в addEarnedGpuToReferrer:", error);
  }
  return false;
}

// ========== API для игры ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, state, tonWallet, taskId, deposit_id } = req.body;
  
  try {
    const bannedUser = await User.findOne({ userId: user_id, isBanned: true });
    if (bannedUser) {
      return res.status(403).json({ success: false, error: 'BANNED', message: `Ваш аккаунт заблокирован. Причина: ${bannedUser.banReason || 'Нарушение правил'}` });
    }
    
    // Сначала обновляем офлайн-майнинг
    await updateMiningRewards(user_id);
    
    // РЕГИСТРАЦИЯ
    if (action === 'register') {
      let user = await User.findOne({ userId: user_id });
      if (!user) {
        const initialGameState = { minerQuantities: { basic: 1 } };
        user = new User({ 
          userId: user_id, 
          name: name || 'Игрок',
          ton: 0,
          gpu: 15,
          friends: 0,
          invitedFriends: [],
          gameState: initialGameState,
          lastMiningUpdate: new Date()
        });
        
        if (referrer_id && referrer_id !== user_id) {
          const referrer = await User.findOne({ userId: referrer_id });
          if (referrer && !referrer.isBanned) {
            referrer.invitedFriends.push({ 
              friendId: user_id, 
              friendName: name || user_id.slice(-5),
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
          gameState: user.gameState || { minerQuantities: { basic: 1 } },
          invitedFriends: user.invitedFriends || [],
          transactions: transactions.map(t => ({ id: t._id, amount: t.amount, type: t.type, status: t.status, createdAt: t.createdAt }))
        }
      });
    }
    
    // СОХРАНЕНИЕ
    if (action === 'save') {
      try {
        const oldUser = await User.findOne({ userId: user_id });
        const oldGpu = oldUser?.gpu || 0;
        
        await User.findOneAndUpdate(
          { userId: user_id }, 
          { 
            ton, 
            gpu, 
            friends, 
            gameState: state || { minerQuantities: { basic: 1 } },
            lastSeen: new Date() 
          }, 
          { upsert: true }
        );
        
        const earnedGpu = gpu - oldGpu;
        if (earnedGpu > 0) {
          await addEarnedGpuToReferrer(user_id, earnedGpu);
        }
        
        return res.json({ success: true });
      } catch (error) {
        console.error("Ошибка сохранения:", error);
        return res.status(500).json({ success: false, error: "Server error" });
      }
    }
    
    // РЕФЕРАЛЫ
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
      const deposit = new Deposit({ userId: user_id, userName: name, amount, wallet: process.env.TON_WALLET || "EQD4ZKIqF7XxPoUcPE5P7gL8N8UqZfjqJXzLvzVcUa2h", comment, type: 'deposit' });
      await deposit.save();
      return res.json({ success: true, deposit: { id: deposit._id, amount, wallet: process.env.TON_WALLET || "EQD4ZKIqF7XxPoUcPE5P7gL8N8UqZfjqJXzLvzVcUa2h", comment }, pendingCount: pendingCount + 1 });
    }
    
    // ПОДТВЕРЖДЕНИЕ ОПЛАТЫ
    if (action === 'confirmDeposit') {
      const deposit = await Deposit.findById(deposit_id);
      if (!deposit) {
        return res.status(404).json({ success: false, error: 'Deposit not found' });
      }
      if (deposit.status !== 'pending') {
        return res.status(400).json({ success: false, error: 'Deposit already processed' });
      }
      const user = await User.findOne({ userId: deposit.userId });
      if (user) {
        user.ton += deposit.amount;
        user.totalDeposited += deposit.amount;
        await user.save();
      }
      deposit.status = 'completed';
      deposit.processedAt = new Date();
      deposit.processedBy = 'user';
      await deposit.save();
      return res.json({ success: true, message: 'Deposit confirmed and credited' });
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
    
    // ЗАДАНИЯ
    if (action === 'tasks/list') {
      const allTasks = await Task.find({ isActive: true }).sort({ order: 1 });
      const userCompleted = await UserTask.find({ userId: user_id, claimed: true });
      const userPending = await UserTask.find({ userId: user_id, claimed: false });
      
      const tasks = allTasks.map(task => {
        const completed = userCompleted.some(ut => ut.taskId === task.id);
        const pending = userPending.some(ut => ut.taskId === task.id);
        return {
          id: task.id,
          title: task.title,
          description: task.description,
          rewardTon: task.rewardTon,
          rewardGpu: task.rewardGpu,
          type: task.type,
          taskUrl: task.taskUrl,
          isDaily: task.isDaily,
          completed: completed,
          pending: pending
        };
      });
      
      return res.json({ success: true, tasks });
    }
    
    if (action === 'tasks/complete') {
      const task = await Task.findOne({ id: taskId });
      if (!task) return res.json({ success: false, error: 'Task not found' });
      
      const existing = await UserTask.findOne({ userId: user_id, taskId: taskId, claimed: true });
      if (existing) return res.json({ success: false, error: 'Already completed' });
      
      const pending = await UserTask.findOne({ userId: user_id, taskId: taskId, claimed: false });
      if (pending) return res.json({ success: false, error: 'Already pending approval' });
      
      const userTask = new UserTask({
        userId: user_id,
        taskId: taskId,
        completedAt: new Date(),
        expiresAt: task.isDaily ? new Date(Date.now() + task.cooldown) : null,
        claimed: false
      });
      await userTask.save();
      
      return res.json({ success: true, message: 'Task completed, waiting for admin approval' });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== АДМИН-ПАНЕЛЬ (сокращённо, основные эндпоинты) ==========
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

app.get('/admin', requireAuth, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  const pendingDeposits = await Deposit.find({ status: 'pending', type: 'deposit' }).sort('-createdAt');
  const pendingWithdraws = await Deposit.find({ status: 'pending', type: 'withdraw' }).sort('-createdAt');
  const totalUsers = users.length;
  const totalTon = users.reduce((sum, u) => sum + u.ton, 0);
  const pendingTasks = await UserTask.find({ claimed: false });
  
  res.send(`<!DOCTYPE html>
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Dashboard</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0B0E1A;color:#fff;font-family:system-ui;padding:16px;padding-bottom:80px}.header{background:linear-gradient(135deg,#1A2A5E,#0F1A3A);border-radius:24px;padding:20px;margin-bottom:20px}.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px}.stat-card{background:rgba(26,31,53,0.9);border-radius:20px;padding:16px;text-align:center}.stat-value{font-size:28px;font-weight:bold;color:#00D4FF}.nav-tabs{display:flex;gap:4px;padding:12px;background:#0B0E1A;flex-wrap:wrap}.tab-btn{background:transparent;border:none;padding:10px 16px;border-radius:40px;color:#8EA3D4;cursor:pointer}.tab-btn.active{background:#00D4FF;color:#0B0E1A}.tab-content{display:none;padding:16px}.tab-content.active{display:block}.user-card,.deposit-card{background:rgba(0,0,0,0.3);border-radius:20px;padding:12px;margin-bottom:10px}.user-header{display:flex;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}button{background:#1A2A5E;border:none;padding:8px 12px;border-radius:40px;color:#fff;cursor:pointer;margin:2px}.btn-success{background:#00A86B}.btn-danger{background:#DC2626}.btn-warning{background:#FF8C00}.btn-info{background:#00D4FF;color:#0B0E1A}.search-box{width:100%;padding:12px;margin-bottom:16px;background:#0B0E1A;border:1px solid #00D4FF;border-radius:40px;color:#fff}.bottom-nav{position:fixed;bottom:0;left:0;right:0;background:rgba(8,12,24,0.95);display:flex;justify-content:space-around;padding:10px}</style>
  </head><body>
  <div id="modalOverlay" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.8); justify-content:center; align-items:center; z-index:1000;">
    <div id="modalContent" style="background:#1A1F35; border-radius:28px; padding:24px; max-width:500px; width:90%; max-height:80vh; overflow-y:auto;"></div>
  </div>
  
  <div class="header"><div style="display:flex;justify-content:space-between;"><h1>⚡ CryptoGPU</h1><a href="/admin/logout" style="color:#FF8C00;">Выйти</a></div></div>
  <div class="stats-grid"><div class="stat-card"><div class="stat-value">${totalUsers}</div><div>👥 Игроков</div></div><div class="stat-card"><div class="stat-value">${totalTon.toFixed(2)}</div><div>💰 TON</div></div><div class="stat-card"><div class="stat-value">${pendingDeposits.length}</div><div>💎 Пополнений</div></div><div class="stat-card"><div class="stat-valu
