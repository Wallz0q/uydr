require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const config = require("./config");
const { createInvoice, checkInvoiceStatus, getBalance, toRupiah } = require("./lib/payment");
const { loadDB, saveDB, getSaldo, addSaldo, cutSaldo, DB_PATH } = require("./lib/db");

const bot = new Telegraf(process.env.BOT_TOKEN);
if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN belum diisi di .env");
  process.exit(1);
}
let db = loadDB();
const pendingInput = {};

function isOwner(id) {
  return Number(id) === Number(config.ownerId);
}
function now() {
  return moment().tz("Asia/Jakarta").format("YYYY-MM-DD HH:mm:ss");
}
function orderId(prefix = "ORD") {
  return prefix + Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendNotif(text) {
  const ids = [config.notifGroupId, config.testimoniGroupId, config.testimoniChannel].filter(Boolean);
  for (const id of [...new Set(ids)]) {
    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.log("Notif fail", id, e.message);
    }
  }
}

async function sendTestimoni(order) {
  const text =
    `✅ *TESTIMONI ORDER*\n\n` +
    `👤 ${order.name}${order.username ? " (@" + order.username + ")" : ""}\n` +
    `📦 ${order.package_name}\n` +
    `💰 ${toRupiah(order.price)}\n` +
    `🆔 \`${order.order_id}\`\n` +
    `💳 ${order.payment_method || "-"}\n` +
    `📅 ${order.completed_at || now()}\n\n` +
    `Terima kasih order di *${config.botName}*!`;
  await sendNotif(text);
}

function ensureUser(from, refCode) {
  const id = String(from.id);
  if (!db.users[id]) {
    db.users[id] = {
      id: from.id,
      username: from.username || "",
      name: `${from.first_name || ""} ${from.last_name || ""}`.trim(),
      join: now(),
      referredBy: null,
      orders: 0
    };
    if (refCode && db.referrals[refCode] && Number(db.referrals[refCode]) !== from.id) {
      db.users[id].referredBy = db.referrals[refCode];
    }
    saveDB(db);
  }
  return db.users[id];
}

function mainKeyboard(userId) {
  const rows = [
    [Markup.button.callback("🛒 Beli VPS", "beli_vps"), Markup.button.callback("💰 Saldo", "menu_saldo")],
    [Markup.button.callback("📦 Order Saya", "cek_order"), Markup.button.callback("🎟 Voucher", "menu_voucher")],
    [Markup.button.callback("🔗 Referral", "menu_referral")]
  ];
  if (isOwner(userId)) rows.push([Markup.button.callback("⚙️ Admin", "admin_menu")]);
  return Markup.inlineKeyboard(rows);
}

// ===== START (+ referral deep link) =====
bot.start(async (ctx) => {
  const payload = ctx.startPayload || "";
  ensureUser(ctx.from, payload.startsWith("ref") ? payload : null);

  const text =
    `Halo *${ctx.from.first_name}* 👋\n\n` +
    `Selamat datang di *${config.botName}*\n` +
    `NAT VPS murah • QRIS Auto + Manual • Saldo & Voucher\n\n` +
    `Saldo kamu: *${toRupiah(getSaldo(db, ctx.from.id))}*`;

  if (config.menuPhoto) {
    try {
      await ctx.replyWithPhoto(config.menuPhoto, {
        caption: text,
        parse_mode: "Markdown",
        ...mainKeyboard(ctx.from.id)
      });
      return;
    } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: "Markdown", ...mainKeyboard(ctx.from.id) });
});

bot.action("back_home", async (ctx) => {
  await ctx.answerCbQuery();
  const text =
    `*${config.botName}*\nSaldo: *${toRupiah(getSaldo(db, ctx.from.id))}*\nPilih menu:`;
  await ctx.editMessageText(text, { parse_mode: "Markdown", ...mainKeyboard(ctx.from.id) }).catch(() =>
    ctx.reply(text, { parse_mode: "Markdown", ...mainKeyboard(ctx.from.id) })
  );
});

