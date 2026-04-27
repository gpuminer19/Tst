const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ========== СХЕМЫ ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  ton: { type: Number, default: 0 },
  gpu: { type: Number, default: 15 },
  friends: { type: Number, default: 0 },
  referrerId: String,
  isBanned: { type: Boolean, default: false },
  banReason: String,
  invitedFriends: [{ 
    friendId: String, 
    friendName: String, 
    date: String,
    earnedGpu: { type: Number, default: 0 }
  }],
  lastMiningUpdate: { type: Date, default: Date.now },
  accumulatedTon: { type: Number, default: 0 },
  accumulatedGpu: { type: Number, default: 0 },
  minerQuantities: { type: Object, default: { basic: 1 } },
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

const taskSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  description: String,
  rewardTon: Number,
  rewardGpu: Number,
  type: { type: String, default: 'manual' },
  taskUrl: String,
  isDaily: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  order: { type: Number, default: 0 }
});

const userTaskSchema = new mongoose.Schema({
  userId: String,
  taskId: String,
  completedAt: Date,
  claimed: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Admin = mongoose.model('Admin', adminSchema);
const Task = mongoose.model('Task', taskSchema);
const UserTask = mongoose.model('UserTask', userTaskSchema);

// ========== РЕЙТЫ МАЙНЕРОВ ==========
const RATES = {
  basic: { ton: 0.01 / 24, gpu: 15 / 24 },
  normal: { ton: 0.02 / 24, gpu: 15 / 24 },
  pro: { ton: 0.1 / 24, gpu: 75 / 24 },
  ultra: { ton: 0.6 / 24, gpu: 380 / 24 },
  legendary: { ton: 1.4 / 24, gpu: 780 / 24 },
  minex: { ton: 7 / 24, gpu: 1800 / 24 },
  friend: { ton: 0.1 / 24, gpu: 15 / 24 },
  bro: { ton: 0.5 / 24, gpu: 75 / 24 },
  nexus: { ton: 1.5 / 24, gpu: 200 / 24 }
};

// ========== ФУНКЦИЯ ОФЛАЙН-НАКОПЛЕНИЙ ==========
async function calculateOffline(userId) {
  const user = await User.findOne({ userId });
  if (!user || user.isBanned) return;

  const now = Date.now();
  const lastUpdate = user.lastMiningUpdate || now;
  const hoursPassed = (now - lastUpdate) / (1000 * 3600);

  if (hoursPassed < 0.0001 || hoursPassed > 720) {
    user.lastMiningUpdate = now;
    await user.save();
    return;
  }

  let earnedTon = 0;
  let earnedGpu = 0;

  for (const [minerId, qty] of Object.entries(user.minerQuantities || {})) {
    const rate = RATES[minerId];
    if (rate && qty > 0 && !rate.isReferral) {
      earnedTon += rate.ton * qty * hoursPassed;
      earnedGpu += rate.gpu * qty * hoursPassed;
    }
  }

  if (earnedTon > 0 || earnedGpu > 0) {
    user.accumulatedTon += earnedTon;
    user.accumulatedGpu += earnedGpu;
  }
  user.lastMiningUpdate = now;
  await user.save();
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
async function addEarnedGpuToReferrer(userId, earnedGpu) {
  if (!earnedGpu || earnedGpu <= 0) return;
  const referrer = await User.findOne({ "invitedFriends.friendId": userId });
  if (referrer) {
    const friend = referrer.invitedFriends.find(f => f.friendId === userId);
    if (friend) {
      friend.earnedGpu = (friend.earnedGpu || 0) + earnedGpu;
      await referrer.save();
    }
  }
}

async function ensureAdminExists() {
  const existing = await Admin.findOne({ username: process.env.ADMIN_USER });
  if (!existing && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
    await Admin.create({ username: process.env.ADMIN_USER, passwordHash: hash });
  }
}

// ========== API ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, ton, gpu, friends, accumulatedTon, accumulatedGpu, minerQuantities, amount, tonWallet, taskId } = req.body;

  try {
    const banned = await User.findOne({ userId: user_id, isBanned: true });
    if (banned) return res.status(403).json({ success: false, error: 'BANNED' });

    // РЕГИСТРАЦИЯ
    if (action === 'register') {
      let user = await User.findOne({ userId: user_id });
      if (!user) {
        user = new User({
          userId: user_id,
          name: name || 'Игрок',
          minerQuantities: { basic: 1 }
        });
        if (referrer_id && referrer_id !== user_id) {
          const referrer = await User.findOne({ userId: referrer_id });
          if (referrer) {
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
        await calculateOffline(user_id);
        user = await User.findOne({ userId: user_id });
      }

      return res.json({
        success: true,
        data: {
          ton: user.ton,
          gpu: user.gpu,
          friends: user.friends,
          invitedFriends: user.invitedFriends || [],
          accumulatedTon: user.accumulatedTon,
          accumulatedGpu: user.accumulatedGpu,
          minerQuantities: user.minerQuantities
        }
      });
    }

    // СОХРАНЕНИЕ
    if (action === 'save') {
      const oldUser = await User.findOne({ userId: user_id });
      const oldGpu = oldUser?.gpu || 0;

      await User.findOneAndUpdate(
        { userId: user_id },
        { ton, gpu, friends, accumulatedTon, accumulatedGpu, minerQuantities, lastSeen: new Date() },
        { upsert: true }
      );

      const earnedGpu = gpu - oldGpu;
      if (earnedGpu > 0) await addEarnedGpuToReferrer(user_id, earnedGpu);
      return res.json({ success: true });
    }

    // РЕФЕРАЛЫ
    if (action === 'getReferrals') {
      const user = await User.findOne({ userId: user_id });
      return res.json({ success: true, referrals: user?.invitedFriends || [] });
    }

    // ПОПОЛНЕНИЕ
    if (action === 'createDeposit') {
      const pendingCount = await Deposit.countDocuments({ userId: user_id, status: 'pending', type: 'deposit' });
      if (pendingCount >= 2) return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED' });
      const deposit = new Deposit({ userId: user_id, userName: name, amount, wallet: process.env.TON_WALLET, comment: `DEPOSIT_${user_id}_${Date.now()}`, type: 'deposit' });
      await deposit.save();
      return res.json({ success: true, deposit: { id: deposit._id, amount, wallet: process.env.TON_WALLET } });
    }

    // ПОДТВЕРЖДЕНИЕ ОПЛАТЫ
    if (action === 'confirmDeposit') {
      const deposit = await Deposit.findById(deposit_id);
      if (!deposit || deposit.status !== 'pending') return res.json({ success: false });
      const user = await User.findOne({ userId: deposit.userId });
      if (user) {
        user.ton += deposit.amount;
        user.totalDeposited += deposit.amount;
        await user.save();
      }
      deposit.status = 'completed';
      await deposit.save();
      return res.json({ success: true });
    }

    // ВЫВОД
    if (action === 'createWithdraw') {
      if (!amount || amount < 1) return res.json({ success: false, error: 'Invalid amount' });
      const pendingCount = await Deposit.countDocuments({ userId: user_id, status: 'pending', type: 'withdraw' });
      if (pendingCount >= 2) return res.json({ success: false, error: 'LIMIT_EXCEEDED' });
      const user = await User.findOne({ userId: user_id });
      if (!user || user.ton < amount) return res.json({ success: false, error: 'Insufficient balance' });
      user.ton -= amount;
      await user.save();
      const withdraw = new Deposit({ userId: user_id, userName: name, amount, wallet: tonWallet, comment: `WITHDRAW_${user_id}_${Date.now()}`, type: 'withdraw' });
      await withdraw.save();
      return res.json({ success: true });
    }

    // ЗАДАНИЯ - СПИСОК
    if (action === 'tasks/list') {
      const tasks = await Task.find({ isActive: true }).sort({ order: 1 });
      const completed = await UserTask.find({ userId: user_id, claimed: true });
      const pending = await UserTask.find({ userId: user_id, claimed: false });
      const result = tasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        rewardTon: t.rewardTon,
        rewardGpu: t.rewardGpu,
        taskUrl: t.taskUrl,
        completed: completed.some(c => c.taskId === t.id),
        pending: pending.some(p => p.taskId === t.id)
      }));
      return res.json({ success: true, tasks: result });
    }

    // ЗАДАНИЯ - ВЫПОЛНИТЬ
    if (action === 'tasks/complete') {
      const task = await Task.findOne({ id: taskId });
      if (!task) return res.json({ success: false });
      const existing = await UserTask.findOne({ userId: user_id, taskId, claimed: true });
      if (existing) return res.json({ success: false });
      const pending = await UserTask.findOne({ userId: user_id, taskId, claimed: false });
      if (pending) return res.json({ success: false });
      const userTask = new UserTask({ userId: user_id, taskId, completedAt: new Date(), claimed: false });
      await userTask.save();
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false });
  }
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const bcrypt = require('bcrypt');
  const admin = await Admin.findOne({ username });
  if (admin && await bcrypt.compare(password, admin.passwordHash)) {
    req.session.adminId = admin._id;
    return res.json({ success: true });
  }
  res.json({ success: false });
});

