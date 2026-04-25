const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ========== Настройки ==========
app.set('view engine', 'ejs');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false
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
  status: { type: String, default: 'pending' },
  type: { type: String, default: 'deposit' },
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  processedBy: String
});

const adminSchema = new mongoose.Schema({
  username: String,
  passwordHash: String
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Admin = mongoose.model('Admin', adminSchema);

// ========== Корневой маршрут (убирает Cannot GET /) ==========
app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'CryptoGPU Backend is running',
    endpoints: {
      api: '/api/tg',
      admin: '/admin/login'
    }
  });
});

// ========== API для игры ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name, referrer_id, amount, ton, gpu, friends, ton_earned, state } = req.body;
  
  try {
    // 1. РЕГИСТРАЦИЯ
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
          state: user.gameState || {}
        }
      });
    }
    
    // 2. СОХРАНЕНИЕ ПРОГРЕССА
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
    
    // 3. ПОЛУЧЕНИЕ РЕФЕРАЛОВ
    if (action === 'getReferrals') {
      const user = await User.findOne({ userId: user_id });
      const referrals = (user?.invitedFriends || []).map(f => ({
        friend_name: f.friendName,
        date: f.date
      }));
      return res.json({ success: true, referrals });
    }
    
    // 4. СОЗДАНИЕ ЗАЯВКИ НА ПОПОЛНЕНИЕ
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
        deposit: { 
          amount: amount, 
          wallet: process.env.TON_WALLET || "EQD...", 
          comment: comment 
        }
      });
    }
    
    return res.status(400).json({ success: false, error: 'Unknown action' });
    
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ========== Админ-панель ==========
app.get('/admin/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Admin Login</title><style>
      body { background: #0B0E1A; color: white; font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; }
      .card { background: #1A1F35; padding: 30px; border-radius: 20px; width: 300px; }
      input { width: 100%; padding: 10px; margin: 10px 0; background: #0B0E1A; border: 1px solid #00D4FF; color: white; border-radius: 8px; }
      button { background: #00D4FF; color: #0B0E1A; padding: 10px; border: none; border-radius: 8px; width: 100%; cursor: pointer; }
    </style></head>
    <body>
    <div class="card">
      <h2>🔐 Admin Login</h2>
      <form method="POST" action="/admin/login">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
      </form>
    </div>
    </body>
    </html>
  `);
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.adminId = 'admin';
    res.redirect('/admin/dashboard');
  } else {
    res.send('<h3>Invalid credentials</h3><a href="/admin/login">Try again</a>');
  }
});

app.get('/admin/dashboard', async (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  
  const deposits = await Deposit.find({ status: 'pending' }).sort('-createdAt');
  const users = await User.countDocuments();
  const totalTon = await User.aggregate([{ $group: { _id: null, total: { $sum: '$ton' } } }]);
  
  let html = `<!DOCTYPE html>
  <html>
  <head><title>Admin Dashboard</title><style>
    body { background: #0B0E1A; color: white; font-family: system-ui; padding: 20px; }
    .card { background: #1A1F35; border-radius: 20px; padding: 20px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #333; }
    button { background: #00A86B; border: none; padding: 5px 15px; border-radius: 20px; color: white; cursor: pointer; }
    .reject { background: #DC2626; }
    .stats { display: flex; gap: 20px; margin-bottom: 20px; }
    .stat { background: linear-gradient(135deg, #1A2A5E, #0F1A3A); padding: 15px; border-radius: 15px; flex: 1; text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; color: #00D4FF; }
  </style></head>
  <body>
  <h1>⚡ CryptoGPU Admin</h1>
  <a href="/admin/logout" style="color:#FF8C00;">Logout</a>
  
  <div class="stats">
    <div class="stat">👥 Users<br><span class="stat-value">${users}</span></div>
    <div class="stat">💰 Total TON<br><span class="stat-value">${(totalTon[0]?.total || 0).toFixed(2)}</span></div>
    <div class="stat">⏳ Pending<br><span class="stat-value">${deposits.length}</span></div>
  </div>
  
  <div class="card">
    <h2>💎 Pending Deposits</h2>`;
    
  if (deposits.length === 0) {
    html += '<p>No pending deposits</p>';
  } else {
    html += `<table><tr><th>User</th><th>Amount</th><th>Wallet</th><th>Comment</th><th>Action</th></tr>`;
    for (const d of deposits) {
      html += `<tr>
        <td>${d.userName} (${d.userId})</td>
        <td>${d.amount} TON</td>
        <td>${d.wallet}</td>
        <td>${d.comment}</td>
        <td>
          <form method="POST" action="/admin/approve" style="display:inline;">
            <input type="hidden" name="id" value="${d._id}">
            <button type="submit">✅ Approve</button>
          </form>
          <form method="POST" action="/admin/reject" style="display:inline;">
            <input type="hidden" name="id" value="${d._id}">
            <button type="submit" class="reject">❌ Reject</button>
          </form>
        </td>
      </tr>`;
    }
    html += `</table>`;
  }
  
  html += `</div></body></html>`;
  res.send(html);
});

app.post('/admin/approve', async (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  const deposit = await Deposit.findById(req.body.id);
  if (deposit) {
    const user = await User.findOne({ userId: deposit.userId });
    if (user) {
      user.ton += deposit.amount;
      await user.save();
    }
    deposit.status = 'completed';
    deposit.processedAt = new Date();
    await deposit.save();
  }
  res.redirect('/admin/dashboard');
});

app.post('/admin/reject', async (req, res) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  await Deposit.findByIdAndUpdate(req.body.id, { status: 'cancelled' });
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ========== Запуск сервера ==========
const PORT = process.env.PORT || 3000;

mongoose.connect(process.env.MONGODB_URL)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🔐 Admin panel: https://your-domain.up.railway.app/admin/login`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB error:', err.message);
    process.exit(1);
  });