// ===== BELI VPS =====
bot.action("beli_vps", async (ctx) => {
  await ctx.answerCbQuery();
  const rows = db.packages.map((p) => {
    const n = (db.stock[String(p.id)] || []).length;
    return [Markup.button.callback(`${p.name} • ${toRupiah(p.price)} (Stok ${n})`, `pkg_${p.id}`)];
  });
  rows.push([Markup.button.callback("🔙", "back_home")]);
  await ctx.reply("*📦 Paket NAT VPS*", { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^pkg_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const pkg = db.packages.find((p) => String(p.id) === id);
  if (!pkg) return ctx.reply("Paket tidak ada.");
  if (!(db.stock[id] || []).length) return ctx.reply(`Stok *${pkg.name}* habis.`, { parse_mode: "Markdown" });

  await ctx.reply(
    `*${pkg.name}*\nRAM ${pkg.ram} • CPU ${pkg.cpu}\n💰 *${toRupiah(pkg.price)}*\n${pkg.desc || ""}\n\nLanjut beli?`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Beli", `buy_${id}`)],
        [Markup.button.callback("🔙", "beli_vps")]
      ])
    }
  );
});

bot.action(/^buy_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  ensureUser(ctx.from);
  const pkgId = ctx.match[1];
  const pkg = db.packages.find((p) => String(p.id) === pkgId);
  if (!pkg || !(db.stock[pkgId] || []).length) return ctx.reply("Stok habis / paket invalid.");

  const oid = orderId();
  db.orders[oid] = {
    order_id: oid,
    user_id: ctx.from.id,
    username: ctx.from.username || "",
    name: ctx.from.first_name || "",
    package_id: pkgId,
    package_name: pkg.name,
    price: pkg.price,
    price_final: pkg.price,
    voucher: null,
    status: "menunggu_pembayaran",
    payment_method: null,
    invoice_id: null,
    created_at: now(),
    proof: null
  };
  saveDB(db);

  await ctx.reply(
    `Order *${oid}*\n📦 ${pkg.name}\n💰 ${toRupiah(pkg.price)}\n\nPilih pembayaran:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚡ QRIS Auto (SyahPay)", `payauto_${oid}`)],
        [Markup.button.callback("📷 QRIS Manual", `paymanual_${oid}`)],
        [Markup.button.callback("💰 Bayar Saldo", `paysaldo_${oid}`)],
        [Markup.button.callback("🎟 Pakai Voucher", `payvoucher_${oid}`)],
        [Markup.button.callback("❌ Batal", `cancel_${oid}`)]
      ])
    }
  );
  await sendNotif(`🛒 *Order Baru*\n\`${oid}\` • ${pkg.name} • ${toRupiah(pkg.price)}\n👤 ${ctx.from.first_name}`);
});

// ===== PAY AUTO =====
bot.action(/^payauto_(ORD\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Buat invoice...");
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id || order.status !== "menunggu_pembayaran")
    return ctx.reply("Order tidak valid.");

  const amount = order.price_final || order.price;
  const inv = await createInvoice(amount, oid);
  if (!inv.ok) {
    return ctx.reply(`⚠️ Gateway: ${inv.error}\nPakai QRIS Manual / Saldo.`, {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📷 Manual", `paymanual_${oid}`)],
        [Markup.button.callback("💰 Saldo", `paysaldo_${oid}`)]
      ])
    });
  }
  order.payment_method = "syahpay";
  order.invoice_id = inv.invoiceId;
  saveDB(db);

  let cap =
    `⚡ *QRIS SyahPay*\n` +
    `🆔 \`${oid}\`\n` +
    `💰 Nominal: *${toRupiah(inv.amount || amount)}*\n` +
    (inv.fee ? `➕ Fee: ${toRupiah(inv.fee)}\n` : "") +
    (inv.total ? `💳 Total bayar: *${toRupiah(inv.total)}*\n` : "") +
    (inv.expiredAt ? `⏰ Exp: ${inv.expiredAt}\n` : `⏱ ${config.orderTimeoutMinutes} menit\n`) +
    `\nScan QR di bawah. Bot cek status otomatis.`;
  if (inv.paymentLink) cap += `\n\n🔗 ${inv.paymentLink}`;
  if (inv.qrisImage) {
    try {
      await ctx.replyWithPhoto(inv.qrisImage, { caption: cap, parse_mode: "Markdown" });
    } catch {
      await ctx.reply(cap + `\n${inv.qrisImage}`, { parse_mode: "Markdown" });
    }
  } else await ctx.reply(cap, { parse_mode: "Markdown" });

  pollPayment(oid, inv.invoiceId, ctx.from.id);
});