app.get('/admin/check', (req, res) => {
  res.json({ loggedIn: !!req.session.adminId });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// API для админки
app.get('/admin/api/users', async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 }).limit(100);
  res.json(users);
});

app.get('/admin/api/users/search', async (req, res) => {
  const { q } = req.query;
  const users = await User.find({ $or: [{ userId: { $regex: q, $options: 'i' } }, { name: { $regex: q, $options: 'i' } }] }).limit(50);
  res.json(users);
});

app.post('/admin/api/user/giveGpu', async (req, res) => {
  const { userId, amount } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.gpu += amount;
  await user.save();
  await addEarnedGpuToReferrer(userId, amount);
  res.json({ success: true });
});

app.post('/admin/api/user/giveTon', async (req, res) => {
  const { userId, amount } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.ton += amount;
  await user.save();
  res.json({ success: true });
});

app.post('/admin/api/user/giveMiner', async (req, res) => {
  const { userId, minerId, quantity } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.json({ success: false });
  user.minerQuantities = user.minerQuantities || {};
  user.minerQuantities[minerId] = (user.minerQuantities[minerId] || 0) + quantity;
  await user.save();
  res.json({ success: true });
});

app.post('/admin/api/user/setBalance', async (req, res) => {
  const { userId, ton, gpu } = req.body;
  await User.findOneAndUpdate({ userId }, { ton, gpu });
  res.json({ success: true });
});

