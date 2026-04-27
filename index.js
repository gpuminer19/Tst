const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ========== СХЕМА ПОЛЬЗОВАТЕЛЯ ==========
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: String,
  ton: { type: Number, default: 0 },
  gpu: { type: Number, default: 15 },
  lastMiningUpdate: { type: Date, default: Date.now },
  accumulatedTon: { type: Number, default: 0 }, // <-- ОТДЕЛЬНОЕ ПОЛЕ
  accumulatedGpu: { type: Number, default: 0 },  // <-- ОТДЕЛЬНОЕ ПОЛЕ
  minerQuantities: { type: Object, default: { basic: 1 } }
});

const User = mongoose.model('User', userSchema);

// ========== РЕЙТЫ МАЙНЕРОВ (В ЧАС) ==========
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

// ========== ФУНКЦИЯ РАСЧЁТА ОФЛАЙН-НАКОПЛЕНИЙ ==========
async function calculateOffline(userId) {
  const user = await User.findOne({ userId });
  if (!user) return;

  const now = Date.now();
  const lastUpdate = user.lastMiningUpdate || now;
  const hoursPassed = (now - lastUpdate) / (1000 * 3600);

  // Если прошло меньше минуты или больше 30 дней — не считаем
  if (hoursPassed < 0.0001 || hoursPassed > 720) {
    user.lastMiningUpdate = now;
    await user.save();
    return;
  }

  let earnedTon = 0;
  let earnedGpu = 0;

  // Считаем доход за всё время отсутствия
  for (const [minerId, qty] of Object.entries(user.minerQuantities)) {
    const rate = RATES[minerId];
    if (rate && qty > 0) {
      earnedTon += rate.ton * qty * hoursPassed;
      earnedGpu += rate.gpu * qty * hoursPassed;
    }
  }

  if (earnedTon > 0 || earnedGpu > 0) {
    user.accumulatedTon += earnedTon;
    user.accumulatedGpu += earnedGpu;
    console.log(`📊 ${userId}: +${earnedTon.toFixed(8)} TON, +${earnedGpu.toFixed(6)} GPU за ${hoursPassed.toFixed(4)}ч`);
  }

  user.lastMiningUpdate = now;
  await user.save();
  
  console.log(`✅ ${userId}: накопления TON=${user.accumulatedTon.toFixed(8)}, GPU=${user.accumulatedGpu.toFixed(6)}`);
}

// ========== API ==========
app.post('/api/tg', async (req, res) => {
  const { action, user_id, name } = req.body;

  // РЕГИСТРАЦИЯ (ВХОД)
  if (action === 'register') {
    let user = await User.findOne({ userId: user_id });
    
    if (!user) {
      // Новый пользователь
      user = new User({ userId: user_id, name: name || 'Игрок' });
      await user.save();
      console.log(`🆕 Новый пользователь: ${user_id}`);
    } else {
      // Существующий — считаем офлайн-накопления
      console.log(`👤 Вход пользователя: ${user_id}`);
      await calculateOffline(user_id);
      user = await User.findOne({ userId: user_id });
    }

    // Отправляем клиенту ВСЕ данные
    return res.json({
      success: true,
      data: {
        ton: user.ton,
        gpu: user.gpu,
        accumulatedTon: user.accumulatedTon,
        accumulatedGpu: user.accumulatedGpu,
        minerQuantities: user.minerQuantities
      }
    });
  }

  // СОХРАНЕНИЕ (когда игрок собирает награду или покупает майнер)
  if (action === 'save') {
    const { ton, gpu, accumulatedTon, accumulatedGpu, minerQuantities } = req.body;
    
    await User.findOneAndUpdate(
      { userId: user_id },
      {
        ton,
        gpu,
        accumulatedTon,
        accumulatedGpu,
        minerQuantities
      }
    );
    
    console.log(`💾 Сохранено для ${user_id}: TON=${ton}, GPU=${gpu}, накопления TON=${accumulatedTon}`);
    return res.json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'Unknown action' });
});

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 8080;
mongoose.connect(process.env.MONGODB_URL).then(() => {
  console.log('✅ Connected to MongoDB');
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
}).catch(err => console.error('❌ MongoDB error:', err));
