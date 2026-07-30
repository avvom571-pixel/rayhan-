// ============================================================
// Raihan Shashlyk — сервер платформы управления кафе
// Express + SQLite (better-sqlite3) + JWT auth + Socket.IO (live sync)
// ============================================================
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const http = require('http');
const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db', 'cafe.sqlite');

// ---------------------------------------------------------------
// DB INIT
// ---------------------------------------------------------------
fs.mkdirSync(path.join(__dirname, 'db'), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'cashier', -- admin | manager | cashier
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  item_key TEXT PRIMARY KEY,
  item_name TEXT NOT NULL,
  sell_price REAL NOT NULL,
  meat_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  items_json TEXT NOT NULL,   -- {kus:1,bar:2,keb:0,kur:3}
  total REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Seed default prices if empty
const priceCount = db.prepare('SELECT COUNT(*) c FROM prices').get().c;
if (priceCount === 0) {
  const insert = db.prepare('INSERT INTO prices (item_key,item_name,sell_price,meat_price) VALUES (?,?,?,?)');
  insert.run('kus', 'Кусковой', 120, 700);
  insert.run('bar', 'Баранина', 140, 750);
  insert.run('keb', 'Кебаб', 80, 600);
  insert.run('kur', 'Куриный', 110, 250);
}

// Seed default admin user if no users exist
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const defaultPassword = process.env.ADMIN_PASSWORD || '12345678';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,?)')
    .run('Саидислом', hash, 'Саидислом', 'admin');
  console.log('==============================================');
  console.log('Создан администратор по умолчанию:');
  console.log('  Логин: Саидислом');
  console.log('  Пароль: ' + defaultPassword);
  console.log('  ВАЖНО: смените пароль после первого входа!');
  console.log('==============================================');
}

// Recipes are static reference data (kept on server so it's centrally managed)
const RECIPES = {
  kus: { name: 'Кусковой', icon: 'fa-drumstick-bite', color: '#e94560',
    ingredients: [
      { name: 'Говядина', value: '1 кг' }, { name: 'Соль', value: '16 г' },
      { name: 'Каменная соль', value: '5 г' }, { name: 'Перец', value: '2 г' },
      { name: 'Чеснок', value: '2 г' }, { name: 'Приправа', value: '2 г' },
      { name: 'Крахмал', value: '1 ст.л.' }, { name: 'Вода', value: '300 г' },
      { name: 'Лук', value: '100 г' }, { name: 'Красный уксус', value: '0.5 ст.' },
      { name: 'Кашнуч', value: '2 г' }, { name: 'Паприка', value: '1 ст.л.' },
      { name: 'Йогурт', value: '20 г' }, { name: 'Сода', value: '0.2 г' }
    ]},
  bar: { name: 'Баранина', icon: 'fa-drumstick-bite', color: '#ffc107',
    ingredients: [
      { name: 'Баранина', value: '1 кг' }, { name: 'Соль', value: '16 г' },
      { name: 'Каменная соль', value: '5 г' }, { name: 'Перец', value: '2 г' },
      { name: 'Чеснок', value: '2 г' }, { name: 'Приправа', value: '2 г' },
      { name: 'Крахмал', value: '1 ст.л.' }, { name: 'Вода', value: '220 г' },
      { name: 'Лук', value: '100 г' }, { name: 'Красный уксус', value: '0.5 ст.' },
      { name: 'Кашнуч', value: '2 г' }, { name: 'Паприка', value: '0.6 ст.л.' },
      { name: 'Помидор', value: '0.5 шт' }, { name: 'Йогурт', value: '20 г' },
      { name: 'Сода', value: '0.2 г' }
    ]},
  keb: { name: 'Кебаб', icon: 'fa-drumstick-bite', color: '#00d2ff',
    ingredients: [
      { name: 'Быкын', value: '1 кг' }, { name: 'Чёрный йогурт', value: '150 г' },
      { name: 'Хлеб (нон)', value: '150 г' }, { name: 'Соль', value: '16 г' },
      { name: 'Каменная соль', value: '5 г' }, { name: 'Перец', value: '2 г' },
      { name: 'Чеснок', value: '14 г' }, { name: 'Кашнуч', value: '8 г' },
      { name: 'Зира', value: '4 г' }, { name: 'Лук', value: '100 г' },
      { name: 'Картошка', value: '50 г' }, { name: 'Паприка', value: '1 ст.л.' }
    ]},
  kur: { name: 'Куриный', icon: 'fa-drumstick-bite', color: '#00d9a5',
    ingredients: [
      { name: 'Куриное мясо', value: '1 кг' }, { name: 'Соль', value: '15 г' },
      { name: 'Каменная соль', value: '4 г' }, { name: 'Майонез', value: '1 ст.л.' },
      { name: 'Томат', value: '1 ст.' }, { name: 'Приправа', value: '0.5 шт' },
      { name: 'Кашнуч', value: '2 г' }, { name: 'Перец', value: '2 г' },
      { name: 'Чеснок', value: '10 г' }, { name: 'Размарин', value: '2 г' },
      { name: 'Вода', value: '100 г' }, { name: 'Лавровый лист', value: '2 шт' },
      { name: 'Соевый соус', value: '2 г' }
    ]}
};