app.post('/admin/api/user/ban', async (req, res) => {
  const { userId, reason } = req.body;
  await User.findOneAndUpdate({ userId }, { isBanned: true, banReason: reason });
  res.json({ success: true });
});

app.post('/admin/api/user/unban', async (req, res) => {
  const { userId } = req.body;
  await User.findOneAndUpdate({ userId }, { isBanned: false, banReason: null });
  res.json({ success: true });
});

// Заявки
app.get('/admin/api/deposits/pending', async (req, res) => {
  const deposits = await Deposit.find({ status: 'pending', type: 'deposit' }).sort('-createdAt');
  res.json(deposits);
});

app.get('/admin/api/withdraws/pending', async (req, res) => {
  const withdraws = await Deposit.find({ status: 'pending', type: 'withdraw' }).sort('-createdAt');
  res.json(withdraws);
});

app.post('/admin/api/deposit/approve', async (req, res) => {
  const { id } = req.body;
  const deposit = await Deposit.findById(id);
  if (!deposit || deposit.status !== 'pending') return res.json({ success: false });
  const user = await User.findOne({ userId: deposit.userId });
  if (user) {
    user.ton += deposit.amount;
    await user.save();
  }
  deposit.status = 'completed';
  await deposit.save();
  res.json({ success: true });
});

app.post('/admin/api/withdraw/approve', async (req, res) => {
  const { id } = req.body;
  const withdraw = await Deposit.findById(id);
  if (!withdraw || withdraw.status !== 'pending') return res.json({ success: false });
  withdraw.status = 'completed';
  await withdraw.save();
  res.json({ success: true });
});

app.post('/admin/api/withdraw/reject', async (req, res) => {
  const { id } = req.body;
  const withdraw = await Deposit.findById(id);
  if (!withdraw || withdraw.status !== 'pending') return res.json({ success: false });
  const user = await User.findOne({ userId: withdraw.userId });
  if (user) user.ton += withdraw.amount;
  await user?.save();
  withdraw.status = 'cancelled';
  await withdraw.save();
  res.json({ success: true });
});

// Задания (админ)
app.get('/admin/api/tasks', async (req, res) => {
  const tasks = await Task.find().sort({ order: 1 });
  res.json(tasks);
});

app.post('/admin/api/tasks/save', async (req, res) => {
  const { id, title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order } = req.body;
  await Task.findOneAndUpdate(
    { id: id || `task_${Date.now()}` },
    { title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order, isActive: true },
    { upsert: true }
  );
  res.json({ success: true });
});

app.post('/admin/api/tasks/delete', async (req, res) => {
  const { id } = req.body;
  await Task.findOneAndDelete({ id });
  res.json({ success: true });
});

// Задания на подтверждение
app.get('/admin/api/tasks/pending', async (req, res) => {
  const pending = await UserTask.find({ claimed: false });
  const result = [];
  for (const p of pending) {
    const task = await Task.findOne({ id: p.taskId });
    const user = await User.findOne({ userId: p.userId });
    if (task && user) {
      result.push({
        id: p._id,
        userId: p.userId,
        userName: user.name,
        taskTitle: task.title,
        rewardTon: task.rewardTon,
        rewardGpu: task.rewardGpu
      });
    }
  }
  res.json(result);
});

app.post('/admin/api/tasks/approve', async (req, res) => {
  const { id } = req.body;
  const userTask = await UserTask.findById(id);
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

// ========== ЗАПУСК ==========
const session = require('express-session');
const MongoStore = require('connect-mongo');
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URL }),
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 8080;
mongoose.connect(process.env.MONGODB_URL).then(async () => {
  console.log('✅ Connected to MongoDB');
  await ensureAdminExists();
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
}).catch(err => console.error('❌ MongoDB error:', err));
