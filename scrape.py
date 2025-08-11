# scripts/scrape.py (ilgili kısımlar)
import os, re, json, time, hashlib
from datetime import datetime
import requests
from bs4 import BeautifulSoup

VALID = set(list("ABCDE"))
ROOT = os.path.dirname(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
INDEX_PATH = os.path.join(DATA_DIR, "index.json")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8",
})

ANSWER_PATTERNS = [re.compile(r"(?i)(doğru\s*cevap|cevap|yanıt)\s*[:\-]?\s*([A-EİI])")]

# burada önceki sürümdeki scrape_exam_page(url) fonksiyonunu aynen kullanabilirsin


def read_config():
    if not os.path.exists(CONFIG_PATH):
        return {f"ders{i}": [] for i in range(1,6)}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        try:
            cfg = json.load(f)
        except Exception:
            cfg = {}
    # normalize
    clean = {}
    for i in range(1,6):
        k = f"ders{i}"
        arr = cfg.get(k) or []
        clean[k] = [u.strip() for u in arr if u and isinstance(u, str)]
    return clean


def write_json(path: str, obj: dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = json.dumps(obj, ensure_ascii=False, indent=2)
    old = None
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            old = f.read()
    if old == data:
        print(f"[ATLANDI] {path}")
        return
    with open(path, "w", encoding="utf-8") as f:
        f.write(data)
    print(f"[GÜNCELLENDİ] {path}")


def main():
    cfg = read_config()
    index = {"updated_at": datetime.utcnow().isoformat() + "Z", "courses": []}

    for i in range(1,6):
        key = f"ders{i}"
        display = f"Ders{i}"
        urls = cfg.get(key, [])
        all_questions = []
        for u in urls:
            print(f"-> çekiliyor: {u}")
            all_questions.extend(scrape_exam_page(u))
            time.sleep(1)
        # tekrarları kaldır
        seen = set(); uniq = []
        for q in all_questions:
            k = q.get("image_url")
            if k in seen: continue
            seen.add(k); uniq.append(q)

        payload = {"displayName": display, "data": uniq}
        outfile = os.path.join(DATA_DIR, f"{key}.json")
        write_json(outfile, payload)

        index["courses"].append({
            "key": key,
            "displayName": display,
            "file": f"{key}.json",
            "count": len(uniq),
        })

    write_json(INDEX_PATH, index)

if __name__ == "__main__":
    main()
