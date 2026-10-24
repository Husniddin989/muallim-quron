# Muallim Qurʼon

Tajvid mushafi sahifalari va Mahmud Xalil al-Husariy qiroati.
Sahifadagi istalgan oyatni bossangiz, oʻsha oyat oʻqiladi. Butun surani yoki
boshidan oxirigacha ham tinglash mumkin.

- **Sayt:** https://husniddin989.github.io/muallim-quron/
- **Android ilova (APK):** [Releases](https://github.com/Husniddin989/muallim-quron/releases/latest)

Hozircha 30-poradagi 90–114-suralar bor (mushafning 594–604-betlari).

## Imkoniyatlar

- Mushafning asl tajvid sahifalari, rangli tajvid belgilari bilan.
- Oyatni bosish: oʻsha oyat oʻqiladi va sahifada ajratib koʻrsatiladi.
- Uch rejim: **Bitta oyat**, **Butun sura**, **Davomli** (oxirgi suragacha).
  Qiroat davom etganda sahifa oʻzi varaqlanadi.
- **Takror**: oyat yoki surani qayta-qayta oʻqish (yodlash uchun).
- Telefonda bitta sahifa, kompyuterda ochiq kitob (ikki sahifa yonma-yon).
- Kompyuterda klaviatura: ← → sahifa, ↑ ↓ oyat, Probel ijro/pauza.
- Ilova internetsiz ishlaydi.

## Tuzilishi

| Papka | Nima bor |
| --- | --- |
| `android/app/src/main/assets/www/` | Interfeys (HTML/CSS/JS), sahifa rasmlari, oyatma-oyat audio. Ilova ham, sayt ham shu papkadan ishlaydi. |
| `android/` | Android loyihasi (WebView oynasi). |
| `tools/prepare.py` | Mushaf PDF va sura mp3 fayllaridan `www` ichidagi maʼlumotlarni yasaydi. |
| `tools/husary_ayah_durations.json` | Husariy qiroatidagi har bir oyat davomiyligi. Qori uzun oyat ichida toʻxtagan joylarni oyat oxiridan ajratish uchun kerak. |
| `.github/workflows/pages.yml` | `main` ga push qilinganda saytni GitHub Pages'ga joylaydi. |

## Yangi suralar qoʻshish

Manba fayllar (mushaf PDF va `NNN.mp3`) repoga kiritilmaydi. Ular loyiha ildizida turadi.

1. `NNN.mp3` audio fayllarni loyiha ildiziga qoʻying.
2. `tools/prepare.py` ichida `SURAHS` (nomi, oyatlar soni) va `PAGES` roʻyxatini toʻldiring.
   `PAGES` har bir sahifa qaysi sura va oyatdan boshlanishini koʻrsatadi.
   Agar sahifa sarlavhasiz basmaladan boshlansa, oyat raqami `0` boʻladi.
3. Yangi suralarni `tools/husary_ayah_durations.json` ga ham qoʻshing.
   Bu maʼlumot everyayah.com dagi `Husary_128kbps` fayllari hajmidan olinadi.
4. Maʼlumotlarni yasang (kerak: `pip install numpy scipy pillow`, `brew install poppler ffmpeg`):

```bash
python3 tools/prepare.py . android/app/src/main/assets/www
```

   Skript har bir sahifadagi oyat belgilarini, sahifalar orasidagi uzviylikni va audio
   boʻlaklarini tekshiradi. Biror narsa mos kelmasa, xato bilan toʻxtaydi.

5. APK yigʻing (`android/app/build.gradle` da `versionCode` ni oshiring):

```bash
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease
```

6. Commit qilib push qiling: sayt oʻzi yangilanadi. APK'ni yangi Release sifatida qoʻshing.

## Imzo kaliti

APK `android/tajvid-release.jks` kaliti bilan imzolanadi (parollar `android/keystore.properties` da).
Ikkalasi ham repoga kiritilmaydi. Ularni yoʻqotmang va zaxira nusxasini saqlang:
yangilangan ilova eski ilova ustiga faqat shu kalit bilan oʻrnatiladi.
