import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.jso
const DAILY_API_KEY = process.env.DAILY_API_KEY;
const DAILY_API = "https://api.daily.co/v1";

// Health check — visiting this URL in a browser should return {"ok":true}
app.get("/health", (req, res) => res.json({ ok: true }));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video backend running on port ${PORT}`));
