const fs = require("fs");
const path = require("path");
const config = require("../config");

const DB_PATH = path.join(__dirname, "..", "database", "db.json");

function defaultDB() {
  return {
    packages: config.packages,
    stock: {},
    orders: {},
    users: {},
    saldo: {},
    vouchers: {},
    referrals: {},
    settings: { paymentMode: "auto" },
    stats: { totalOrders: 0, totalRevenue: 0 }
  };
}

function loadDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const d = defaultDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2));
    return d;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function getSaldo(db, userId) {
  return Number(db.saldo[String(userId)] || 0);
}

function addSaldo(db, userId, amount) {
  const k = String(userId);
  db.saldo[k] = getSaldo(db, userId) + Number(amount);
  return db.saldo[k];
}

function cutSaldo(db, userId, amount) {
  const cur = getSaldo(db, userId);
  if (cur < amount) return false;
  db.saldo[String(userId)] = cur - amount;
  return true;
}

module.exports = { loadDB, saveDB, getSaldo, addSaldo, cutSaldo, DB_PATH };
