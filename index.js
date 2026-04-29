const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const axios = require('axios');
const crypto = require('crypto');

// Импорт обработчика вебхука
const { handleWebhook } = require('./handlers');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ========== СЕССИИ ==========
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URL }),
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ========== TELEGRAM УВЕДОМЛЕНИЯ ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

async function sendTelegramNotification(text, buttons = null) {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
  
  try {
    const payload = {
      chat_id: ADMIN_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    };
    if (buttons && buttons.length > 0) {
      payload.reply_markup = {
        inline_keyboard: buttons.map(row => row.map(btn => ({
          text: btn.text,
          callback_data: btn.callback_data
        })))
      };
    }
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload);
  } catch (error) {
    console.error('Telegram error:', error.message);
  }
}

// ========== СХЕМЫ MONGODB ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  ton: { type: Number, default: 0 },
  gpu: { type: Number, default: 15 },
  friends: { type: Number, default: 0 },
  referrerId: { type: String, default: null },
  isBanned: { type: Boolean, default: false },
  isBot: { type: Boolean, default: false },
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

// ========== КОНСТАНТЫ ==========
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

const MINER_PRICES = {
  basic: { ton: 0, gpu: 1 },
  normal: { ton: 2, gpu: 0 },
  pro: { ton: 10, gpu: 0 },
  ultra: { ton: 50, gpu: 0 },
  legendary: { ton: 100, gpu: 0 },
  minex: { ton: 500, gpu: 0 }
};

const MINER_LIMITS = {
  basic: 30,
  normal: null,
  pro: null,
  ultra: null,
  legendary: null,
  minex: null
};

// ========== ВЕРИФИКАЦИЯ TELEGRAM INIT DATA ==========
function verifyTelegramInitData(initData) {
  if (!initData) return false;
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    if (!hash) return false;
    urlParams.delete('hash');
    const paramsArray = Array.from(urlParams.entries());
    paramsArray.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = paramsArray.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();
    const computedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    if (computedHash !== hash) return false;
    const authDate = parseInt(urlParams.get('auth_date'));
    if (authDate && (Date.now() / 1000 - authDate) > 86400) return false;
    return true;
  } catch (error) {
    console.error('Verify error:', error);
    return false;
  }
}

// ========== MIDDLEWARE ПРОВЕРКИ ПОДПИСИ ==========
app.use('/api/tg', (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData && process.env.NODE_ENV !== 'production') return next();
  if (!initData) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!verifyTelegramInitData(initData)) return res.status(403).json({ success: false, error: 'Forbidden' });
  const urlParams = new URLSearchParams(initData);
  const userParam = urlParams.get('user');
  if (userParam) {
    try {
      const userObj = JSON.parse(userParam);
      req.verifiedUserId = userObj.id.toString();
      req.verifiedUserName = userObj.first_name || userObj.username;
    } catch(e) {}
  }
  next();
});

