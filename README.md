# NAT VPS Store (SyahPay)

Bot Telegram jual NAT VPS.

## Payment (sesuai docs SyahPay)
| Endpoint | Fungsi |
|----------|--------|
| `GET /api/balance` | Cek saldo |
| `GET /api/invoice?amount=` | Buat QRIS |
| `GET /api/invoice/status?invoice_id=` | Status: pending/paid/expired/cancelled |
| `POST /api/invoice/cancel` | Batalkan invoice pending |

Secret (token bot, API key) **hanya di `.env`**, tidak di source code.

## Setup
```bash
cp .env.example .env
# edit .env: BOT_TOKEN, OWNER_ID, SYAHPAY_API_KEY, dll
npm install
node bot.js
```

## Fitur
- QRIS Auto (SyahPay) + QRIS Manual fallback
- Saldo user, deposit, bayar saldo
- Voucher, referral
- Admin: harga, stok, paket, pending, stats, broadcast, backup
- Notifikasi + testimoni grup/channel

## Admin stok
`IP|PortRange|User|Pass|Note`

## Admin voucher
`KODE|persen|max_pakai`
