'use strict';
/**
 * SQLite database layer (built-in node:sqlite — zero dependencies).
 * Schema is versioned via PRAGMA user_version for future migrations.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.POS_DB_PATH || path.join(__dirname, 'pos.db');

const SEED_PRODUCTS = [
  { name: 'Organic Bananas', category: 'Produce', price: 0.69, unit: 'kg', stock: 120, barcode: '100001', emoji: '🍌' },
  { name: 'Red Apples', category: 'Produce', price: 2.49, unit: 'kg', stock: 85, barcode: '100002', emoji: '🍎' },
  { name: 'Tomatoes', category: 'Produce', price: 1.99, unit: 'kg', stock: 60, barcode: '100003', emoji: '🍅' },
  { name: 'Lettuce', category: 'Produce', price: 1.49, unit: 'each', stock: 40, barcode: '100004', emoji: '🥬' },
  { name: 'Carrots', category: 'Produce', price: 1.29, unit: 'kg', stock: 75, barcode: '100005', emoji: '🥕' },
  { name: 'Broccoli', category: 'Produce', price: 2.19, unit: 'each', stock: 35, barcode: '100006', emoji: '🥦' },
  { name: 'Whole Milk 1L', category: 'Dairy & Eggs', price: 1.89, unit: 'each', stock: 90, barcode: '200001', emoji: '🥛' },
  { name: 'Cheddar Cheese', category: 'Dairy & Eggs', price: 4.99, unit: 'each', stock: 45, barcode: '200002', emoji: '🧀' },
  { name: 'Eggs (12 pack)', category: 'Dairy & Eggs', price: 3.49, unit: 'each', stock: 70, barcode: '200003', emoji: '🥚' },
  { name: 'Greek Yogurt', category: 'Dairy & Eggs', price: 2.79, unit: 'each', stock: 55, barcode: '200004', emoji: '🍦' },
  { name: 'Butter 250g', category: 'Dairy & Eggs', price: 2.99, unit: 'each', stock: 50, barcode: '200005', emoji: '🧈' },
  { name: 'White Bread', category: 'Bakery', price: 1.79, unit: 'each', stock: 65, barcode: '300001', emoji: '🍞' },
  { name: 'Croissants (4 pack)', category: 'Bakery', price: 3.99, unit: 'each', stock: 30, barcode: '300002', emoji: '🥐' },
  { name: 'Chocolate Cake', category: 'Bakery', price: 8.99, unit: 'each', stock: 15, barcode: '300003', emoji: '🍰' },
  { name: 'Baguettes', category: 'Bakery', price: 1.29, unit: 'each', stock: 40, barcode: '300004', emoji: '🥖' },
  { name: 'Chicken Breast', category: 'Meat & Seafood', price: 9.99, unit: 'kg', stock: 40, barcode: '400001', emoji: '🍗' },
  { name: 'Ground Beef', category: 'Meat & Seafood', price: 11.49, unit: 'kg', stock: 35, barcode: '400002', emoji: '🥩' },
  { name: 'Salmon Fillet', category: 'Meat & Seafood', price: 14.99, unit: 'kg', stock: 20, barcode: '400003', emoji: '🐟' },
  { name: 'Pasta 500g', category: 'Pantry', price: 1.49, unit: 'each', stock: 110, barcode: '500001', emoji: '🍝' },
  { name: 'Rice 1kg', category: 'Pantry', price: 2.29, unit: 'each', stock: 95, barcode: '500002', emoji: '🍚' },
  { name: 'Olive Oil 750ml', category: 'Pantry', price: 6.99, unit: 'each', stock: 40, barcode: '500003', emoji: '🫒' },
  { name: 'Canned Tomatoes', category: 'Pantry', price: 1.19, unit: 'each', stock: 80, barcode: '500004', emoji: '🥫' },
  { name: 'Orange Juice 1L', category: 'Beverages', price: 2.99, unit: 'each', stock: 60, barcode: '600001', emoji: '🧃' },
  { name: 'Cola 1.5L', category: 'Beverages', price: 1.99, unit: 'each', stock: 100, barcode: '600002', emoji: '🥤' },
  { name: 'Coffee Beans 500g', category: 'Beverages', price: 7.49, unit: 'each', stock: 35, barcode: '600003', emoji: '☕' },
  { name: 'Green Tea (20 bags)', category: 'Beverages', price: 3.29, unit: 'each', stock: 45, barcode: '600004', emoji: '🍵' },
  { name: 'Frozen Pizza', category: 'Frozen', price: 4.49, unit: 'each', stock: 50, barcode: '700001', emoji: '🍕' },
  { name: 'Ice Cream 1L', category: 'Frozen', price: 3.99, unit: 'each', stock: 45, barcode: '700002', emoji: '🍨' },
  { name: 'Frozen Peas 500g', category: 'Frozen', price: 1.79, unit: 'each', stock: 70, barcode: '700003', emoji: '🫛' },
  { name: 'Potato Chips', category: 'Snacks', price: 1.99, unit: 'each', stock: 85, barcode: '800001', emoji: '🍟' },
  { name: 'Chocolate Bar', category: 'Snacks', price: 1.49, unit: 'each', stock: 90, barcode: '800002', emoji: '🍫' },
  { name: 'Cookies (300g)', category: 'Snacks', price: 2.49, unit: 'each', stock: 60, barcode: '800003', emoji: '🍪' },
  { name: 'Mixed Nuts 200g', category: 'Snacks', price: 4.99, unit: 'each', stock: 40, barcode: '800004', emoji: '🥜' },
];

const DEFAULT_SETTINGS = {
  store_name: 'FreshMart',
  tax_rate: '0.08',
  currency: '$',
  currency_code: 'USD',
  low_stock_threshold: '10',
  register_name: 'Register 1',
  points_per_dollar: '1',
  points_value: '0.01', // $ value of 1 point when redeeming
};

function openDb(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      name TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      price REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'each',
      stock INTEGER NOT NULL DEFAULT 0,
      barcode TEXT UNIQUE,
      emoji TEXT NOT NULL DEFAULT '📦',
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT NOT NULL DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_id INTEGER REFERENCES users(id),
      register TEXT NOT NULL DEFAULT 'Register 1',
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL,
      closing_amount REAL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL DEFAULT (datetime('now')),
      cashier_id INTEGER REFERENCES users(id),
      register TEXT NOT NULL DEFAULT 'Register 1',
      shift_id INTEGER REFERENCES shifts(id),
      subtotal REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL,
      total REAL NOT NULL,
      payment TEXT NOT NULL DEFAULT 'cash',
      tendered REAL,
      change REAL,
      status TEXT NOT NULL DEFAULT 'completed',
      customer_id INTEGER REFERENCES customers(id),
      points_earned INTEGER NOT NULL DEFAULT 0,
      points_redeemed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '📦',
      price REAL NOT NULL,
      qty INTEGER NOT NULL,
      line_total REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
    CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
  `);
    db.prepare('PRAGMA user_version = 1').run();
    version = 1;
  }
  if (version < 2) {
    db.exec(`
      ALTER TABLE products ADD COLUMN tax_rate REAL;
      ALTER TABLE sales ADD COLUMN payment_intent_id TEXT;
      ALTER TABLE sales ADD COLUMN stripe_refund_id TEXT;
      ALTER TABLE sales ADD COLUMN idempotency_key TEXT;
      ALTER TABLE sale_items ADD COLUMN tax_rate REAL;
      ALTER TABLE sale_items ADD COLUMN tax REAL;
      CREATE UNIQUE INDEX idx_sales_idempotency ON sales(idempotency_key);
    `);
    db.prepare('PRAGMA user_version = 2').run();
    version = 2;
  }
  if (version < 3) {
    db.exec(`
      ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET must_change_password = 1 WHERE username = 'admin';
    `);
    db.prepare('PRAGMA user_version = 3').run();
  }
}

function seed(db, hashPassword) {
  // Settings
  const upsertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) upsertSetting.run(k, v);

  // Admin user (created once)
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    db.prepare('INSERT INTO users(username, password_hash, role, name, must_change_password) VALUES(?, ?, ?, ?, 1)')
      .run('admin', hashPassword('admin123'), 'admin', 'Store Manager');
  }

  // Products (only if empty)
  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO products(name, category, price, unit, stock, barcode, emoji) VALUES(?, ?, ?, ?, ?, ?, ?)');
    for (const p of SEED_PRODUCTS) ins.run(p.name, p.category, p.price, p.unit, p.stock, p.barcode, p.emoji);
  }
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSettings(db, obj) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v));
}

module.exports = { openDb, seed, getSettings, setSettings, SEED_PRODUCTS, DEFAULT_SETTINGS };