async function pollPayment(oid, invoiceId, userId) {
  const max = Math.ceil((config.orderTimeoutMinutes * 60) / 10);
  for (let i = 0; i < max; i++) {
    await sleep(10000);
    const order = db.orders[oid];
    if (!order || order.status !== "menunggu_pembayaran") return;
    const st = await checkInvoiceStatus(invoiceId);
    if (st.paid) {
      await completeOrder(oid, "syahpay");
      try {
        await bot.telegram.sendMessage(userId, `✅ Pembayaran \`${oid}\` berhasil!`, { parse_mode: "Markdown" });
      } catch (_) {}
      return;
    }
  }
  if (db.orders[oid]?.status === "menunggu_pembayaran") {
    db.orders[oid].status = "expired";
    saveDB(db);
    try {
      await bot.telegram.sendMessage(userId, `⏱ Order \`${oid}\` expired.`, { parse_mode: "Markdown" });
    } catch (_) {}
  }
}

// ===== PAY MANUAL =====
bot.action(/^paymanual_(ORD\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id || order.status !== "menunggu_pembayaran")
    return ctx.reply("Order invalid.");
  order.payment_method = "manual";
  saveDB(db);
  const text =
    `📷 *QRIS Manual*\n🆔 \`${oid}\`\n💰 *${toRupiah(order.price_final || order.price)}*\n\n` +
    config.manualPaymentInfo.replace("ORDER_ID", oid);
  if (config.manualQrisPhoto) {
    try {
      await ctx.replyWithPhoto(config.manualQrisPhoto, { caption: text, parse_mode: "Markdown" });
      return;
    } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: "Markdown" });
});

// ===== PAY SALDO =====
bot.action(/^paysaldo_(ORD\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id || order.status !== "menunggu_pembayaran")
    return ctx.reply("Order invalid.");

  const amount = order.price_final || order.price;
  const saldo = getSaldo(db, ctx.from.id);
  if (saldo < amount) {
    return ctx.reply(`Saldo kurang.\nSaldo: ${toRupiah(saldo)}\nTotal: ${toRupiah(amount)}\nDeposit dulu di menu Saldo.`);
  }
  cutSaldo(db, ctx.from.id, amount);
  saveDB(db);
  const ok = await completeOrder(oid, "saldo");
  await ctx.reply(ok ? `✅ Dibayar pakai saldo. VPS dikirim!` : `⚠️ Paid tapi stok habis, hubungi admin.`);
});

// ===== VOUCHER on order =====
bot.action(/^payvoucher_(ORD\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id) return;
  pendingInput[ctx.from.id] = { type: "apply_voucher", orderId: oid };
  await ctx.reply("Kirim *kode voucher*:", { parse_mode: "Markdown" });
});

bot.action(/^cancel_(ORD\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  if (db.orders[oid]?.user_id === ctx.from.id) {
    db.orders[oid].status = "dibatalkan";
    saveDB(db);
  }
  await ctx.reply("Dibatalkan.");
});

// ===== PHOTO PROOF =====
bot.on("photo", async (ctx) => {
  const cap = (ctx.message.caption || "").trim();
  // deposit proof
  let m = cap.match(/^depo\s+(DEP\d+)$/i);
  if (m) {
    const oid = m[1].toUpperCase();
    const order = db.orders[oid];
    if (!order || order.user_id !== ctx.from.id) return ctx.reply("Deposit ID tidak valid.");
    if (order.status !== "menunggu_pembayaran") return ctx.reply("Status: " + order.status);
    order.proof = ctx.message.photo.at(-1).file_id;
    order.status = "menunggu_konfirmasi";
    saveDB(db);
    await ctx.reply("Bukti deposit diterima, tunggu admin.");
    try {
      await bot.telegram.sendPhoto(config.ownerId, order.proof, {
        caption: `🧾 *Deposit*\n\`${oid}\`\n👤 ${order.name}\n💰 ${toRupiah(order.price)}`,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Terima", `confirm_${oid}`), Markup.button.callback("❌", `reject_${oid}`)]
        ])
      });
    } catch (_) {}
    return;
  }

  m = cap.match(/^bayar\s+(ORD\d+)$/i);
  if (!m) return;
  const oid = m[1].toUpperCase();
  const order = db.orders[oid];
  if (!order) return ctx.reply("Order tidak ditemukan.");
  if (order.user_id !== ctx.from.id) return ctx.reply("Bukan order kamu.");
  if (order.status !== "menunggu_pembayaran") return ctx.reply("Status: " + order.status);

  order.proof = ctx.message.photo.at(-1).file_id;
  order.status = "menunggu_konfirmasi";
  order.payment_method = order.payment_method || "manual";
  saveDB(db);
  await ctx.reply(`✅ Bukti \`${oid}\` diterima.`, { parse_mode: "Markdown" });
  try {
    await bot.telegram.sendPhoto(config.ownerId, order.proof, {
      caption: `🧾 *Bukti*\n\`${oid}\`\n${order.name}\n${order.package_name}\n${toRupiah(order.price_final || order.price)}`,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅", `confirm_${oid}`), Markup.button.callback("❌", `reject_${oid}`)]
      ])
    });
  } catch (_) {}
  await sendNotif(`🧾 Bukti masuk \`${oid}\` • ${toRupiah(order.price_final || order.price)}`);
});

