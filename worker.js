// AÖF Sınav Robotu için Cloudflare Worker (CORS aracısı)
// Kurulum: dash.cloudflare.com › Workers & Pages › Create › Worker › bu kodu yapıştırıp Deploy.
// Ardından uygulamada Ayarlar › Bağlantı alanına https://<adınız>.workers.dev adresini girin.
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('url parametresi gerekli', { status: 400, headers: cors });
    const host = new URL(target).hostname.replace(/^www\./, '');
    if (!['aofsoru.com', 'ataaofsoru.com'].includes(host)) {
      return new Response('Bu adrese izin verilmiyor', { status: 403, headers: cors });
    }
    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'Accept-Language': 'tr-TR,tr;q=0.9' },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 3600, '404': 60, '500-599': 0 } }
    });
    const h = new Headers(cors);
    h.set('Content-Type', res.headers.get('Content-Type') || 'text/html; charset=utf-8');
    return new Response(res.body, { status: res.status, headers: h });
  }
};