function calcCost(key, meatPrice) {
  // Same cost formulas as the original client-side logic, now centralized on the server
  if (key === 'kus') {
    const trew = (meatPrice / 1000) * (1000 / 12);
    const piezTrew = (30 / 1000) * (100 / 12);
    return trew + piezTrew + 3 + 2 + 1.2;
  }
  if (key === 'bar') {
    const trew = (meatPrice / 1000) * (1000 / 12);
    const piezTrew = (30 / 1000) * (100 / 12);
    return trew + piezTrew + 4 + 5 + 1.2;
  }
  if (key === 'keb') {
    const trew = (meatPrice / 1000) * (1000 / 17);
    const yogTrew = (100 / 1000) * (120 / 17);
    const piezTrew = (30 / 1000) * (100 / 17);
    const kartTrew = (30 / 1000) * (50 / 17);
    return trew + yogTrew + piezTrew + kartTrew + 1;
  }
  if (key === 'kur') {
    const trew = (meatPrice / 1000) * (1000 / 5);
    return trew + 5;
  }
  return 0;
}

// ---------------------------------------------------------------
// APP INIT
// ---------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function logAction(userId, username, action, details) {
  db.prepare('INSERT INTO audit_log (user_id,username,action,details) VALUES (?,?,?,?)')
    .run(userId, username, action, details ? JSON.stringify(details) : null);
}

// ---------------------------------------------------------------
// AUTH MIDDLEWARE
// ---------------------------------------------------------------
function auth(requiredRole) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      if (requiredRole === 'admin' && payload.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав' });
      }
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Сессия истекла, войдите снова' });
    }
  };
}

// Simple brute-force throttle for login
const loginAttempts = new Map(); // ip -> {count, resetAt}
function loginLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (rec && rec.count >= 8 && now < rec.resetAt) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Попробуйте через минуту.' });
  }
  next();
}
function registerFailedAttempt(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60000; }
  rec.count++;
  loginAttempts.set(ip, rec);
}

// ---------------------------------------------------------------
// ROUTES: AUTH
// ---------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    registerFailedAttempt(req.ip);
    logAction(null, username, 'login_failed', null);
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  logAction(user.id, user.username, 'login_success', null);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
});

app.get('/api/auth/me', auth(), (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', auth(), (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Текущий пароль неверен' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  logAction(user.id, user.username, 'password_changed', null);
  res.json({ ok: true });
});

// Admin: manage staff users
app.get('/api/users', auth('admin'), (req, res) => {
  const users = db.prepare('SELECT id, username, full_name, role, created_at FROM users').all();
  res.json(users);
});