// ===== COMPLETE =====
async function completeOrder(oid, method) {
  const order = db.orders[oid];
  if (!order) return false;
  if (!["menunggu_pembayaran", "menunggu_konfirmasi"].includes(order.status)) return false;

  // Deposit order
  if (order.type === "deposit") {
    order.status = "selesai";
    order.payment_method = method || order.payment_method;
    order.completed_at = now();
    addSaldo(db, order.user_id, order.price);
    saveDB(db);
    try {
      await bot.telegram.sendMessage(
        order.user_id,
        `✅ Deposit berhasil +${toRupiah(order.price)}\nSaldo: *${toRupiah(getSaldo(db, order.user_id))}*`,
        { parse_mode: "Markdown" }
      );
    } catch (_) {}
    await sendNotif(`💰 Deposit sukses \`${oid}\` +${toRupiah(order.price)} • ${order.name}`);
    return true;
  }

  const pkgId = String(order.package_id);
  const stock = db.stock[pkgId] || [];
  if (!stock.length) {
    try {
      await bot.telegram.sendMessage(config.ownerId, `⚠️ \`${oid}\` paid, stok habis!`, { parse_mode: "Markdown" });
    } catch (_) {}
    return false;
  }
  const vps = stock.shift();
  db.stock[pkgId] = stock;
  order.status = "selesai";
  order.vps = vps;
  order.payment_method = method || order.payment_method;
  order.completed_at = now();
  db.stats.totalOrders = (db.stats.totalOrders || 0) + 1;
  db.stats.totalRevenue = (db.stats.totalRevenue || 0) + (order.price_final || order.price);

  // referral bonus once
  const u = db.users[String(order.user_id)];
  if (u && u.referredBy && !u.referralPaid) {
    addSaldo(db, u.referredBy, config.referralBonus || 0);
    u.referralPaid = true;
    try {
      await bot.telegram.sendMessage(
        u.referredBy,
        `🎁 Bonus referral +${toRupiah(config.referralBonus)} dari order ${u.name || order.user_id}`
      );
    } catch (_) {}
  }
  if (u) u.orders = (u.orders || 0) + 1;
  saveDB(db);

  const detail =
    `✅ *Order Berhasil*\n\`${oid}\` • ${order.package_name}\n\n` +
    `🌐 \`${vps.ip}\`\n🔌 \`${vps.port_range}\`\n👤 \`${vps.username}\`\n🔑 \`${vps.password}\`\n📝 ${vps.note || "-"}`;
  try {
    await bot.telegram.sendMessage(order.user_id, detail, { parse_mode: "Markdown" });
  } catch (_) {}
  await sendTestimoni(order);
  return true;
}

bot.action(/^confirm_(ORD\d+|DEP\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("Owner only", { show_alert: true });
  await ctx.answerCbQuery();
  const ok = await completeOrder(ctx.match[1], "manual");
  await ctx.reply(ok ? `✅ ${ctx.match[1]} OK` : `Gagal ${ctx.match[1]}`);
});

bot.action(/^reject_(ORD\d+|DEP\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("Owner only", { show_alert: true });
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  if (db.orders[oid]) {
    db.orders[oid].status = "ditolak";
    saveDB(db);
    try {
      await bot.telegram.sendMessage(db.orders[oid].user_id, `❌ \`${oid}\` ditolak.`, { parse_mode: "Markdown" });
    } catch (_) {}
  }
  await ctx.reply("Ditolak.");
});