// ========== ФУНКЦИИ БИЗНЕС-ЛОГИКИ ==========
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
  let earnedTon = 0, earnedGpu = 0;
  for (const [minerId, qty] of Object.entries(user.minerQuantities || {})) {
    const rate = RATES[minerId];
    if (rate && qty > 0) {
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
  console.log(`📊 ${userId}: офлайн-накоплено +${earnedTon.toFixed(8)} TON`);
}

async function giveReferralCommission(userId, claimedTon, claimedGpu) {
  if (!claimedTon && !claimedGpu) return;
  const user = await User.findOne({ userId });
  if (!user || !user.referrerId) return;
  const referrer = await User.findOne({ userId: user.referrerId });
  if (!referrer || referrer.isBanned) return;
  const commissionTon = claimedTon * 0.02;
  const commissionGpu = claimedGpu * 0.02;
  if (commissionTon > 0 || commissionGpu > 0) {
    referrer.ton += commissionTon;
    referrer.gpu += commissionGpu;
    const friend = referrer.invitedFriends.find(f => f.friendId === userId);
    if (friend) friend.earnedGpu = (friend.earnedGpu || 0) + claimedGpu;
    await referrer.save();
    console.log(`👥 Рефереру ${referrer.userId} начислено +${commissionTon.toFixed(6)} TON`);
  }
}

async function checkReferralMiners(userId) {
  const user = await User.findOne({ userId });
  if (!user) return;
  const activeFriendsCount = user.invitedFriends.filter(f => (f.earnedGpu || 0) >= 30).length;
  let updated = false;
  if (activeFriendsCount >= 10 && !user.minerQuantities?.friend) {
    user.minerQuantities = user.minerQuantities || {};
    user.minerQuantities.friend = 1;
    updated = true;
    console.log(`🎁 ${userId}: получен Friend Miner`);
    await sendTelegramNotification(`🎁 <b>Получен Friend Miner!</b>\nПользователь: <code>${userId}</code>`);
  }
  if (activeFriendsCount >= 50 && !user.minerQuantities?.bro) {
    user.minerQuantities = user.minerQuantities || {};
    user.minerQuantities.bro = 1;
    updated = true;
    console.log(`🎁 ${userId}: получен Bro Miner`);
    await sendTelegramNotification(`🎁 <b>Получен Bro Miner!</b>\nПользователь: <code>${userId}</code>`);
  }
  if (activeFriendsCount >= 150 && !user.minerQuantities?.nexus) {
    user.minerQuantities = user.minerQuantities || {};
    user.minerQuantities.nexus = 1;
    updated = true;
    console.log(`🎁 ${userId}: получен Nexus Miner`);
    await sendTelegramNotification(`🎁 <b>Получен Nexus Miner!</b>\nПользователь: <code>${userId}</code>`);
  }
  if (updated) await user.save();
}

async function ensureAdminExists() {
  const bcrypt = require('bcrypt');
  const existing = await Admin.findOne({ username: process.env.ADMIN_USER });
  if (!existing && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
    await Admin.create({ username: process.env.ADMIN_USER, passwordHash: hash });
    console.log('✅ Admin created');
  }
}

// ========== TELEGRAM WEBHOOK (вынесен в handlers.js) ==========
app.post('/telegram/webhook', async (req, res) => {
  try {
    await handleWebhook(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// ========== API ЭНДПОИНТЫ ==========
app.post('/api/exchange', async (req, res) => {
  const { user_id, amount } = req.body;
  if (!user_id || !amount || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid data' });
  if (req.verifiedUserId && req.verifiedUserId !== user_id) return res.status(403).json({ success: false, error: 'USER_ID_MISMATCH' });
  try {
    const user = await User.findOne({ userId: user_id });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (user.gpu < amount) return res.status(400).json({ success: false, error: 'Insufficient GPU' });
    const EXCHANGE_RATE = 0.001;
    const tonReceived = amount * EXCHANGE_RATE;
    user.gpu -= amount;
    user.ton += tonReceived;
    await user.save();
    console.log(`🔄 ${user_id}: продал ${amount} GPU за ${tonReceived} TON`);
    res.json({ success: true, data: { ton: user.ton, gpu: user.gpu, tonReceived } });
  } catch (error) {
    console.error('Exchange error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, ton, gpu, friends, minerQuantities, amount, tonWallet, taskId, deposit_id, minerId, quantity } = req.body;

  try {
    if (req.verifiedUserId && req.verifiedUserId !== user_id) return res.status(403).json({ success: false, error: 'USER_ID_MISMATCH' });
    const banned = await User.findOne({ userId: user_id, isBanned: true });
    if (banned) return res.status(403).json({ success: false, error: 'BANNED' });

    if (action === 'register') {
      if (!checkRateLimit(user_id, 'register', 5000, 3)) return res.status(429).json({ success: false, error: 'TOO_MANY_REQUESTS' });
      let user = await User.findOne({ userId: user_id });
      if (!user) {
        user = new User({ userId: user_id, name: req.verifiedUserName || name || 'Игрок', minerQuantities: { basic: 1 }, referrerId: null });
        if (referrer_id && referrer_id !== user_id && referrer_id !== 'null' && referrer_id !== 'undefined') {
          const referrer = await User.findOne({ userId: referrer_id });
          if (referrer && !referrer.isBanned && !referrer.isBot) {
            user.referrerId = referrer_id;
            const alreadyInvited = referrer.invitedFriends.some(f => f.friendId === user_id);
            if (!alreadyInvited) {
              referrer.invitedFriends.push({ friendId: user_id, friendName: name || user_id.slice(-5), date: new Date().toLocaleDateString(), earnedGpu: 0 });
              referrer.friends = referrer.invitedFriends.length;
              await referrer.save();
              console.log(`👥 Реферал: ${referrer_id} → ${user_id}`);
            }
          }
        }
        await user.save();
        console.log(`🆕 Новый пользователь: ${user_id} (${user.name})`);
        await sendTelegramNotification(`🆕 <b>Новый игрок!</b>\nID: <code>${user_id}</code>\nИмя: ${name || 'Игрок'}`);
      } else {
        console.log(`👤 Вход пользователя: ${user_id} (${user.name})`);
        await calculateOffline(user_id);
        user = await User.findOne({ userId: user_id });
      }
      const transactions = await Deposit.find({ userId: user_id }).sort({ createdAt: -1 }).limit(50);
      return res.json({ success: true, data: { ton: user.ton, gpu: user.gpu, friends: user.friends, invitedFriends: user.invitedFriends || [], accumulatedTon: user.accumulatedTon, accumulatedGpu: user.accumulatedGpu, minerQuantities: user.minerQuantities, transactions: transactions.map(t => ({ id: t._id, amount: t.amount, type: t.type, status: t.status, createdAt: t.createdAt })) } });
    }

    if (action === 'save') {
      const existingUser = await User.findOne({ userId: user_id });
      if (!existingUser) return res.json({ success: false, error: "User not found" });
      const updateData = { friends, lastSeen: new Date() };
      if (minerQuantities && Object.keys(minerQuantities).length > 0) updateData.minerQuantities = minerQuantities;
      await User.findOneAndUpdate({ userId: user_id }, updateData, { upsert: false });
      console.log(`💾 Сохранено состояние для ${user_id}`);
      return res.json({ success: true });
    }

    if (action === 'claim') {
      if (!checkRateLimit(user_id, 'claim', 1000, 2)) return res.json({ success: false, error: "TOO_FAST" });
      if (!checkClaimRateLimit(user_id)) return res.json({ success: false, error: "CLAIM_COOLDOWN" });
      await calculateOffline(user_id);
      const user = await User.findOne({ userId: user_id });
      if (!user) return res.json({ success: false, error: "User not found" });
      const rewardTon = user.accumulatedTon || 0;
      const rewardGpu = user.accumulatedGpu || 0;
      if (rewardTon === 0 && rewardGpu === 0) return res.json({ success: false, error: "NOTHING_TO_CLAIM" });
      user.ton += rewardTon;
      user.gpu += rewardGpu;
      user.accumulatedTon = 0;
      user.accumulatedGpu = 0;
      await user.save();
      await giveReferralCommission(user_id, rewardTon, rewardGpu);
      console.log(`🎁 ${user_id}: собрал награду +${rewardTon.toFixed(8)} TON`);
      return res.json({ success: true, data: { ton: user.ton, gpu: user.gpu, accumulatedTon: 0, accumulatedGpu: 0 } });
    }

    if (action === 'buy') {
      if (!checkRateLimit(user_id, 'buy', 2000, 3)) return res.json({ success: false, error: "TOO_FAST" });
      if (!minerId) return res.status(400).json({ success: false, error: "INVALID_MINER_ID" });
      const price = MINER_PRICES[minerId];
      const limit = MINER_LIMITS[minerId];
      if (!price) return res.json({ success: false, error: "INVALID_MINER" });
      const user = await User.findOne({ userId: user_id });
      if (!user) return res.json({ success: false, error: "User not found" });
      const currentQty = user.minerQuantities?.[minerId] || 0;
      const buyQuantity = quantity || 1;
      if (limit !== null && currentQty + buyQuantity > limit) return res.json({ success: false, error: "LIMIT_REACHED" });
      const totalTonPrice = price.ton * buyQuantity;
      const totalGpuPrice = price.gpu * buyQuantity;
      if (totalTonPrice > 0 && user.ton < totalTonPrice) return res.json({ success: false, error: "INSUFFICIENT_TON" });
      if (totalGpuPrice > 0 && user.gpu < totalGpuPrice) return res.json({ success: false, error: "INSUFFICIENT_GPU" });
      if (totalTonPrice > 0) user.ton -= totalTonPrice;
      if (totalGpuPrice > 0) user.gpu -= totalGpuPrice;
      user.minerQuantities = user.minerQuantities || {};
      user.minerQuantities[minerId] = (user.minerQuantities[minerId] || 0) + buyQuantity;
      await user.save();
      console.log(`⛏️ ${user_id}: купил ${buyQuantity} x ${minerId}`);
      return res.json({ success: true, data: { ton: user.ton, gpu: user.gpu, minerQuantities: user.minerQuantities } });
    }

    if (action === 'getReferrals') {
      if (!checkRateLimit(user_id, 'getReferrals', 5000, 10)) return res.status(429).json({ success: false, error: "TOO_MANY_REQUESTS" });
      const user = await User.findOne({ userId: user_id });
      return res.json({ success: true, referrals: user?.invitedFriends || [] });
    }

    if (action === 'createDeposit') {
      const pendingCount = await Deposit.countDocuments({ userId: user_id, status: 'pending', type: 'deposit' });
      if (pendingCount >= 2) return res.status(400).json({ success: false, error: 'LIMIT_EXCEEDED' });
      const deposit = new Deposit({ userId: user_id, userName: name, amount, wallet: process.env.TON_WALLET, comment: `DEPOSIT_${user_id}_${Date.now()}`, type: 'deposit' });
      await deposit.save();
      await sendTelegramNotification(`💎 <b>Заявка на пополнение!</b>\nПользователь: <code>${user_id}</code>\nСумма: ${amount} TON`, [[{ text: "✅ Подтвердить", callback_data: `approve:deposit:${deposit._id}` }, { text: "❌ Отклонить", callback_data: `reject:deposit:${deposit._id}` }]]);
      return res.json({ success: true, deposit: { id: deposit._id, amount, wallet: process.env.TON_WALLET } });
    }

    if (action === 'confirmDeposit') {
      const deposit = await Deposit.findById(deposit_id);
      if (!deposit || deposit.status !== 'pending') return res.json({ success: false });
      await User.updateOne({ userId: deposit.userId }, { $inc: { ton: deposit.amount, totalDeposited: deposit.amount } });
      deposit.status = 'completed';
      deposit.processedAt = new Date();
      deposit.processedBy = 'admin';
      await deposit.save();
      return res.json({ success: true });
    }

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
      await sendTelegramNotification(`📤 <b>Заявка на вывод!</b>\nПользователь: <code>${user_id}</code>\nСумма: ${amount} TON\nКошелёк: <code>${tonWallet}</code>`, [[{ text: "✅ Подтвердить", callback_data: `approve:withdraw:${withdraw._id}` }, { text: "❌ Отклонить", callback_data: `reject:withdraw:${withdraw._id}` }]]);
      return res.json({ success: true });
    }

    if (action === 'tasks/list') {
      const tasks = await Task.find({ isActive: true }).sort({ order: 1 });
      const completed = await UserTask.find({ userId: user_id, claimed: true });
      const pending = await UserTask.find({ userId: user_id, claimed: false });
      const result = tasks.map(t => ({ id: t.id, title: t.title, description: t.description, rewardTon: t.rewardTon, rewardGpu: t.rewardGpu, taskUrl: t.taskUrl, completed: completed.some(c => c.taskId === t.id), pending: pending.some(p => p.taskId === t.id) }));
      return res.json({ success: true, tasks: result });
    }

    if (action === 'tasks/complete') {
      const task = await Task.findOne({ id: taskId });
      if (!task) return res.json({ success: false });
      const existing = await UserTask.findOne({ userId: user_id, taskId, claimed: true });
      if (existing) return res.json({ success: false });
      const pending = await UserTask.findOne({ userId: user_id, taskId, claimed: false });
      if (pending) return res.json({ success: false });
      const userTask = new UserTask({ userId: user_id, taskId, completedAt: new Date(), claimed: false });
      await userTask.save();
      const user = await User.findOne({ userId: user_id });
      await sendTelegramNotification(`📋 <b>Новое выполненное задание!</b>\n👤 Пользователь: <code>${user_id}</code> (${user?.name || 'Игрок'})\n📌 Задание: ${task.title}\n🎁 Награда: +${task.rewardTon} TON, +${task.rewardGpu} GPU`, [[{ text: "✅ Подтвердить", callback_data: `approve:task:${userTask._id}` }, { text: "❌ Отклонить", callback_data: `reject:task:${userTask._id}` }]]);
      return res.json({ success: true });
    }

    return res.status(400).json({ success: false });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const bcrypt = require('bcrypt');
  const admin = await Admin.findOne({ username });
  if (admin && await bcrypt.compare(password, admin.passwordHash)) {
    req.session.admin = { username: admin.username, role: admin.role };
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false });
});

app.get('/admin/check', (req, res) => {
  res.json({ loggedIn: !!req.session.admin });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

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
  await User.updateOne({ userId: deposit.userId }, { $inc: { ton: deposit.amount } });
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
  await User.updateOne({ userId: withdraw.userId }, { $inc: { ton: withdraw.amount } });
  withdraw.status = 'cancelled';
  await withdraw.save();
  res.json({ success: true });
});

app.get('/admin/api/tasks', async (req, res) => {
  const tasks = await Task.find().sort({ order: 1 });
  res.json(tasks);
});

app.post('/admin/api/tasks/save', async (req, res) => {
  const { id, title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order } = req.body;
  await Task.findOneAndUpdate({ id: id || `task_${Date.now()}` }, { title, description, rewardTon, rewardGpu, type, taskUrl, isDaily, order, isActive: true }, { upsert: true });
  res.json({ success: true });
});

app.post('/admin/api/tasks/delete', async (req, res) => {
  const { id } = req.body;
  await Task.findOneAndDelete({ id });
  res.json({ success: true });
});

app.get('/admin/api/tasks/pending', async (req, res) => {
  const pending = await UserTask.find({ claimed: false });
  const result = [];
  for (const p of pending) {
    const task = await Task.findOne({ id: p.taskId });
    const user = await User.findOne({ userId: p.userId });
    if (task && user) {
      result.push({ id: p._id, userId: p.userId, userName: user.name, taskTitle: task.title, rewardTon: task.rewardTon, rewardGpu: task.rewardGpu });
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
    await giveReferralCommission(userTask.userId, task.rewardTon, task.rewardGpu);
  }
  userTask.claimed = true;
  await userTask.save();
  res.json({ success: true });
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 8080;
app.use(express.static(__dirname));

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  console.log('✅ Connected to MongoDB');
  await ensureAdminExists();
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
}).catch(err => console.error('❌ MongoDB error:', err));

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (в конец) ==========
const requestLimits = new Map();
const CLAIM_LIMITS = new Map();

setInterval(() => {
  const now = Date.now();
  const CLEANUP_AFTER_MS = 60000;
  for (const [key, data] of requestLimits.entries()) {
    if (data.times && data.times.length > 0) {
      const oldestTime = data.times[0];
      if (now - oldestTime > CLEANUP_AFTER_MS) requestLimits.delete(key);
    } else requestLimits.delete(key);
  }
  for (const [key, data] of CLAIM_LIMITS.entries()) {
    if (now - data.lastClaim > CLEANUP_AFTER_MS) CLAIM_LIMITS.delete(key);
  }
}, 30000);

function checkRateLimit(userId, action, limitMs = 1000, maxRequests = 5) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const userData = requestLimits.get(key);
  if (userData) {
    const recentRequests = userData.times.filter(t => now - t < limitMs);
    userData.times = recentRequests;
    if (recentRequests.length >= maxRequests) return false;
    userData.times.push(now);
  } else {
    requestLimits.set(key, { times: [now] });
  }
  return true;
}

function checkClaimRateLimit(userId) {
  const key = `claim:${userId}`;
  const now = Date.now();
  const userData = CLAIM_LIMITS.get(key);
  if (userData && (now - userData.lastClaim) < 30000) return false;
  CLAIM_LIMITS.set(key, { lastClaim: now });
  return true;
}
