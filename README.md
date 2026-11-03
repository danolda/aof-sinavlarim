# AÖF Sınav Robotu

Anadolu Üniversitesi AÖF (aofsoru.com) ve Atatürk Üniversitesi AÖF (ataaofsoru.com) çıkmış sınav sorularıyla
kavramaya dayalı çalışma uygulaması. Tamamen statik (GitHub Pages); tüm veriler cihazınızda (localStorage) tutulur.

**Canlı:** https://danolda.github.io/aof-sinavlarim/

## Özellikler
- **Bölüm seçici:** Üniversite → Önlisans/Lisans → bölüm (Türkçe harf duyarsız arama) → yarıyıl → dersleri işaretleyip Başlat. Link gerekmez; seçilen bölüm hatırlanır ve panelde “Bu dönemki derslerim” kartı çıkar.
- Gelişmiş: ders linkini yapıştırın; üniversite otomatik tanınır, sitedeki sınav listesi okunur, seçtiğiniz türde (vize, final, bütünleme, yaz okulu…) son N sınav getirilir.
- Sıralı çalışma (kaldığınız yerden devam), Leitner tipi aralıklı tekrar (1-3-7-14-30 gün), yanlış defteri, karma kavrama, işaretliler.
- Süreli deneme sınavı: karma, geçmiş sınavı birebir ya da zayıf konular; sonuç kâğıdı ve sınav geçmişi.
- Soru notları, ders/sınav/not araması, soru haritası, görsel yakınlaştırma, klavye (A–E, ← →, F) ve kaydırma ile gezinme.
- JSON yedek al / yükle, çevrimdışı çalışma (PWA, soru görselleri önbelleğe alınır), koyu / açık / sistem teması.

## Bağlantı
Tarayıcılar başka sitelerin sayfalarını doğrudan okumaya izin vermediği için sorular bir aracı (proxy) üzerinden okunur.
En güvenilir yol `worker.js` dosyasındaki kodla ücretsiz bir Cloudflare Worker kurup adresini **Ayarlar › Bağlantı** bölümüne girmektir.

## Bölüm / ders kataloğu
`data/katalog-anadolu.json` ve `data/katalog-ata.json`, `tools/katalog.py` ile sitelerin bölüm listesinden
(aofsoru.com/amp/aof-bolumleri, ataaofsoru.com/ata-aof-bolumleri/amp) ve her bölümün yarıyıl başlıklı ders listesinden üretilir.
Dersler tek listede tutulur (bölümler arası ortak dersler bir kez), bölümler derslere sıra numarasıyla bağlanır; ders adresi `courseUrl` şablonundan çıkar.
`.github/workflows/katalog.yml` her pazartesi ve elle tetiklenince kataloğu yeniden üretir, yalnızca değişiklik varsa commit atar.
Katalog yüklenemezse ya da bir bölüm katalogda yoksa uygulama listeyi aracı (Worker/proxy) üzerinden siteden canlı okur.

```
python3 tools/katalog.py                 # ikisi birden
python3 tools/katalog.py --uni ata --cache .cache
```

## Dosyalar
- `index.html` – kabuk
- `assets/app.css`, `assets/app.js` – arayüz ve uygulama mantığı (derleme gerektirmez)
- `sw.js`, `manifest.webmanifest` – çevrimdışı kullanım ve ana ekrana ekleme
- `worker.js` – Cloudflare Worker örneği
- `data/`, `tools/katalog.py`, `.github/workflows/katalog.yml` – bölüm/ders kataloğu ve haftalık güncelleme