// ===== SALDO MENU =====
bot.action("menu_saldo", async (ctx) => {
  await ctx.answerCbQuery();
  const s = getSaldo(db, ctx.from.id);
  await ctx.reply(`💰 *Saldo kamu: ${toRupiah(s)}*\n\nDeposit minimal Rp5.000`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Deposit", "deposit_start")],
      [Markup.button.callback("🔙", "back_home")]
    ])
  });
});

bot.action("deposit_start", async (ctx) => {
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "deposit_amount" };
  await ctx.reply("Kirim nominal deposit (angka, min 5000):");
});

// ===== VOUCHER MENU =====
bot.action("menu_voucher", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("🎟 Kirim kode voucher saat checkout order, atau di sini untuk cek.", {
    ...Markup.inlineKeyboard([[Markup.button.callback("🔙", "back_home")]])
  });
});

// ===== REFERRAL =====
bot.action("menu_referral", async (ctx) => {
  await ctx.answerCbQuery();
  const code = "ref" + ctx.from.id;
  db.referrals[code] = ctx.from.id;
  saveDB(db);
  const me = await ctx.telegram.getMe();
  const link = `https://t.me/${me.username}?start=${code}`;
  await ctx.reply(
    `🔗 *Link Referral Kamu*\n\`${link}\`\n\nBonus *${toRupiah(config.referralBonus)}* ke saldo saat orang yang kamu ajak order pertama kali sukses.`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔙", "back_home")]]) }
  );
});

// ===== CEK ORDER =====
bot.action("cek_order", async (ctx) => {
  await ctx.answerCbQuery();
  const list = Object.values(db.orders)
    .filter((o) => o.user_id === ctx.from.id && o.type !== "deposit")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 12);
  if (!list.length) return ctx.reply("Belum ada order.");
  let t = "*Riwayat Order*\n\n";
  for (const o of list) {
    t += `\`${o.order_id}\` • ${o.package_name || "Deposit"}\n${toRupiah(o.price_final || o.price)} • *${o.status}*\n\n`;
  }
  await ctx.reply(t, { parse_mode: "Markdown" });
});

// ===== ADMIN =====
bot.action("admin_menu", async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery("Owner only", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.reply("*⚙️ Admin Panel*", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📦 Paket", "adm_pkg"), Markup.button.callback("📥 Stok", "adm_stock")],
      [Markup.button.callback("📋 Pending", "adm_orders"), Markup.button.callback("📊 Stats", "adm_stats")],
      [Markup.button.callback("🎟 +Voucher", "adm_voucher"), Markup.button.callback("📢 Broadcast", "adm_bc")],
      [Markup.button.callback("💳 Saldo GW", "adm_balance"), Markup.button.callback("💾 Backup", "adm_backup")],
      [Markup.button.callback("🔙", "back_home")]
    ])
  });
});

bot.action("adm_stats", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const users = Object.keys(db.users).length;
  const pending = Object.values(db.orders).filter((o) => o.status === "menunggu_konfirmasi").length;
  let stok = 0;
  for (const k of Object.keys(db.stock)) stok += (db.stock[k] || []).length;
  await ctx.reply(
    `📊 *Statistik*\nUser: ${users}\nOrder sukses: ${db.stats.totalOrders || 0}\nRevenue: ${toRupiah(db.stats.totalRevenue || 0)}\nPending: ${pending}\nTotal stok VPS: ${stok}`,
    { parse_mode: "Markdown" }
  );
});

bot.action("adm_balance", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const b = await getBalance();
  await ctx.reply("```json\n" + JSON.stringify(b, null, 2) + "\n```", { parse_mode: "Markdown" });
});

bot.action("adm_backup", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  await ctx.replyWithDocument({ source: DB_PATH, filename: `backup-${Date.now()}.json` });
});

bot.action("adm_bc", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "broadcast" };
  await ctx.reply("Kirim pesan broadcast (text). Akan dikirim ke semua user bot.");
});

bot.action("adm_voucher", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "new_voucher" };
  await ctx.reply("Format voucher:\n`KODE|diskon_persen|max_pakai`\nContoh: `HEMAT10|10|50`", {
    parse_mode: "Markdown"
  });
});

