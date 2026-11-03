#!/usr/bin/env python3
"""AÖF Sınav Robotu — bölüm/ders kataloğu üreticisi.

aofsoru.com (Anadolu AÖF) ve ataaofsoru.com (Atatürk AÖF) sitelerindeki bölüm listesini ve her
bölümün yarıyıllara göre ders listesini okur; data/katalog-anadolu.json ve data/katalog-ata.json yazar.

Kullanım:  python3 tools/katalog.py [--uni anadolu|ata|all] [--cache DIR] [--delay 0.8] [--max N]

- Yalnızca standart kütüphane kullanır.
- Kibar tarama: istekler arası bekleme, 3 deneme (artan bekleme), isteğe bağlı disk önbelleği.
- Çıktı deterministiktir (sıralı anahtarlar, tarih alanı yalnızca içerik değişince güncellenir),
  böylece GitHub Actions yalnızca katalog gerçekten değiştiğinde commit atar.
"""
import argparse, hashlib, html, json, os, re, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 AofSinavRobotuKatalog/1.0'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class Fetcher:
    def __init__(self, cache=None, delay=0.8):
        self.cache, self.delay, self.last = cache, delay, 0.0
        if cache: os.makedirs(cache, exist_ok=True)

    def get(self, url):
        if self.cache:
            p = os.path.join(self.cache, hashlib.sha1(url.encode()).hexdigest() + '.html')
            if os.path.exists(p):
                return open(p, encoding='utf-8').read()
        err = None
        for attempt in range(3):
            wait = self.delay - (time.time() - self.last)
            if wait > 0: time.sleep(wait)
            self.last = time.time()
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9'})
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read().decode('utf-8', 'replace')
                if self.cache:
                    with open(p, 'w', encoding='utf-8') as f: f.write(body)
                return body
            except urllib.error.HTTPError as e:
                err = e
                if e.code in (404, 410): break
            except Exception as e:  # ağ hatası
                err = e
            time.sleep(2 * (attempt + 1))
        raise RuntimeError(f'{url}: {err}')

def text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()

SMALL = {'ve', 'ile', 'için', 'veya', 'ya', 'da', 'de', 'ın', 'in'}
def norm_name(s):
    """Site adlarını toparlar: 'Hukuk Dili Ve Adli Yazışmalar' -> 'Hukuk Dili ve Adli Yazışmalar'."""
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'^Ingilizce', 'İngilizce', s)
    words = s.split(' ')
    out = []
    for i, w in enumerate(words):
        lw = w.replace('I', 'ı').replace('İ', 'i').lower()
        out.append(lw if i and lw in SMALL else w)
    return ' '.join(out)

def fold(s):
    """Türkçe harf duyarsız arama anahtarı."""
    s = s.replace('İ', 'i').replace('I', 'ı').lower()
    return s.translate(str.maketrans('çğıöşüâîû', 'cgiosuaiu'))

TERM_RX = re.compile(r'(\d+)\s*\.?\s*(?:yarıyıl|yariyil|yarıyil|dönem|donem)', re.I)
def parse_term(label):
    m = TERM_RX.search(label.replace('YARIYIL', 'Yarıyıl').replace('DÖNEM', 'Dönem'))
    if not m: return None, None
    n = int(m.group(1))
    season = 'Güz' if re.search(r'güz', label, re.I) else 'Bahar' if re.search(r'bahar', label, re.I) else ('Güz' if n % 2 else 'Bahar')
    return n, season

