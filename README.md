# Muallim Qurʼon

Tajvid mushafi sahifalari va Mahmud Xalil al-Husariy qiroati.
Sahifadagi istalgan oyatni bossangiz, oʻsha oyat oʻqiladi. Butun surani yoki
boshidan oxirigacha ham tinglash mumkin.

- **Sayt:** https://husniddin989.github.io/muallim-quron/
- **Android ilova (APK):** [Releases](https://github.com/Husniddin989/muallim-quron/releases/latest)

Hozircha 70–114-suralar bor: 29-poraning oxiri va 30-pora (mushafning 568–604-betlari).

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
2. `tools/prepare.py` ichida `SURAHS` (nomi, oyatlar soni), `FIRST_PAGE` va `PAGES` ni yangilang.
   `PAGES` da birinchi sahifa qaysi sura va oyatdan boshlanishi yoziladi; qolgan sahifalarni
   skript oyat belgilarini sanab oʻzi davom ettiradi. Roʻyxatdagi boshqa sahifalar nazorat nuqtasi:
   sanoq ularga aniq yetib kelmasa, skript xato beradi.
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
