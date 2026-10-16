const axios = require("axios");

function getConfig() {
  return {
    baseUrl: (process.env.SYAHPAY_BASE_URL || "https://syah.piantech.biz.id").replace(/\/$/, ""),
    apikey: process.env.SYAHPAY_API_KEY || ""
  };
}

function toRupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

/**
 * GET /api/balance?apikey=
 */
async function getBalance() {
  const { baseUrl, apikey } = getConfig();
  if (!apikey) return { error: "SYAHPAY_API_KEY belum diisi di .env" };
  try {
    const { data } = await axios.get(`${baseUrl}/api/balance`, {
      params: { apikey },
      timeout: 15000
    });
    return data;
  } catch (e) {
    return { error: e.response?.data?.error || e.response?.data?.message || e.message };
  }
}

/**
 * GET /api/invoice?apikey=&amount=
 * Response:
 * { success, invoice_id, amount, fee, total, qris_image, payment_link, expired_at }
 */
async function createInvoice(amount, orderId) {
  const { baseUrl, apikey } = getConfig();
  if (!apikey) return { ok: false, error: "SYAHPAY_API_KEY belum diisi di .env" };
  try {
    const { data } = await axios.get(`${baseUrl}/api/invoice`, {
      params: {
        apikey,
        amount: Number(amount)
        // order_id optional – docs only require apikey + amount
      },
      timeout: 20000
    });

    if (!data || data.success === false) {
      return { ok: false, error: data?.error || data?.message || "Gagal buat invoice", raw: data };
    }

    return {
      ok: true,
      invoiceId: data.invoice_id,
      amount: data.amount,
      fee: data.fee || 0,
      total: data.total || data.amount,
      qrisImage: data.qris_image || null,
      paymentLink: data.payment_link || null,
      expiredAt: data.expired_at || null,
      raw: data
    };
  } catch (e) {
    return {
      ok: false,
      error: e.response?.data?.error || e.response?.data?.message || e.message,
      raw: e.response?.data
    };
  }
}

/**
 * GET /api/invoice/status?apikey=&invoice_id=
 * status: pending | paid | expired | cancelled
 */
async function checkInvoiceStatus(invoiceId) {
  const { baseUrl, apikey } = getConfig();
  if (!apikey || !invoiceId) return { paid: false, status: "unknown" };
  try {
    const { data } = await axios.get(`${baseUrl}/api/invoice/status`, {
      params: { apikey, invoice_id: invoiceId },
      timeout: 15000
    });
    const status = String(data?.status || "").toLowerCase();
    return {
      paid: status === "paid",
      status,
      amount: data?.amount,
      fee: data?.fee,
      total: data?.total,
      raw: data
    };
  } catch (e) {
    return {
      paid: false,
      status: "error",
      error: e.response?.data?.error || e.message
    };
  }
}

/**
 * POST/GET /api/invoice/cancel?apikey=&invoice_id=
 */
async function cancelInvoice(invoiceId) {
  const { baseUrl, apikey } = getConfig();
  if (!apikey || !invoiceId) return { ok: false, error: "Missing key/id" };
  try {
    const { data } = await axios.post(`${baseUrl}/api/invoice/cancel`, null, {
      params: { apikey, invoice_id: invoiceId },
      timeout: 15000
    });
    return { ok: !!data?.success, data };
  } catch (e) {
    return {
      ok: false,
      error: e.response?.data?.error || e.message,
      data: e.response?.data
    };
  }
}

module.exports = {
  createInvoice,
  checkInvoiceStatus,
  cancelInvoice,
  getBalance,
  toRupiah
};
