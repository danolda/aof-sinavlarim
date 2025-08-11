// api/dispatch.js
const GH_API = "https://api.github.com";
const REPO = process.env.GH_REPO;
const BRANCH = process.env.GH_BRANCH || "main";
const TOKEN = process.env.GH_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || null;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  if (!REPO || !TOKEN) return res.status(500).json({ error: "Server misconfigured" });
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  }

  const url = `${GH_API}/repos/${REPO}/actions/workflows/scrape.yml/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: BRANCH })
  });
  if (!r.ok) {
    const t = await r.text();
    return res.status(500).json({ error: "dispatch failed", details: t });
  }
  return res.status(200).json({ ok: true });
}