bot.action("adm_pkg", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  let t = "*📦 Kelola Paket*\n\n";
  const rows = [];
  for (const p of db.packages) {
    const n = (db.stock[String(p.id)] || []).length;
    t += `• *${p.name}* — ${toRupiah(p.price)} (Stok ${n})\n`;
    rows.push([Markup.button.callback(`✏️ ${p.name}`, `editpkg_${p.id}`)]);
  }
  rows.push([Markup.button.callback("➕ Tambah Paket", "add_pkg")]);
  rows.push([Markup.button.callback("🔙", "admin_menu")]);
  await ctx.reply(t, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^editpkg_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const p = db.packages.find((x) => String(x.id) === id);
  if (!p) return ctx.reply("Paket tidak ada.");
  const n = (db.stock[id] || []).length;
  const t =
    `*Edit: ${p.name}*\n` +
    `ID: ${p.id}\nRAM: ${p.ram} | CPU: ${p.cpu}\n` +
    `Harga: *${toRupiah(p.price)}*\nStok: ${n}\n${p.desc || ""}`;
  await ctx.reply(t, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("💰 Ubah Harga", `setprice_${id}`)],
      [Markup.button.callback("📝 Ubah Nama", `setname_${id}`)],
      [Markup.button.callback("📄 Ubah Deskripsi", `setdesc_${id}`)],
      [Markup.button.callback("🗑️ Hapus Paket", `delpkg_${id}`)],
      [Markup.button.callback("🔙", "adm_pkg")]
    ])
  });
});

bot.action(/^setprice_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "price", pkgId: ctx.match[1] };
  await ctx.reply("Kirim *harga baru* (angka saja, contoh: 25000):", { parse_mode: "Markdown" });
});

bot.action(/^setname_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "name", pkgId: ctx.match[1] };
  await ctx.reply("Kirim *nama paket baru*:", { parse_mode: "Markdown" });
});

bot.action(/^setdesc_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "desc", pkgId: ctx.match[1] };
  await ctx.reply("Kirim *deskripsi baru*:");
});

bot.action(/^delpkg_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  db.packages = db.packages.filter((p) => String(p.id) !== id);
  delete db.stock[id];
  saveDB(db);
  await ctx.reply(`✅ Paket ID ${id} dihapus.`);
});

bot.action("add_pkg", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "add_pkg" };
  await ctx.reply(
    "Format paket baru:\n`Nama|RAM|CPU|Harga|Deskripsi`\n\nContoh:\n`NAT VPS 8GB|8GB|4 Core|75000|Heavy usage`",
    { parse_mode: "Markdown" }
  );
});

bot.action("adm_stock", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const rows = db.packages.map((p) => {
    const n = (db.stock[String(p.id)] || []).length;
    return [Markup.button.callback(`${p.name} (Stok: ${n})`, `viewstock_${p.id}`)];
  });
  rows.push([Markup.button.callback("🔙", "admin_menu")]);
  await ctx.reply("*📥 Kelola Stok*\nPilih paket:", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(rows)
  });
});

bot.action(/^viewstock_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const p = db.packages.find((x) => String(x.id) === id);
  const stock = db.stock[id] || [];
  let t = `*Stok: ${p ? p.name : id}*\nTotal: ${stock.length}\n\n`;
  const rows = [];
  if (!stock.length) t += "_Belum ada stok._\n";
  else {
    stock.forEach((v, i) => {
      t += `${i + 1}. \`${v.ip}\` | ${v.port_range} | ${v.username}\n`;
      rows.push([Markup.button.callback(`🗑️ Hapus #${i + 1} (${v.ip})`, `delstock_${id}_${i}`)]);
    });
  }
  rows.push([Markup.button.callback("➕ Tambah Stok", `addstock_${id}`)]);
  rows.push([Markup.button.callback("🔙", "adm_stock")]);
  await ctx.reply(t, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
});

bot.action(/^addstock_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  pendingInput[ctx.from.id] = { type: "stock", pkgId: ctx.match[1] };
  await ctx.reply(
    "Kirim detail VPS:\n`IP|PortRange|Username|Password|Note`\n\nContoh:\n`103.x.x.x|20000-20100|root|pass123|NAT SG`",
    { parse_mode: "Markdown" }
  );
});

