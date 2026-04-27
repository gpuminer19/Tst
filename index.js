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
  gameState: { type: Object, default: { minerQuantities: { basic: 1 }, accumulatedTon: 0, accumulatedGpu: 0 } },
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

// ========== РЕЙТЫ МАЙНЕРОВ ==========
const MINERS_RATES = {
  basic: { tonPerHour: 0.01 / 24, gpuPerHour: 15 / 24 },
  normal: { tonPerHour: 0.02 / 24, gpuPerHour: 15 / 24 },
  pro: { tonPerHour: 0.1 / 24, gpuPerHour: 75 / 24 },
  ultra: { tonPerHour: 0.6 / 24, gpuPerHour: 380 / 24 },
  legendary: { tonPerHour: 1.4 / 24, gpuPerHour: 780 / 24 },
  minex: { tonPerHour: 7 / 24, gpuPerHour: 1800 / 24 }
};

// ========== ФУНКЦИЯ ОФЛАЙН-НАКОПЛЕНИЙ ==========
async function calculateAndSaveOfflineAccumulated(userId) {
  try {
    const user = await User.findOne({ userId });
    if (!user) return { accumulatedTon: 0, accumulatedGpu: 0 };
    
    const now = Date.now();
    const lastUpdate = user.lastMiningUpdate || user.createdAt || now;
    const deltaHours = (now - new Date(lastUpdate).getTime()) / (1000 * 3600);
    
    if (deltaHours <= 0.001 || deltaHours > 720) {
      user.lastMiningUpdate = new Date(now);
      await user.save();
      return { accumulatedTon: 0, accumulatedGpu: 0 };
    }
    
    const minerQuantities = user.gameState?.minerQuantities || { basic: 1 };
    
    let totalTon = 0;
    let totalGpu = 0;
    
    for (const [minerId, quantity] of Object.entries(minerQuantities)) {
      const rate = MINERS_RATES[minerId];
      if (rate && quantity > 0) {
        totalTon += rate.tonPerHour * quantity * deltaHours;
        totalGpu += rate.gpuPerHour * quantity * deltaHours;
      }
    }
    
    if (totalTon > 0 || totalGpu > 0) {
      user.gameState = user.gameState || {};
      user.gameState.accumulatedTon = (user.gameState.accumulatedTon || 0) + totalTon;
      user.gameState.accumulatedGpu = (user.gameState.accumulatedGpu || 0) + totalGpu;
      user.lastMiningUpdate = new Date(now);
      await user.save();
    } else {
      user.lastMiningUpdate = new Date(now);
      await user.save();
    }
    
    return { accumulatedTon: totalTon, accumulatedGpu: totalGpu };
  } catch (error) {
    console.error(`Ошибка:`, error);
    return { accumulatedTon: 0, accumulatedGpu: 0 };
  }
}

async function ensureAdminExists() {
  const existingAdmin = await Admin.findOne({ username: process.env.ADMIN_USER });
  if (!existingAdmin && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
    await Admin.create({ username: process.env.ADMIN_USER, passwordHash: hash });
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
      }
    }
  } catch (error) {
    console.error("Ошибка:", error);
  }
  return false;
}

