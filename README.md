# AÖF Sınav Robotu

Anadolu Üniversitesi AÖF (aofsoru.com) ve Atatürk Üniversitesi AÖF (ataaofsoru.com) çıkmış sınav sorularıyla
kavramaya dayalı çalışma uygulaması. Tamamen statik (GitHub Pages); tüm veriler cihazınızda (localStorage) tutulur.

**Canlı:** https://danolda.github.io/aof-sinavlarim/

## Özellikler
- Ders linkini yapıştırın; üniversite otomatik tanınır, sitedeki sınav listesi okunur, seçtiğiniz türde (vize, final, bütünleme, yaz okulu…) son N sınav getirilir.
- Sıralı çalışma (kaldığınız yerden devam), Leitner tipi aralıklı tekrar (1-3-7-14-30 gün), yanlış defteri, karma kavrama, işaretliler.
- Süreli deneme sınavı: karma, geçmiş sınavı birebir ya da zayıf konular; sonuç kâğıdı ve sınav geçmişi.
- Soru notları, ders/sınav/not araması, soru haritası, görsel yakınlaştırma, klavye (A–E, ← →, F) ve kaydırma ile gezinme.
- JSON yedek al / yükle, çevrimdışı çalışma (PWA, soru görselleri önbelleğe alınır), koyu / açık / sistem teması.

## Bağlantı
Tarayıcılar başka sitelerin sayfalarını doğrudan okumaya izin vermediği için sorular bir aracı (proxy) üzerinden okunur.
En güvenilir yol `worker.js` dosyasındaki kodla ücretsiz bir Cloudflare Worker kurup adresini **Ayarlar › Bağlantı** bölümüne girmektir.

## Dosyalar
- `index.html` – kabuk
- `assets/app.css`, `assets/app.js` – arayüz ve uygulama mantığı (derleme gerektirmez)
- `sw.js`, `manifest.webmanifest` – çevrimdışı kullanım ve ana ekrana ekleme
- `worker.js` – Cloudflare Worker örneği