bot.action(/^delstock_(\d+)_(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const idx = parseInt(ctx.match[2], 10);
  const stock = db.stock[id] || [];
  if (idx < 0 || idx >= stock.length) return ctx.reply("Index tidak valid.");
  const removed = stock.splice(idx, 1)[0];
  db.stock[id] = stock;
  saveDB(db);
  await ctx.reply(`✅ Dihapus: \`${removed.ip}\`\nSisa stok: ${stock.length}`, { parse_mode: "Markdown" });
});

bot.action("adm_orders", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.answerCbQuery();
  const pending = Object.values(db.orders).filter((o) => o.status === "menunggu_konfirmasi");
  if (!pending.length) return ctx.reply("Tidak ada pending.");
  for (const o of pending) {
    await ctx.reply(`\`${o.order_id}\` ${o.name}\n${o.package_name || "DEPOSIT"} ${toRupiah(o.price)}`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅", `confirm_${o.order_id}`), Markup.button.callback("❌", `reject_${o.order_id}`)]
      ])
    });
  }
});

// ===== TEXT HANDLER (admin inputs + voucher + deposit) =====
bot.on("text", async (ctx) => {
  const p = pendingInput[ctx.from.id];
  if (!p) return;

  // apply voucher to order
  if (p.type === "apply_voucher") {
    const code = ctx.message.text.trim().toUpperCase();
    const v = db.vouchers[code];
    const order = db.orders[p.orderId];
    delete pendingInput[ctx.from.id];
    if (!v || v.used >= v.max) return ctx.reply("Voucher invalid / habis.");
    if (!order || order.user_id !== ctx.from.id) return ctx.reply("Order invalid.");
    const disc = Math.floor((order.price * v.percent) / 100);
    order.price_final = Math.max(1000, order.price - disc);
    order.voucher = code;
    v.used = (v.used || 0) + 1;
    saveDB(db);
    return ctx.reply(
      `✅ Voucher *${code}* (-${v.percent}%)\nHarga: ${toRupiah(order.price)} → *${toRupiah(order.price_final)}*\nPilih metode bayar lagi dari tombol order.`,
      { parse_mode: "Markdown" }
    );
  }

  if (p.type === "deposit_amount") {
    const amount = parseInt(ctx.message.text.replace(/\D/g, ""), 10);
    delete pendingInput[ctx.from.id];
    if (!amount || amount < 5000) return ctx.reply("Minimal Rp5.000");
    const oid = orderId("DEP");
    db.orders[oid] = {
      order_id: oid,
      type: "deposit",
      user_id: ctx.from.id,
      username: ctx.from.username || "",
      name: ctx.from.first_name || "",
      package_name: "DEPOSIT SALDO",
      price: amount,
      price_final: amount,
      status: "menunggu_pembayaran",
      created_at: now()
    };
    saveDB(db);
    return ctx.reply(`Deposit *${toRupiah(amount)}*\nID: \`${oid}\`\nPilih bayar:`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚡ QRIS Auto", `depoauto_${oid}`)],
        [Markup.button.callback("📷 Manual", `depomanual_${oid}`)],
        [Markup.button.callback("❌", `cancel_${oid}`)]
      ])
    });
  }

  if (!isOwner(ctx.from.id)) return;

  if (p.type === "price") {
    const price = parseInt(ctx.message.text.replace(/\D/g, ""), 10);
    delete pendingInput[ctx.from.id];
    const pkg = db.packages.find((x) => String(x.id) === String(p.pkgId));
    if (pkg && price) {
      pkg.price = price;
      saveDB(db);
      await ctx.reply(`✅ Harga *${pkg.name}* diubah ke ${toRupiah(price)}`, { parse_mode: "Markdown" });
    } else await ctx.reply("Gagal ubah harga.");
  } else if (p.type === "name") {
    const name = ctx.message.text.trim();
    delete pendingInput[ctx.from.id];
    const pkg = db.packages.find((x) => String(x.id) === String(p.pkgId));
    if (pkg && name) {
      pkg.name = name;
      saveDB(db);
      await ctx.reply(`✅ Nama paket diubah menjadi *${name}*`, { parse_mode: "Markdown" });
    }
  } else if (p.type === "desc") {
    const desc = ctx.message.text.trim();
    delete pendingInput[ctx.from.id];
    const pkg = db.packages.find((x) => String(x.id) === String(p.pkgId));
    if (pkg) {
      pkg.desc = desc;
      saveDB(db);
      await ctx.reply("✅ Deskripsi diubah.");
    }
  } else if (p.type === "add_pkg") {
    delete pendingInput[ctx.from.id];
    const parts = ctx.message.text.split("|").map((s) => s.trim());
    if (parts.length < 4) return ctx.reply("Format: Nama|RAM|CPU|Harga|Deskripsi");
    const newId = db.packages.length ? Math.max(...db.packages.map((x) => x.id)) + 1 : 1;
    db.packages.push({
      id: newId,
      name: parts[0],
      ram: parts[1],
      cpu: parts[2],
      price: parseInt(parts[3], 10) || 0,
      desc: parts[4] || ""
    });
    saveDB(db);
    await ctx.reply(`✅ Paket *${parts[0]}* ditambahkan (ID ${newId})`, { parse_mode: "Markdown" });
  } else if (p.type === "stock") {
    const parts = ctx.message.text.split("|").map((s) => s.trim());
    delete pendingInput[ctx.from.id];
    if (parts.length < 4) return ctx.reply("Format salah");
    const key = String(p.pkgId);
    if (!db.stock[key]) db.stock[key] = [];
    db.stock[key].push({
      ip: parts[0],
      port_range: parts[1],
      username: parts[2],
      password: parts[3],
      note: parts[4] || "",
      added_at: now()
    });
    saveDB(db);
    await ctx.reply(`✅ Stok total: ${db.stock[key].length}`);
  } else if (p.type === "new_voucher") {
    const parts = ctx.message.text.trim().split("|");
    delete pendingInput[ctx.from.id];
    if (parts.length < 2) return ctx.reply("Format: KODE|persen|max");
    const code = parts[0].toUpperCase();
    db.vouchers[code] = {
      percent: parseInt(parts[1], 10) || 0,
      max: parseInt(parts[2], 10) || 100,
      used: 0
    };
    saveDB(db);
    await ctx.reply(`✅ Voucher ${code} -${db.vouchers[code].percent}% max ${db.vouchers[code].max}x`);
  } else if (p.type === "broadcast") {
    delete pendingInput[ctx.from.id];
    const msg = ctx.message.text;
    let ok = 0,
      fail = 0;
    await ctx.reply("Broadcast dimulai...");
    for (const id of Object.keys(db.users)) {
      try {
        await bot.telegram.sendMessage(id, msg);
        ok++;
        await sleep(40);
      } catch {
        fail++;
      }
    }
    await ctx.reply(`Selesai. OK: ${ok} | Gagal: ${fail}`);
  }
});

// deposit pay actions
bot.action(/^depoauto_(DEP\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id) return;
  const inv = await createInvoice(order.price, oid);
  if (!inv.ok) return ctx.reply("Gateway error: " + inv.error + " — pakai manual.");
  order.payment_method = "syahpay";
  order.invoice_id = inv.invoiceId;
  saveDB(db);
  if (inv.qrisImage) {
    try {
      await ctx.replyWithPhoto(inv.qrisImage, {
        caption: `Deposit \`${oid}\`\n${toRupiah(order.price)}`,
        parse_mode: "Markdown"
      });
    } catch {
      await ctx.reply(`Bayar: ${inv.paymentLink || inv.qrisImage}`);
    }
  }
  pollPayment(oid, inv.invoiceId, ctx.from.id);
});

bot.action(/^depomanual_(DEP\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const oid = ctx.match[1];
  const order = db.orders[oid];
  if (!order || order.user_id !== ctx.from.id) return;
  order.payment_method = "manual";
  saveDB(db);
  const text = `📷 Deposit Manual\n\`${oid}\`\n💰 ${toRupiah(order.price)}\n\nKirim foto bukti caption:\n\`depo ${oid}\``;
  if (config.manualQrisPhoto) {
    try {
      await ctx.replyWithPhoto(config.manualQrisPhoto, { caption: text, parse_mode: "Markdown" });
      return;
    } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: "Markdown" });
});

bot.command("admin", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  await ctx.reply("Admin:", Markup.inlineKeyboard([[Markup.button.callback("⚙️ Panel", "admin_menu")]]));
});

bot.launch().then(() => console.log("NAT VPS SyahPay+ enhanced bot running"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
