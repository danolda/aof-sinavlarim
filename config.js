// api/config.js
import { Buffer } from "node:buffer";

const GH_API = "https://api.github.com";
const REPO = process.env.GH_REPO;       // "owner/repo" (örn: "batuhan/aof-app")
const BRANCH = process.env.GH_BRANCH || "main";
const TOKEN = process.env.GH_TOKEN;     // classic veya fine‑grained repo write
const ADMIN_KEY = process.env.ADMIN_KEY || null; // opsiyonel

const FILE_PATH = "data/config.json";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-key");
}

async function getFileSha() {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("get sha failed");
  const j = await r.json();
  return j.sha || null;
}

async function putFile(contentB64, sha) {
  const body = {
    message: `chore(config): update via api ${new Date().toISOString()}`,
    content: contentB64,
    branch: BRANCH,
    committer: { name: "mini-backend", email: "actions@users.noreply.github.com" },
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("put failed");
  return r.json();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!REPO || !TOKEN) return res.status(500).json({ error: "Server misconfigured" });

  if (req.method === "GET") {
    // Raw içeriği GitHub’tan çek
    const r = await fetch(`${GH_API}/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" }
    });
    if (r.status === 404) return res.status(200).json({ ders1: [], ders2: [], ders3: [], ders4: [], ders5: [] });
    if (!r.ok) return res.status(500).json({ error: "cannot read config" });
    const j = await r.json();
    const decoded = Buffer.from(j.content, j.encoding || "base64").toString("utf8");
    return res.status(200).send(decoded);
  }

  if (req.method === "POST") {
    try {
      if (ADMIN_KEY) {
        const key = req.headers["x-admin-key"];
        if (key !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
      }
      const data = req.body || {};
      const shape = ["ders1","ders2","ders3","ders4","ders5"];
      const clean = {};
      for (const k of shape) {
        const arr = Array.isArray(data[k]) ? data[k] : [];
        // basit temizleme
        clean[k] = [...new Set(arr.map(x => String(x).trim()).filter(Boolean))];
      }
      const sha = await getFileSha();
      const b64 = Buffer.from(JSON.stringify(clean, null, 2), "utf8").toString("base64");
      await putFile(b64, sha);
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "save failed" });
    }
  }

  res.setHeader("Allow", "GET,POST,OPTIONS");
  return res.status(405).end();
}
