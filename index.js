const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Настройки
app.set('view engine', 'ejs');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'gpu_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // для Railway https ставим true, но нужен proxy
}));

// ========== MongoDB Schemas ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  ton: { type: Number, default: 5.0 },
  gpu: { type: Number, default: 0 },
  friends: { type: Number, default: 0 },
  referrerId: String,
  invitedFriends: [{ friendId: String, friendName: String, date: String }],
  gameState: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  lastSeen: Date
});

const depositSchema = new mongoose.Schema({
  userId: String,
  userName: String,
  amount: Number,
  wallet: String,
  comment: String,
  status: { type: String, default: 'pending' }, // pending, completed, cancelled
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
async function getUser(userId) {
  return await User.findOne({ userId });
}

async function saveUser(userId, data) {
  return await User.findOneAndUpdate(
    { userId },
    { ...data, lastSeen: new Date() },
    { upsert: true, new: true }
  );
}

function generateRandomWallet() {
  return "UQD..." + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// ========== Middleware для защиты админки ==========
async function requireAuth(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect('/admin/login');
  }
  next();
}

// ========== API для Telegram игры (те же эндпоинты) ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, ton_earned, state } = req.body;
  
  try {
    if (action === 'register') {
      let user = await getUser(user_id);
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
          const referrer = await getUser(referrer_id);
          if (referrer) {
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
          state: user.gameState || { gpuStates: [], refState: {} }
        }
      });
    }
    
    if (action === 'save') {
      const user = await saveUser(user_id, {
        ton: ton !== undefined ? ton : undefined,
        gpu: gpu !== undefined ? gpu : undefined,
        friends: friends !== undefined ? friends : undefined,
        gameState: state
      });
      
      if (ton_earned && ton_earned > 0) {
        user.ton += ton_earned;
        await user.save();
      }
      
      return res.json({ success: true });
    }
    
    if (action === 'getReferrals') {
      const user = await getUser(user_id);
      const referrals = (user?.invitedFriends || []).map(f => ({
        friend_name: f.friendName,
        date: f.date
      }));
      return res.json({ success: true, referrals });
    }
    
    if (action === 'createDeposit') {
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
      }
      
      const comment = `GPU_DEPOSIT_${user_id}_${Date.now()}`;
      const wallet = process.env.TON_WALLET || "EQD... (ваш кошелёк)";
      
      const deposit = new Deposit({
        userId: user_id,
        userName: name,
        amount: amount,
        wallet: wallet,
        comment: comment,
        type: 'deposit'
      });
      await deposit.save();
      
      return res.json({
        success: true,
        deposit: {
          amount: amount,
          wallet: wallet,
          comment: comment
        }
      });
    }
    
    // НОВО: заявка на вывод
    if (action === 'createWithdraw') {
      const { amount, tonWallet } = req.body;
      if (!amount || amount <= 0 || !tonWallet) {
        return res.status(400).json({ success: false, error: 'Invalid withdraw data' });
      }
      
      const user = await getUser(user_id);
      if (!user || user.ton < amount) {
        return res.status(400).json({ success: false, error: 'Insufficient balance' });
      }
      
      const comment = `GPU_WITHDRAW_${user_id}_${Date.now()}`;
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
      
      // Временно блокируем сумму (можно вычитать позже, при подтверждении)
      return res.json({
        success: true,
        message: 'Withdraw request created, waiting for admin approval'
      });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== АДМИН-ПАНЕЛЬ ==========

// Логин
app.get('/admin/login', (req, res) => {
  res.render('admin', { 
    view: 'login', 
    error: null,
    stats: null,
    deposits: null,
    withdraws: null
  });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  
  // Простая проверка (для первого входа создайте админа вручную или через env)
  const bcrypt = require('bcrypt');
  if (admin && await bcrypt.compare(password, admin.passwordHash)) {
    req.session.adminId = admin._id;
    req.session.username = admin.username;
    res.redirect('/admin/dashboard');
  } else if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    // fallback для первого запуска
    req.session.adminId = 'temp_admin';
    req.session.username = username;
    res.redirect('/admin/dashboard');
  } else {
    res.render('admin', { 
      view: 'login', 
      error: 'Invalid credentials',
      stats: null,
      deposits: null,
      withdraws: null
    });
  }
});

// Логаут
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// Дашборд
app.get('/admin/dashboard', requireAuth, async (req, res) => {
  const pendingDeposits = await Deposit.find({ status: 'pending', type: 'deposit' }).sort('-createdAt');
  const pendingWithdraws = await Deposit.find({ status: 'pending', type: 'withdraw' }).sort('-createdAt');
  const totalUsers = await User.countDocuments();
  const totalTon = await User.aggregate([{ $group: { _id: null, total: { $sum: '$ton' } } }]);
  
  res.render('admin', {
    view: 'dashboard',
    error: null,
    stats: {
      users: totalUsers,
      tonCirculating: totalTon[0]?.total || 0,
      pendingDeposits: pendingDeposits.length,
      pendingWithdraws: pendingWithdraws.length
    },
    deposits: pendingDeposits,
    withdraws: pendingWithdraws
  });
});

// Подтверждение заявки
app.post('/admin/approve', requireAuth, async (req, res) => {
  const { id, type } = req.body;
  try {
    const transaction = await Deposit.findById(id);
    if (!transaction || transaction.status !== 'pending') {
      return res.redirect('/admin/dashboard?error=Invalid transaction');
    }
    
    const user = await User.findOne({ userId: transaction.userId });
    if (!user) {
      return res.redirect('/admin/dashboard?error=User not found');
    }
    
    if (type === 'deposit') {
      // Пополнение: добавляем TON
      user.ton += transaction.amount;
      transaction.status = 'completed';
    } else if (type === 'withdraw') {
      // Вывод: вычитаем TON
      if (user.ton >= transaction.amount) {
        user.ton -= transaction.amount;
        transaction.status = 'completed';
      } else {
        transaction.status = 'cancelled';
        return res.redirect('/admin/dashboard?error=Insufficient user balance');
      }
    }
    
    transaction.processedAt = new Date();
    transaction.processedBy = req.session.username;
    await user.save();
    await transaction.save();
    
    // Здесь можно отправить уведомление пользователю через Telegram бота
    res.redirect('/admin/dashboard?success=Approved');
  } catch (error) {
    res.redirect(`/admin/dashboard?error=${error.message}`);
  }
});

// Отклонение заявки
app.post('/admin/reject', requireAuth, async (req, res) => {
  const { id } = req.body;
  await Deposit.findByIdAndUpdate(id, { status: 'cancelled' });
  res.redirect('/admin/dashboard?success=Rejected');
});

// ========== Запуск сервера ==========
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URL).then(async () => {
  console.log('✅ Connected to MongoDB');
  
  // Создаём админа из переменных окружения (один раз)
  const existingAdmin = await Admin.findOne({ username: process.env.ADMIN_USER });
  if (!existingAdmin && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
    await Admin.create({ username: process.env.ADMIN_USER, passwordHash: hash });
    console.log('✅ Admin user created');
  }
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Admin panel: http://localhost:${PORT}/admin/login`);
  });
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});