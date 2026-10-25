# Muallim Qurʼon

Tajvid mushafi sahifalari va Mahmud Xalil al-Husariy qiroati.
Sahifadagi istalgan oyatni bossangiz, oʻsha oyat oʻqiladi. Butun surani yoki
boshidan oxirigacha ham tinglash mumkin.

- **Sayt:** https://husniddin989.github.io/muallim-quron/
- **Android ilova (APK):** [Releases](https://github.com/Husniddin989/muallim-quron/releases/latest)

Butun Qurʼon: 114 sura, 6236 oyat, mushafning 604 sahifasi.

## Imkoniyatlar

- Mushafning asl tajvid sahifalari, rangli tajvid belgilari bilan.
- Oyatni bosish: oʻsha oyat oʻqiladi va sahifada ajratib koʻrsatiladi.
- Uch rejim: **Bitta oyat**, **Butun sura**, **Davomli** (oxirgi suragacha).
  Qiroat davom etganda sahifa oʻzi varaqlanadi.
- **Takror**: oyat yoki surani qayta-qayta oʻqish (yodlash uchun).
- **Mashq** (mikrofon tugmasi): oyat yoki surani oʻzingiz oʻqib yozib olasiz,
  keyin **Men** bilan oʻz qiroatingizni, **Qori** bilan namunani tinglab solishtirasiz.
  Yozuvlar faqat shu qurilmada saqlanadi.
- Telefonda bitta sahifa, kompyuterda ochiq kitob (ikki sahifa yonma-yon).
- Kompyuterda klaviatura: ← → sahifa, ↑ ↓ oyat, Probel ijro/pauza, mashqda R yozishni boshlaydi/toʻxtatadi.
- Mushaf sahifalari ilova ichida, internetsiz oʻqiladi. Audio (2.3 GB) Cloudflare R2 dan oʻqiladi;
  ilovada istalgan surani yoki hammasini **yuklab olish** mumkin, yuklangan sura internetsiz ishlaydi.
- Suralar roʻyxatida nomi (oʻzbekcha yoki arabcha) yoki raqami boʻyicha qidiruv.

## Tuzilishi

| Papka | Nima bor |
| --- | --- |
| `android/app/src/main/assets/www/` | Interfeys (HTML/CSS/JS), sahifa rasmlari va oyat vaqtlari (`data.js`). Ilova ham, sayt ham shu papkadan ishlaydi. |
| Cloudflare R2, `quron` bucket | Suralarning toʻliq audiosi: `quron/070.mp3` … `quron/114.mp3`. Manzili `app.js` dagi `AUDIO_BASE` da. |
| `android/` | Android loyihasi (WebView oynasi). |
| `tools/prepare.py` | Mushaf PDF va sura mp3 fayllaridan sahifa rasmlari, oyat hududlari va har bir oyatning audiodagi vaqtini yasaydi. |
| `tools/husary_ayah_durations.json` | Husariy qiroatidagi har bir oyat davomiyligi. Qori uzun oyat ichida toʻxtagan joylarni oyat oxiridan ajratish uchun kerak. |
| `.github/workflows/pages.yml` | `main` ga push qilinganda saytni GitHub Pages'ga joylaydi. |
| `vercel.json` | Vercel uchun: sayt `android/app/src/main/assets/www` papkasidan beriladi. |

## Yangi suralar qoʻshish

Manba fayllar (mushaf PDF va `NNN.mp3`) repoga kiritilmaydi. Ular loyiha ildizida turadi.

1. `NNN.mp3` audio fayllarni loyiha ildiziga qoʻying va Cloudflare R2 dagi `quron` bucket ichidagi `quron/` papkasiga yuklang.
2. Qurʼon toʻliq boʻlgani uchun `tools/prepare.py` dagi jadvallarni oʻzgartirish shart emas.
   Skript 1-sahifadan boshlab oyat belgilarini sanaydi va har bir sura oxirida oyatlar sonini tekshiradi.
   Andoza topa olmagan ikki belgi `MANUAL_MARKERS` da qoʻlda koʻrsatilgan.
3. `tools/husary_ayah_durations.json`: Husariy qiroatidagi har bir oyat davomiyligi
   (everyayah.com dagi `Husary_128kbps` fayllari hajmidan olingan). Qori uzun oyat ichida toʻxtagan
   yoki ikki oyatni toʻxtamasdan oʻqigan joylarni ajratishda ishlatiladi.
4. Maʼlumotlarni yasang (kerak: `pip install numpy scipy pillow`, `brew install poppler ffmpeg`):

```bash
python3 tools/prepare.py . android/app/src/main/assets/www
```

   Skript har bir sahifadagi oyat belgilarini, sahifalar orasidagi uzviylikni va audio
   boʻlaklarini tekshiradi. Biror narsa mos kelmasa, xato bilan toʻxtaydi.

5. APK yigʻing (`android/app/build.gradle` da `versionCode` ni oshiring). Build fayllari iCloud bilan
   toʻqnashmasligi uchun `~/.cache/muallim-quron` ga yoziladi, tayyor APK loyiha ildiziga
   `Muallim-Quron.apk` nomi bilan nusxalanadi:

```bash
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease
```

6. Commit qilib push qiling: sayt oʻzi yangilanadi. APK'ni yangi Release sifatida qoʻshing.

## Imzo kaliti

APK `android/tajvid-release.jks` kaliti bilan imzolanadi (parollar `android/keystore.properties` da).
Ikkalasi ham repoga kiritilmaydi. Ularni yoʻqotmang va zaxira nusxasini saqlang:
yangilangan ilova eski ilova ustiga faqat shu kalit bilan oʻrnatiladi.