// ========== API ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, state, tonWallet, taskId, deposit_id } = req.body;
  
  try {
    const bannedUser = await User.findOne({ userId: user_id, isBanned: true });
    if (bannedUser) {
      return res.status(403).json({ success: false, error: 'BANNED' });
    }
    
    // РЕГИСТРАЦИЯ
    if (action === 'register') {
      let user = await User.findOne({ userId: user_id });
      
      if (!user) {
        const initialGameState = { minerQuantities: { basic: 1 }, accumulatedTon: 0, accumulatedGpu: 0 };
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
      } else {
        await calculateAndSaveOfflineAccumulated(user_id);
        user = await User.findOne({ userId: user_id });
      }
      
      const transactions = await Deposit.find({ userId: user_id }).sort({ createdAt: -1 }).limit(50);
      
      // ⚠️ ГЛАВНОЕ ИСПРАВЛЕНИЕ: БЕРЕМ ИЗ gameState
      const accumulatedTon = user.gameState?.accumulatedTon || 0;
      const accumulatedGpu = user.gameState?.accumulatedGpu || 0;
      
      console.log(`📤 ${user_id}: накопления TON=${accumulatedTon}, GPU=${accumulatedGpu}`);
      
      return res.json({
        success: true,
        data: {
          ton: user.ton,
          gpu: user.gpu,
          friends: user.friends,
          isBanned: user.isBanned,
          gameState: user.gameState,
          invitedFriends: user.invitedFriends || [],
          transactions: transactions.map(t => ({ id: t._id, amount: t.amount, type: t.type, status: t.status, createdAt: t.createdAt })),
          accumulatedTon: accumulatedTon,
          accumulatedGpu: accumulatedGpu
        }
      });
    }
    
    // СОХРАНЕНИЕ
    if (action === 'save') {
      try {
        const oldUser = await User.findOne({ userId: user_id });
        const oldGpu = oldUser?.gpu || 0;
        
        let newGameState = state || { minerQuantities: { basic: 1 } };
        
        if (oldUser?.gameState) {
          if (newGameState.accumulatedTon === undefined && oldUser.gameState.accumulatedTon !== undefined) {
            newGameState.accumulatedTon = oldUser.gameState.accumulatedTon;
          }
          if (newGameState.accumulatedGpu === undefined && oldUser.gameState.accumulatedGpu !== undefined) {
            newGameState.accumulatedGpu = oldUser.gameState.accumulatedGpu;
          }
        }
        
        if (newGameState.accumulatedTon === undefined) newGameState.accumulatedTon = 0;
        if (newGameState.accumulatedGpu === undefined) newGameState.accumulatedGpu = 0;
        
        await User.findOneAndUpdate(
          { userId: user_id }, 
          { ton, gpu, friends, gameState: newGameState, lastSeen: new Date() }, 
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
        return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED' });
      }
      const comment = `DEPOSIT_${user_id}_${Date.now()}`;
      const deposit = new Deposit({ userId: user_id, userName: name, amount, wallet: process.env.TON_WALLET || "EQD4ZKIqF7XxPoUcPE5P7gL8N8UqZfjqJXzLvzVcUa2h", comment, type: 'deposit' });
      await deposit.save();
      return res.json({ success: true, deposit: { id: deposit._id, amount, wallet: process.env.TON_WALLET, comment } });
    }
    
    // ПОДТВЕРЖДЕНИЕ ОПЛАТЫ
    if (action === 'confirmDeposit') {
      const deposit = await Deposit.findById(deposit_id);
      if (!deposit || deposit.status !== 'pending') {
        return res.status(404).json({ success: false, error: 'Deposit not found or already processed' });
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
        return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED' });
      }
      
      const user = await User.findOne({ userId: user_id });
      if (!user || user.ton < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });
      
      user.ton -= amount;
      await user.save();
      
      const comment = `WITHDRAW_${user_id}_${Date.now()}`;
      const withdrawRequest = new Deposit({ userId: user_id, userName: name, amount, wallet: tonWallet, comment, type: 'withdraw', status: 'pending' });
      await withdrawRequest.save();
      
      return res.json({ success: true, message: 'Withdraw request created' });
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

// ========== АДМИН-ПАНЕЛЬ (сокращённо) ==========
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
  
  res.send(`<!DOCTYPE html>
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Panel</title>
  <style>body{background:#0B0E1A;color:#fff;font-family:system-ui;padding:20px}</style>
  </head><body>
  <h1>Admin Panel</h1>
  <p>Total users: ${totalUsers}</p>
  <p>Total TON: ${totalTon}</p>
  <a href="/admin/logout">Logout</a>
  </body></html>`);
});

// ========== API для админ-панели ==========
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

app.post('/admin/api/giveGpu', requireAuth, async (req, res) => {
  const { userId, amount } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.gpu += amount;
  await user.save();
  await addEarnedGpuToReferrer(userId, amount);
  res.json({ success: true });
});

app.post('/admin/api/giveTon', requireAuth, async (req, res) => {
  const { userId, amount } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.ton += amount;
  await user.save();
  res.json({ success: true });
});

app.get('/admin/api/tasks/list', requireAuth, async (req, res) => {
  const tasks = await Task.find().sort({ order: 1 });
  res.json({ tasks });
});

app.post('/admin/api/tasks/save', requireAuth, async (req, res) => {
  const { id, title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order } = req.body;
  await Task.findOneAndUpdate(
    { id: id || `task_${Date.now()}` },
    { title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order, isActive: true },
    { upsert: true }
  );
  res.json({ success: true });
});

app.post('/admin/api/tasks/delete', requireAuth, async (req, res) => {
  const { id } = req.body;
  await Task.findOneAndDelete({ id });
  res.json({ success: true });
});

app.post('/admin/api/tasks/approve', requireAuth, async (req, res) => {
  const { userTaskId } = req.body;
  const userTask = await UserTask.findById(userTaskId);
  if (!userTask || userTask.claimed) return res.json({ success: false });
  const task = await Task.findOne({ id: userTask.taskId });
  const user = await User.findOne({ userId: userTask.userId });
  if (user && task) {
    user.ton += task.rewardTon;
    user.gpu += task.rewardGpu;
    await user.save();
    await addEarnedGpuToReferrer(userTask.userId, task.rewardGpu);
  }
  userTask.claimed = true;
  await userTask.save();
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
  } else {
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
app.get('/clearusers', async (req, res) => {
  const result = await User.deleteMany({});
  res.send(`✅ Deleted ${result.deletedCount} users`);
});
app.get('/', (req, res) => { res.json({ status: 'OK' }); });

// ========== API ДЛЯ БОТА ==========
app.post('/api/bot/registerRef', async (req, res) => {
  const { userId, referrerId, name } = req.body;
  try {
    const referrer = await User.findOne({ userId: referrerId });
    if (!referrer) return res.json({ success: false, error: 'Referrer not found' });
    
    const alreadyInvited = referrer.invitedFriends.some(f => f.friendId === userId);
    if (alreadyInvited) return res.json({ success: false, error: 'Already invited' });
    
    referrer.invitedFriends.push({
      friendId: userId,
      friendName: name || `User_${userId.slice(-5)}`,
      date: new Date().toLocaleDateString(),
      earnedGpu: 0
    });
    referrer.friends = referrer.invitedFriends.length;
    await referrer.save();
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
mongoose.connect(process.env.MONGODB_URL).then(async () => {
  console.log('✅ Connected to MongoDB');
  await ensureAdminExists();
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
}).catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });
