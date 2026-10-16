/**
 * Config non-secret. Token bot & API key di file .env
 */
module.exports = {
  botName: process.env.BOT_NAME || "NAT VPS Store",
  ownerId: Number(process.env.OWNER_ID || 0),
  ownerUsername: process.env.OWNER_USERNAME || "",

  // Notifikasi (bot harus admin)
  notifGroupId: process.env.NOTIF_GROUP_ID ? Number(process.env.NOTIF_GROUP_ID) : null,
  testimoniGroupId: process.env.TESTIMONI_GROUP_ID ? Number(process.env.TESTIMONI_GROUP_ID) : null,
  testimoniChannel: process.env.TESTIMONI_CHANNEL || null,

  // QRIS manual fallback
  manualQrisPhoto: process.env.MANUAL_QRIS_PHOTO || "",
  manualPaymentInfo:
    process.env.MANUAL_PAYMENT_INFO ||
    "Transfer sesuai nominal. Setelah bayar kirim foto bukti caption:\n`bayar ORDER_ID`",

  menuPhoto: process.env.MENU_PHOTO || null,
  orderTimeoutMinutes: Number(process.env.ORDER_TIMEOUT_MINUTES || 15),
  referralBonus: Number(process.env.REFERRAL_BONUS || 2000),

  packages: [
    { id: 1, name: "NAT VPS 1GB", ram: "1GB", cpu: "1 Core", price: 15000, desc: "Bot & web ringan" },
    { id: 2, name: "NAT VPS 2GB", ram: "2GB", cpu: "1 Core", price: 25000, desc: "Multi bot" },
    { id: 3, name: "NAT VPS 4GB", ram: "4GB", cpu: "2 Core", price: 40000, desc: "Lebih stabil" }
  ]
};
