import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API = "https://api.daily.co/v1";

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
}
ensureTable()
  .then(() => console.log("Database ready"))
  .catch((e) => console.error("Database init failed:", e.message));

app.get("/health", (req, res) => res.json({ ok: true }));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video backend running on port ${PORT}`));
