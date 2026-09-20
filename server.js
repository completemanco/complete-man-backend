import express from "express";
import cors from "cors";
import pg from "pg";
import Stripe from "stripe";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // room for course file uploads

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API = "https://api.daily.co/v1";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_data (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visitors (
      device_id TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT now(),
      last_seen TIMESTAMPTZ DEFAULT now()
    )
  `);
}
ensureTable()
  .then(() => console.log("Database ready"))
  .catch((e) => console.error("Database init failed:", e.message));

// Health check — visiting this URL in a browser should return {"ok":true}
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------- Shared app data (community posts, videos, calendar, etc.) ---------- */
app.get("/api/kv/:key", async (req, res) => {
  try {
    const r = await pool.query("SELECT value FROM shared_data WHERE key = $1", [req.params.key]);
    if (r.rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json({ key: req.params.key, value: r.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/kv/:key", async (req, res) => {
  try {
    const value = req.body ? req.body.value : null;
    await pool.query(
      `INSERT INTO shared_data (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [req.params.key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Live video rooms (Daily.co) ---------- */
// Creates a Daily.co video room and returns its join URL.
// body: { name?: string, expiryMinutes?: number }
app.post("/api/create-room", async (req, res) => {
  if (!DAILY_API_KEY) {
    return res.status(500).json({ error: "Server is missing DAILY_API_KEY. Set it in your host's environment variables." });
  }
  try {
    const { name, expiryMinutes } = req.body || {};

    const properties = {
      enable_prejoin_ui: true,
      enable_chat: true
    };
    if (expiryMinutes) {
      properties.exp = Math.floor(Date.now() / 1000) + expiryMinutes * 60;
    }

    const body = { properties };
    if (name) {
      // Daily room names can only contain letters, numbers, dashes and underscores
      body.name = name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 50) + "-" + Date.now().toString(36).slice(-4);
    }

    const dailyRes = await fetch(`${DAILY_API}/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DAILY_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await dailyRes.json();

    if (!dailyRes.ok) {
      return res.status(dailyRes.status).json({ error: data.error || data.info || "Daily.co rejected the request." });
    }

    res.json({ url: data.url, name: data.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Payments (Stripe) ---------- */
// Creates a Stripe Checkout session for either a recurring membership
// or a one-time program fee, and returns the URL to redirect the browser to.
// body: { tierName, price (dollars), billingType: 'recurring'|'one_time', successUrl, cancelUrl }
app.post("/api/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY. Set it in your host's environment variables." });
  }
  try {
    const { tierName, price, billingType, successUrl, cancelUrl } = req.body || {};
    if (!tierName || !price || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    const unitAmount = Math.round(Number(price) * 100);
    if (!unitAmount || unitAmount <= 0) {
      return res.status(400).json({ error: "Invalid price." });
    }

    const price_data = {
      currency: "usd",
      product_data: { name: tierName },
      unit_amount: unitAmount
    };
    if (billingType === "recurring") {
      price_data.recurring = { interval: "month" };
    }

    const session = await stripe.checkout.sessions.create({
      mode: billingType === "recurring" ? "subscription" : "payment",
      line_items: [{ price_data, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirms whether a completed Checkout session actually paid, so the
// front end can safely unlock membership after the redirect back.
app.get("/api/verify-session", async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY." });
  }
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "Missing session_id." });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === "paid" || session.status === "complete";
    const email = session.customer_details ? session.customer_details.email : null;
    const name = session.customer_details ? session.customer_details.name : null;
    res.json({ paid, email, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Visitor tracking (how many people have opened the app) ---------- */
// body: { deviceId }
app.post("/api/track-visit", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId." });
    await pool.query(
      `INSERT INTO visitors (device_id, first_seen, last_seen) VALUES ($1, now(), now())
       ON CONFLICT (device_id) DO UPDATE SET last_seen = now()`,
      [deviceId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/visitor-count", async (req, res) => {
  try {
    const total = await pool.query("SELECT COUNT(*)::int AS count FROM visitors");
    const active30 = await pool.query("SELECT COUNT(*)::int AS count FROM visitors WHERE last_seen > now() - interval '30 days'");
    res.json({ total: total.rows[0].count, active30: active30.rows[0].count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video backend running on port ${PORT}`));