def sections(body, link_rx):
    """Sayfadaki h2/h3/h4 başlıkları ile ders linklerini sırasıyla dolaşır; başlık altında gruplar."""
    groups, cur = [], None
    for m in re.finditer(r'<h([2-4])[^>]*>(.*?)</h\1>|<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', body, re.S | re.I):
        if m.group(2) is not None and not re.search(r'<a\b', m.group(2), re.I):
            label = text(m.group(2))
            if label: cur = {'label': label, 'links': []}; groups.append(cur)
            continue
        href = m.group(3) if m.group(3) else None
        inner = m.group(4)
        if href is None:  # başlığın içinde link (h3 > a)
            a = re.search(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', m.group(2), re.S | re.I)
            if not a: continue
            href, inner = a.group(1), a.group(2)
        lm = link_rx(href)
        if lm and cur is not None:
            cur['links'].append((lm, text(inner)))
    return [g for g in groups if g['links']]

# ---------------- Anadolu (aofsoru.com) ----------------
ANA_LIST = 'https://aofsoru.com/amp/aof-bolumleri'
def ana_course(href):
    p = re.sub(r'[?#].*$', '', href)
    p = re.sub(r'^https?://(www\.)?aofsoru\.com', '', p)
    p = re.sub(r'^/(amp|mobile)/', '/', p)
    m = re.match(r'^/([a-z]{2,4}\d{3}[a-z]?-.+?-dersi)(?:-notlari-ozetleri-ve)?-sinav-sorulari$', p)
    return m.group(1) if m else None

def crawl_anadolu(F, limit=None):
    body = F.get(ANA_LIST)
    body = body[body.find('<body'):]
    progs, level, faculty = [], None, None
    for m in re.finditer(r'<h2[^>]*>(.*?)</h2>|<a\b[^>]*href="(/[^"]+-bolumu-sinav-sorulari)"[^>]*>(.*?)</a>', body, re.S):
        if m.group(1) is not None:
            h = text(m.group(1))
            if 'Önlisans' in h or 'Ön Lisans' in h: level, faculty = 'onlisans', 'Açıköğretim Fakültesi'
            elif 'Lisans' in h: level, faculty = 'lisans', 'Açıköğretim Fakültesi'
            elif 'Fakültesi' in h: level, faculty = 'lisans', h
            else: level = None
            continue
        if not level: continue
        slug = m.group(2).strip('/').replace('-bolumu-sinav-sorulari', '')
        if any(p['id'] == slug for p in progs): continue
        progs.append({'id': slug, 'name': norm_name(text(m.group(3))), 'level': level, 'faculty': faculty,
                      'url': f'https://aofsoru.com/amp/{slug}-bolumu-sinav-sorulari'})
    courses = {}
    for i, p in enumerate(progs[:limit] if limit else progs):
        try:
            pb = F.get(p['url'])
        except Exception as e:
            print('  ! ' + str(e), file=sys.stderr); p['terms'] = []; p['error'] = True; continue
        pb = pb[pb.find('<h1'):]
        p['terms'] = []
        if re.search(r'hen[üu]z eklenmemi|han[üu]z eklenmemi', pb): p['empty'] = True
        for g in sections(pb, ana_course):
            n, season = parse_term(g['label'])
            ids = []
            for slug, name in g['links']:
                code = slug.split('-', 1)[0].upper()
                if slug not in courses:
                    courses[slug] = {'n': norm_name(name), 'c': code, 'u': f'https://aofsoru.com/{slug}-notlari-ozetleri-ve-sinav-sorulari'}
                if slug not in ids: ids.append(slug)
            p['terms'].append({'n': n, 's': season, 'label': (f'{n}. Yarıyıl' if n else g['label']), 'c': ids})
        print(f'  [{i+1}/{len(progs)}] {p["name"]}: {sum(len(t["c"]) for t in p["terms"])} ders', file=sys.stderr)
    return progs, courses, {'list': ANA_LIST, 'programUrl': 'https://aofsoru.com/amp/{id}-bolumu-sinav-sorulari', 'courseUrl': 'https://aofsoru.com/{id}-notlari-ozetleri-ve-sinav-sorulari'}

# ---------------- Atatürk (ataaofsoru.com) ----------------
ATA_LIST = 'https://ataaofsoru.com/ata-aof-bolumleri/amp'
def ata_course(href):
    p = re.sub(r'[?#].*$', '', href)
    p = re.sub(r'^https?://(www\.)?ataaofsoru\.com', '', p)
    p = re.sub(r'/amp$', '', p)
    m = re.match(r'^/(ata-aof-.+-dersi-\d+)$', p)
    return m.group(1) if m else None

def crawl_ata(F, limit=None):
    body = F.get(ATA_LIST)
    body = body[body.find('<body'):]
    progs, seen = [], set()
    for m in re.finditer(r'<a\b[^>]*href="(?:https://ataaofsoru\.com)?/(ata-aof-[^"]+-programi-\d+)"[^>]*>(.*?)</a>', body, re.S):
        slug = m.group(1)
        if slug in seen: continue
        seen.add(slug)
        level = 'lisans-tamamlama' if '-lisans-tamamlama-programi-' in slug else 'onlisans' if '-onlisans-programi-' in slug else 'lisans'
        progs.append({'id': slug, 'name': norm_name(text(m.group(2))), 'level': level, 'faculty': 'Açıköğretim Fakültesi',
                      'url': f'https://ataaofsoru.com/{slug}/amp'})
    courses = {}
    for i, p in enumerate(progs[:limit] if limit else progs):
        try:
            pb = F.get(p['url'])
        except Exception as e:
            print('  ! ' + str(e), file=sys.stderr); p['terms'] = []; p['error'] = True; continue
        h1 = re.search(r'<h1[^>]*>(.*?)</h1>', pb, re.S)
        pb = pb[h1.start():] if h1 else pb
        p['terms'] = []
        for g in sections(pb, ata_course):
            n, season = parse_term(g['label'])
            ids = []
            for slug, name in g['links']:
                if slug not in courses:
                    courses[slug] = {'n': norm_name(name), 'c': '', 'u': f'https://ataaofsoru.com/{slug}'}
                if slug not in ids: ids.append(slug)
            p['terms'].append({'n': n, 's': season, 'label': (f'{n}. Yarıyıl' if n else g['label']), 'c': ids})
        print(f'  [{i+1}/{len(progs)}] {p["name"]}: {sum(len(t["c"]) for t in p["terms"])} ders', file=sys.stderr)
    return progs, courses, {'list': ATA_LIST, 'programUrl': 'https://ataaofsoru.com/{id}/amp', 'courseUrl': 'https://ataaofsoru.com/{id}'}

UNIS = {
    'anadolu': ('Anadolu Üniversitesi AÖF', 'aofsoru.com', crawl_anadolu,
                [('onlisans', 'Önlisans'), ('lisans', 'Lisans')]),
    'ata': ('Atatürk Üniversitesi AÖF', 'ataaofsoru.com', crawl_ata,
            [('onlisans', 'Önlisans'), ('lisans', 'Lisans'), ('lisans-tamamlama', 'Lisans Tamamlama')]),
}

def build(uni, F, limit=None):
    name, site, fn, levels = UNIS[uni]
    print(f'{name} taranıyor…', file=sys.stderr)
    progs, courses, src = fn(F, limit)
    if not progs: raise RuntimeError(f'{uni}: bölüm listesi boş — site düzeni değişmiş olabilir')
    ok = [p for p in progs if p.get('terms') or p.get('empty')]
    if len(ok) < len(progs) * 0.6: raise RuntimeError(f'{uni}: bölümlerin çoğu okunamadı ({len(ok)}/{len(progs)})')
    progs.sort(key=lambda p: ([l for l, _ in levels].index(p['level']), fold(p['name'])))
    # Dersler tek listede (paylaşılan dersler bir kez); bölümler derslere sıra numarasıyla bağlanır.
    ids = sorted(courses)
    index = {cid: i for i, cid in enumerate(ids)}
    out_progs = []
    for p in progs:
        terms = [{'n': t['n'], 's': t['s'], 'label': t['label'], 'c': [index[c] for c in t['c']]} for t in p.get('terms', [])]
        out_progs.append({'id': p['id'], 'name': p['name'], 'level': p['level'], 'faculty': p['faculty'], 'terms': terms})
    return {
        'v': 1, 'uni': uni, 'name': name, 'site': site, 'source': src['list'],
        'programUrl': src['programUrl'], 'courseUrl': src['courseUrl'],
        'levels': [{'id': l, 'name': n, 'count': sum(1 for p in progs if p['level'] == l)} for l, n in levels if any(p['level'] == l for p in progs)],
        'programs': out_progs,
        # [kimlik, ad] — ders adresi courseUrl şablonundaki {id} yerine kimlik konarak elde edilir
        'courses': [[cid, courses[cid]['n']] for cid in ids],
    }

def write(uni, data, out_dir):
    path = os.path.join(out_dir, f'katalog-{uni}.json')
    old = None
    if os.path.exists(path):
        try: old = json.load(open(path, encoding='utf-8'))
        except Exception: old = None
    if old and {k: v for k, v in old.items() if k != 'generated'} == data:
        print(f'{path}: değişiklik yok', file=sys.stderr); return False
    data = dict(data); data['generated'] = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'), sort_keys=False)
        f.write('\n')
    print(f'{path}: yazıldı ({os.path.getsize(path)//1024} KB, {len(data["programs"])} bölüm, {len(data["courses"])} ders)', file=sys.stderr)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--uni', default='all', choices=['all', *UNIS])
    ap.add_argument('--cache', default=None)
    ap.add_argument('--delay', type=float, default=0.8)
    ap.add_argument('--max', type=int, default=None, help='bölüm sınırı (deneme için)')
    ap.add_argument('--out', default=os.path.join(ROOT, 'data'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    F = Fetcher(a.cache, a.delay)
    failed = False
    for uni in (UNIS if a.uni == 'all' else [a.uni]):
        try:
            write(uni, build(uni, F, a.max), a.out)
        except Exception as e:
            failed = True; print(f'HATA {uni}: {e}', file=sys.stderr)
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
