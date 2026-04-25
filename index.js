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
      return res.status(403).json({ 
        success: false, 
        error: 'BANNED', 
        message: `Ваш аккаунт заблокирован. Причина: ${bannedUser.banReason || 'Нарушение правил'}`
      });
    }
    
    // ========== РЕГИСТРАЦИЯ ==========
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
      
      // Получаем историю транзакций пользователя
      const transactions = await Deposit.find({ userId: user_id }).sort({ createdAt: -1 }).limit(50);
      
      return res.json({
        success: true,
        data: {
          ton: user.ton,
          gpu: user.gpu,
          friends: user.friends,
          isBanned: user.isBanned,
          state: user.gameState || {},
          transactions: transactions.map(t => ({
            id: t._id,
            amount: t.amount,
            type: t.type,
            status: t.status,
            createdAt: t.createdAt
          }))
        }
      });
    }
    
    // ========== СОХРАНЕНИЕ ==========
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
    
    // ========== РЕФЕРАЛЫ ==========
    if (action === 'getReferrals') {
      const user = await User.findOne({ userId: user_id });
      const referrals = (user?.invitedFriends || []).map(f => ({
        friend_name: f.friendName,
        date: f.date
      }));
      return res.json({ success: true, referrals });
    }
    
    // ========== СОЗДАНИЕ ЗАЯВКИ НА ПОПОЛНЕНИЕ ==========
    if (action === 'createDeposit') {
      // Проверяем количество ожидающих заявок (не больше 2)
      const pendingCount = await Deposit.countDocuments({ 
        userId: user_id, 
        status: 'pending',
        type: 'deposit'
      });
      
      if (pendingCount >= 2) {
        return res.status(400).json({ 
          success: false, 
          error: 'LIMIT_EXCEEDED',
          pendingCount: pendingCount,
          message: 'У вас уже есть 2 ожидающие заявки на пополнение. Дождитесь их обработки.' 
        });
      }
      
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
        deposit: { amount: amount, wallet: process.env.TON_WALLET, comment: comment },
        pendingCount: pendingCount + 1
      });
    }
    
    // ========== СОЗДАНИЕ ЗАЯВКИ НА ВЫВОД ==========
    if (action === 'createWithdraw') {
      if (!amount || amount <= 0 || !tonWallet) {
        return res.status(400).json({ success: false, error: 'Invalid withdraw data' });
      }
      
      // Проверяем количество ожидающих заявок (не больше 2)
      const pendingCount = await Deposit.countDocuments({ 
        userId: user_id, 
        status: 'pending',
        type: 'withdraw'
      });
      
      if (pendingCount >= 2) {
        return res.status(400).json({ 
          success: false, 
          error: 'LIMIT_EXCEEDED',
          pendingCount: pendingCount,
          message: 'У вас уже есть 2 ожидающие заявки на вывод. Дождитесь их обработки.' 
        });
      }
      
      const user = await User.findOne({ userId: user_id });
      if (!user || user.ton < amount) {
        return res.status(400).json({ success: false, error: 'Insufficient balance' });
      }
      
      // СРАЗУ БЛОКИРУЕМ БАЛАНС (списываем)
      user.ton -= amount;
      await user.save();
      
      const comment = `WITHDRAW_${user_id}_${Date.now()}`;
      const withdrawRequest = new Deposit({
        userId: user_id,
        userName: name,
        amount: amount,
        wallet: tonWallet,
        comment: comment,
        type: 'withdraw',
        status: 'pending'
      });
      await withdrawRequest.save();
      
      return res.json({
        success: true,
        message: 'Withdraw request created, waiting for admin approval',
        pendingCount: pendingCount + 1
      });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== АДМИН-ПАНЕЛЬ (сокращённо, так как она у вас уже есть) ==========
// ... (здесь весь ваш код админ-панели, который был ранее)
// Я оставляю его без изменений, просто добавьте его сюда

// Обработка заявок (подтверждение/отклонение)
app.post('/admin/approve', requireAuth, async (req, res) => {
  const { id, type } = req.body;
  const transaction = await Deposit.findById(id);
  if (!transaction || transaction.status !== 'pending') {
    return res.redirect('/admin?error=Invalid transaction');
  }
  
  const user = await User.findOne({ userId: transaction.userId });
  if (!user) return res.redirect('/admin?error=User not found');
  
  if (type === 'deposit') {
    // При пополнении: добавляем средства (не блокировались ранее)
    user.ton += transaction.amount;
    user.totalDeposited += transaction.amount;
    transaction.status = 'completed';
  } else if (type === 'withdraw') {
    // При выводе: средства уже списаны при создании заявки
    // Проверяем только лимиты и отмечаем как выполненный
    if (user.totalWithdrawn !== undefined) {
      user.totalWithdrawn += transaction.amount;
    }
    transaction.status = 'completed';
  }
  
  transaction.processedAt = new Date();
  transaction.processedBy = req.admin.username;
  await user.save();
  await transaction.save();
  
  res.redirect('/admin');
});

app.post('/admin/reject', requireAuth, async (req, res) => {
  const { id } = req.body;
  const transaction = await Deposit.findById(id);
  if (!transaction) return res.redirect('/admin?error=Transaction not found');
  
  if (transaction.type === 'withdraw' && transaction.status === 'pending') {
    // Возвращаем средства при отклонении вывода
    const user = await User.findOne({ userId: transaction.userId });
    if (user) {
      user.ton += transaction.amount;
      await user.save();
    }
  }
  
  transaction.status = 'cancelled';
  transaction.processedBy = req.admin.username;
  await transaction.save();
  
  res.redirect('/admin');
});

// ========== ЗАПУСК ==========
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