app.post('/api/users', auth('admin'), (req, res) => {
  const { username, password, full_name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Такой пользователь уже существует' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,?)')
    .run(username, hash, full_name || username, role || 'cashier');
  logAction(req.user.id, req.user.username, 'user_created', { newUser: username });
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/users/:id', auth('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  logAction(req.user.id, req.user.username, 'user_deleted', { id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// ROUTES: PRICES
// ---------------------------------------------------------------
app.get('/api/prices', auth(), (req, res) => {
  const rows = db.prepare('SELECT * FROM prices').all();
  res.json(rows);
});

app.put('/api/prices/:key', auth(), (req, res) => {
  const key = req.params.key;
  const { sell_price, meat_price } = req.body || {};
  const row = db.prepare('SELECT * FROM prices WHERE item_key = ?').get(key);
  if (!row) return res.status(404).json({ error: 'Позиция не найдена' });
  const newSell = sell_price != null ? Number(sell_price) : row.sell_price;
  const newMeat = meat_price != null ? Number(meat_price) : row.meat_price;
  if (newSell <= 0 || newMeat <= 0) return res.status(400).json({ error: 'Цена должна быть больше нуля' });
  db.prepare('UPDATE prices SET sell_price = ?, meat_price = ? WHERE item_key = ?').run(newSell, newMeat, key);
  logAction(req.user.id, req.user.username, 'price_updated', { key, newSell, newMeat });
  io.emit('prices_updated');
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// ROUTES: RECIPES (static, centrally managed)
// ---------------------------------------------------------------
app.get('/api/recipes', auth(), (req, res) => {
  res.json(RECIPES);
});

// ---------------------------------------------------------------
// ROUTES: SALES
// ---------------------------------------------------------------
app.post('/api/sales', auth(), (req, res) => {
  const { items } = req.body || {}; // {kus,bar,keb,kur}
  if (!items) return res.status(400).json({ error: 'Нет данных о продаже' });
  const prices = db.prepare('SELECT * FROM prices').all();
  const priceMap = {};
  prices.forEach(p => priceMap[p.item_key] = p);

  let total = 0, cost = 0;
  for (const key of Object.keys(items)) {
    const qty = Number(items[key]) || 0;
    const p = priceMap[key];
    if (!p || qty <= 0) continue;
    total += qty * p.sell_price;
    cost += qty * calcCost(key, p.meat_price);
  }
  if (total <= 0) return res.status(400).json({ error: 'Введите количество хотя бы одной позиции' });

  const info = db.prepare(
    'INSERT INTO sales (user_id, username, items_json, total, cost, profit) VALUES (?,?,?,?,?,?)'
  ).run(req.user.id, req.user.username, JSON.stringify(items), total, cost, total - cost);

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(info.lastInsertRowid);
  logAction(req.user.id, req.user.username, 'sale_created', { id: sale.id, total });

  io.emit('sale_created', sale); // live push to all connected clients/devices
  res.json(sale);
});

app.get('/api/sales', auth(), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.delete('/api/sales', auth('admin'), (req, res) => {
  db.prepare('DELETE FROM sales').run();
  logAction(req.user.id, req.user.username, 'history_cleared', null);
  io.emit('history_cleared');
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// ROUTES: DASHBOARD
// ---------------------------------------------------------------
app.get('/api/dashboard', auth(), (req, res) => {
  const todayRow = db.prepare(`
    SELECT
      COALESCE(SUM(total), 0) as revenue,
      COALESCE(SUM(profit), 0) as profit,
      COALESCE(SUM(cost), 0) as expense,
      COUNT(*) as orders
    FROM sales
    WHERE date(created_at) = date('now')
  `).get();

  const yesterdayRow = db.prepare(`
    SELECT COALESCE(SUM(total),0) as revenue, COALESCE(SUM(profit),0) as profit
    FROM sales WHERE date(created_at) = date('now','-1 day')
  `).get();

  const recent = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 5').all();

  // last 7 days revenue for chart
  const last7 = db.prepare(`
    SELECT date(created_at) as day, COALESCE(SUM(total),0) as revenue
    FROM sales
    WHERE created_at >= date('now','-6 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  res.json({ today: todayRow, yesterday: yesterdayRow, recent, last7 });
});

app.get('/api/export', auth(), (req, res) => {
  const sales = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 500').all();
  const prices = db.prepare('SELECT * FROM prices').all();
  res.json({ exportDate: new Date().toISOString(), sales, prices });
});

// ---------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------
// SOCKET.IO — требует валидный токен для подключения
// ---------------------------------------------------------------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

server.listen(PORT, () => {
  console.log(`Raihan Shashlyk server запущен на http://localhost:${PORT}`);
});
