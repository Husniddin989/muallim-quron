"""Cuts the Quranic duas out of Husary's recitation, one mp3 per dua.

Most duas are only part of an ayah ("Rabbana atina..." starts in the middle of
2:201), so each one is cut at a word boundary.  Word timings from the
quran-align data set (made for the very per-ayah files used here: everyayah.com,
Husary) say roughly where a word starts, to within 0.1 s.  The exact instant
is then found in the sound itself:

- after a pause: just before the voice comes back;
- "Rabbana" / "Rabbi" read on from the word before: these words are r, a short
  "a", then a long doubled "b" during which the mouth is closed.  The closure
  and the vowel before it are easy to find, and the cut goes 60 ms before
  that vowel, inside the r;
- anything else: the instant was picked by eye on a spectrogram (MANUAL).

Usage (needs numpy, plus ffmpeg and curl on PATH):
    python duas.py <cache_dir> <out_dir>
    python duas.py --export <out_dir> <assets_www_dir>   # the list the app shows

Writes <out_dir>/SSS-AAA.mp3 for every dua, <out_dir>/duolar.json (texts and
titles) and <out_dir>/tinglash.html, a page for listening through them all.
"""
import json
import os
import re
import subprocess
import sys
import zipfile

import numpy as np

AUDIO_URL = 'https://everyayah.com/data/Husary_128kbps/{s:03d}{a:03d}.mp3'
ALIGN_URL = ('https://github.com/cpfair/quran-align/releases/download/'
             'release-2016-11-24/quran-align-data-2016-11-24.zip')
ALIGN_FILE = 'Husary_64kbps.json'  # same recording as the 128 kbps files, same timing
WORDS_URL = 'https://api.qurancdn.com/api/qdc/verses/by_key/{s}:{a}?words=true&word_fields=text_uthmani'

RATE = 44100
HOP = 441  # 10 ms
FINE_HOP = 220
FPS = RATE / FINE_HOP  # frames per second of band_levels(): 200.45, not 200

# The list opens with this many "Rabbana" duas; the app shows them as their own group.
RABBANA_COUNT = 27

# (file id, surah, first ayah, last ayah, first words, last words, title)
# "first words" / "last words" are given without vowel marks, in the mushaf's
# spelling; None means the dua runs from the start / to the end of the ayah.
DUAS = [
    # --- "Rabbana" duas
    ('002-127', 2, 127, 127, 'ربنا', None, 'Amallarni qabul qilishni soʻrash'),
    ('002-128', 2, 128, 128, None, None, 'Allohga boʻysunuvchi boʻlish va tavba'),
    ('002-201', 2, 201, 201, 'ربنا', None, 'Dunyo va oxirat yaxshiligi'),
    ('002-250', 2, 250, 250, 'ربنا', None, 'Sabr va sabot soʻrash'),
    ('002-285', 2, 285, 285, 'سمعنا واطعنا', None, 'Eshitdik va itoat etdik'),
    ('002-286', 2, 286, 286, 'ربنا لا', None, 'Yukni yengil qilish va magʻfirat'),
    ('003-008', 3, 8, 9, None, None, 'Qalbni hidoyatda sobit qilish'),
    ('003-016', 3, 16, 16, 'ربنا', None, 'Iymon keltirdik, gunohlarimizni kechir'),
    ('003-053', 3, 53, 53, None, None, 'Shohidlar qatoriga yozilish'),
    ('003-147', 3, 147, 147, 'ربنا', None, 'Gunohlarni kechirish va qadamlarni sobit qilish'),
    ('003-191', 3, 191, 194, 'ربنا ما', None, 'Aql egalarining duosi'),
    ('005-083', 5, 83, 83, 'ربنا', None, 'Shohidlar bilan birga yozilish'),
    # read on as "maryama-llahumma", so the dua starts one word later, at "Rabbana"
    ('005-114', 5, 114, 114, 'ربنا', None, 'Rizq soʻrash (Iso alayhissalom)'),
    ('007-023', 7, 23, 23, 'ربنا', None, 'Tavba (Odam alayhissalom)'),
    ('007-047', 7, 47, 47, 'ربنا', None, 'Zolimlar bilan birga qilmaslikni soʻrash'),
    ('007-089', 7, 89, 89, 'ربنا افتح', None, 'Haq bilan hukm qilishni soʻrash'),
    ('007-126', 7, 126, 126, 'ربنا افرغ', None, 'Sabr va musulmon holda vafot etish'),
    ('010-085', 10, 85, 86, 'ربنا لا', None, 'Zolimlar fitnasidan najot'),
    ('014-040', 14, 40, 41, None, None, 'Namozni barpo qilish va ota-ona uchun magʻfirat'),
    ('018-010', 18, 10, 10, 'ربنا', None, 'Rahmat va toʻgʻri yoʻl soʻrash'),
    ('023-109', 23, 109, 109, 'ربنا', None, 'Magʻfirat va rahmat soʻrash'),
    ('025-065', 25, 65, 66, 'ربنا', None, 'Jahannam azobidan panoh'),
    ('025-074', 25, 74, 74, 'ربنا', None, 'Solih oila va zurriyot'),
    ('040-007', 40, 7, 9, 'ربنا وسعت', None, 'Farishtalarning moʻminlar uchun duosi'),
    ('059-010', 59, 10, 10, 'ربنا', None, 'Oldin oʻtgan moʻminlar uchun magʻfirat'),
    ('060-004', 60, 4, 5, 'ربنا عليك', None, 'Tavakkul va magʻfirat'),
    ('066-008', 66, 8, 8, 'ربنا اتمم', None, 'Nurni mukammal qilishni soʻrash'),
    # --- "Rabbi" and other duas
    ('002-156', 2, 156, 156, 'انا لله', None, 'Musibat yetganda'),
    ('003-026', 3, 26, 27, None, None, 'Mulk egasi Allohga iltijo'),
    ('003-038', 3, 38, 38, 'رب هب', None, 'Solih farzand soʻrash (Zakariyo alayhissalom)'),
    ('003-173', 3, 173, 173, 'حسبنا', None, 'Alloh bizga kifoya'),
    ('007-151', 7, 151, 151, 'رب اغفر', None, 'Oʻzi va birodari uchun magʻfirat (Muso alayhissalom)'),
    ('009-129', 9, 129, 129, 'حسبي', None, 'Alloh menga kifoya'),
    ('011-047', 11, 47, 47, 'رب', None, 'Bilmagan narsani soʻrashdan panoh (Nuh alayhissalom)'),
    ('012-101', 12, 101, 101, None, None, 'Musulmon holda vafot etish (Yusuf alayhissalom)'),
    ('017-024', 17, 24, 24, 'رب ارحمهما', None, 'Ota-ona uchun duo'),
    ('017-080', 17, 80, 80, 'رب ادخلني', None, 'Har ishga sidq bilan kirish va chiqish'),
    ('020-025', 20, 25, 28, 'رب اشرح', None, 'Ishni oson qilish (Muso alayhissalom)'),
    ('020-114', 20, 114, 114, 'رب زدني', None, 'Ilmni ziyoda qilish'),
    ('021-083', 21, 83, 83, 'اني مسني', None, 'Shifo soʻrash (Ayyub alayhissalom)'),
    ('021-087', 21, 87, 87, 'لا اله الا انت', None, 'Gʻam-tashvishdan najot (Yunus alayhissalom)'),
    ('021-089', 21, 89, 89, 'رب لا', None, 'Farzand soʻrash (Zakariyo alayhissalom)'),
    ('023-029', 23, 29, 29, 'رب انزلني', None, 'Muborak manzilga tushirish'),
    ('023-097', 23, 97, 98, 'رب اعوذ', None, 'Shayton vasvasasidan panoh'),
    ('023-118', 23, 118, 118, 'رب اغفر', None, 'Magʻfirat va rahmat'),
    ('026-083', 26, 83, 85, None, None, 'Hikmat va solihlarga qoʻshilish (Ibrohim alayhissalom)'),
    ('027-019', 27, 19, 19, 'رب اوزعني', None, 'Neʼmatga shukr qilish (Sulaymon alayhissalom)'),
    ('028-016', 28, 16, 16, 'رب اني', 'فاغفر لي', 'Gunohni tan olib, magʻfirat soʻrash (Muso alayhissalom)'),
    ('028-021', 28, 21, 21, 'رب نجني', None, 'Zolim qavmdan najot'),
    ('028-024', 28, 24, 24, 'رب اني', None, 'Yaxshilikka muhtojlik (Muso alayhissalom)'),
    ('029-030', 29, 30, 30, 'رب انصرني', None, 'Buzgʻunchilarga qarshi yordam'),
    ('037-100', 37, 100, 100, None, None, 'Solih farzand soʻrash (Ibrohim alayhissalom)'),
    ('040-044', 40, 44, 44, 'وافوض', None, 'Ishni Allohga topshirish'),
    ('043-013', 43, 13, 14, 'سبحن الذي', None, 'Ulovga minganda (safar duosi)'),
    ('046-015', 46, 15, 15, 'رب اوزعني', None, 'Shukr va solih zurriyot'),
    ('066-011', 66, 11, 11, 'رب ابن', None, 'Jannatda uy soʻrash (Firʼavn ayoli)'),
    ('071-028', 71, 28, 28, None, 'والمؤمنت', 'Ota-ona va moʻminlar uchun magʻfirat (Nuh alayhissalom)'),
]


def norm(text):
    """Arabic letters only: no vowel marks, pause signs or elongation strokes."""
    out = []
    for ch in text:
        o = ord(ch)
        if 0x064B <= o <= 0x065F or o == 0x0670 or 0x06D6 <= o <= 0x06ED or o == 0x0640 or ch.isspace():
            continue
        out.append({'ٱ': 'ا', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي'}.get(ch, ch))
    return ''.join(out)


def fetch(url, path):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        subprocess.run(['curl', '-sfL', '--retry', '3', '--max-time', '120', '-o', path, url], check=True)
    return path


class Source:
    def __init__(self, cache):
        self.cache = cache
        os.makedirs(os.path.join(cache, 'audio'), exist_ok=True)
        os.makedirs(os.path.join(cache, 'words'), exist_ok=True)
        z = zipfile.ZipFile(fetch(ALIGN_URL, os.path.join(cache, 'quran-align.zip')))
        self.align = {(v['surah'], v['ayah']): v['segments'] for v in json.loads(z.read(ALIGN_FILE))}

    def words(self, s, a):
        path = fetch(WORDS_URL.format(s=s, a=a), os.path.join(self.cache, 'words', f'{s}-{a}.json'))
        verse = json.load(open(path, encoding='utf-8'))['verse']
        return [w['text_uthmani'] for w in verse['words'] if w['char_type_name'] == 'word']

    def pcm(self, s, a):
        """The ayah as int16 stereo samples."""
        path = fetch(AUDIO_URL.format(s=s, a=a), os.path.join(self.cache, 'audio', f'{s:03d}{a:03d}.mp3'))
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 's16le', '-ac', '2',
                              '-ar', str(RATE), '-'], capture_output=True, check=True).stdout
        return np.frombuffer(raw, dtype=np.int16).reshape(-1, 2)

    def word_times(self, s, a, n_words):
        """(start, end) seconds of every word in the ayah's file."""
        times = [None] * n_words
        for w0, w1, t0, t1 in self.align[(s, a)]:
            # a segment can cover several words the aligner could not separate
            for w in range(w0, min(w1, n_words)):
                times[w] = (t0 / 1000, t1 / 1000, w1 - w0)
        return times


# Cut instants (seconds into the ayah's file) picked by eye on a spectrogram, for
# duas that neither follow a pause nor begin with "Rabbana" / "Rabbi".
MANUAL = {
    '002-285': {'start': 40.75},   # "...qalu | sami'na": where the hiss of the s begins
    '002-156': {'start': 11.54},   # "...qalu | inna lillahi": at the glottal stop
    '003-173': {'start': 15.26},   # "...wa qalu | hasbunallahu"
    '009-129': {'start': 5.535},   # "fa qul | hasbiyallahu": after the l has died away
    '021-083': {'start': 6.335},   # "...rabbahu | anni massaniya": at the glottal stop
    # "an la" is read "al-la" with an l held for 0.4 s (19.12-19.53); the dua takes its last 90 ms
    '021-087': {'start': 19.45},
    '043-013': {'start': 17.83},   # "...wa taqulu | subhana": where the s begins
    '028-016': {'end': 10.43},     # "...faghfir li | fa ghafara": end of the long i, before the f
    '071-028': {'end': 15.955},    # "...wal mu'minati | wa la tazid": end of "ti", before the w
}


def band_levels(pcm, hop=FINE_HOP, win=1024):
    """Loudness every 5 ms (FPS frames per second), in dB below the loudest moment: the whole signal,
    and everything above 350 Hz.  While the lips are closed for a doubled b
    only the hum of the voice below 300 Hz is left, so the second one drops
    far down there, which no vowel, r, l or n does for long."""
    mono = pcm.astype(np.float64).mean(axis=1)
    n = (len(mono) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(mono[idx] * np.hanning(win), axis=1)) ** 2
    freq = np.fft.rfftfreq(win, 1 / RATE)
    full = spec.sum(axis=1) + 1e-3
    upper = spec[:, (freq >= 350) & (freq < 5000)].sum(axis=1) + 1e-3
    ref = full.max()
    smooth = np.ones(3) / 3
    return (10 * np.log10(np.convolve(full, smooth, mode='same') / ref),
            10 * np.log10(np.convolve(upper, smooth, mode='same') / ref))


def after_pause(full, want):
    """If the voice stops near `want`, the instant 80 ms before it comes back."""
    i0, i1 = max(0, int((want - 0.35) * FPS)), min(len(full), int((want + 0.2) * FPS))
    quiet = full[i0:i1] < -40
    best = None
    start = None
    for k, q in enumerate(list(quiet) + [False]):
        if q and start is None:
            start = k
        elif not q and start is not None:
            if k - start >= 16 and (best is None or k - start > best[1] - best[0]):  # 80 ms
                best = (start, k)
            start = None
    if best is None:
        return None
    lo, hi = (i0 + best[0]) / FPS, (i0 + best[1]) / FPS
    return max(lo, hi - 0.08)


def ends_in_consonant(word):
    """True when nothing is voiced between this word and the next: it ends in
    a letter with sukun ("qalat") or with no mark at all ("qul" before an r)."""
    marks = [ch for ch in word if not ch.isspace() and not 0x06D6 <= ord(ch) <= 0x06DC]
    while marks and ord(marks[-1]) in (0x06DF, 0x06E0, 0x06E2, 0x06E5, 0x06E6, 0x0653, 0x0670):
        marks.pop()  # silent-letter signs and small vowel letters
    last = marks[-1]
    if ord(last) in (0x0652, 0x06E1):
        return True
    return not 0x064B <= ord(last) <= 0x0651 and last not in 'اوىي'


def rabb_onset(upper, want, long_r=False):
    """Where "Rabbana" / "Rabbi" starts when it is read on from the word before.

    The doubled b is a closure of 0.22-0.75 s; the stretch right before it is
    the short "a" of "ra" (0.1-0.3 s), and right before that the tongue taps
    the r.  The cut goes 50 ms before the vowel, which is at or inside the r;
    100 ms when the r is a long one (`long_r`: "qul Rabbi" is read "qur-rabbi").
    Returns a dict with the cut and what was found, or None.
    """
    f = lambda t: int(t * FPS)
    i, stop = f(want + 0.10), min(len(upper) - 160, f(want + 1.3))
    while i < stop:
        peak = upper[max(0, i - 40):i].max()
        if upper[i:i + 30].max() > peak - 15:  # not 150 ms at least 15 dB down
            i += 1
            continue
        # the closure lasts until the sound comes back up from its floor (the
        # "i" of "Rabbi" is much weaker than the "a" before the closure)
        floor = np.median(upper[i:i + 30])
        end = i + 30
        while end < len(upper) - 4 and upper[end:end + 4].min() < floor + 8:
            end += 1
        if not 44 <= end - i <= 150:  # 0.22-0.75 s
            i = end + 1
            continue
        # back over the falling edge, then over the vowel (dips up to 15 ms allowed)
        k = i
        while upper[k] < peak - 5:
            k -= 1
        vowel_end = k
        holes = 0
        while k > 0 and holes <= 3 and vowel_end - k < 64:
            k -= 1
            holes = holes + 1 if upper[k] < peak - 5 else 0
        vowel = k + holes + 1
        how = 'vowel'
        if vowel_end - vowel >= 60:
            # no clear dip before the vowel: it ran on from the vowel before, so
            # take the r tap, the deepest dip 0.10-0.32 s before the closure
            lo, hi = vowel_end - 64, vowel_end - 20
            tap = lo + int(np.argmin(upper[lo:hi]))
            vowel, how = tap + 4, 'tap'
        depth = upper[vowel:vowel_end].max() - upper[max(0, vowel - 14):vowel].min()
        lead = 0.10 if long_r else 0.05
        if long_r:
            how += ', long r'
        return {'cut': vowel / FPS - lead, 'vowel': vowel / FPS, 'closure': i / FPS,
                'closure_end': end / FPS, 'how': how, 'dip': round(float(depth), 1)}
    return None


def level_db(pcm):
    """Loudness per 10 ms, in dB relative to the loudest moment."""
    mono = pcm.astype(np.float64).mean(axis=1)
    n = len(mono) // HOP
    rms = np.sqrt((mono[:n * HOP].reshape(n, HOP) ** 2).mean(axis=1) + 1e-9)
    rms = np.convolve(rms, np.ones(3) / 3, mode='same')
    return 20 * np.log10(rms / rms.max())


def speech_bounds(db):
    """First and last instant louder than -38 dB."""
    loud = np.nonzero(db > -38)[0]
    return loud[0] / 100, (loud[-1] + 1) / 100


def fade(x, n, out):
    n = min(n, len(x))
    ramp = np.linspace(0, 1, n)[:, None]
    x = x.astype(np.float64)
    if out:
        x[-n:] *= ramp[::-1]
    else:
        x[:n] *= ramp
    return x


def cut_dua(src, dua):
    did, s, a1, a2, first, last, title = dua
    parts, text, info = [], [], {}
    for a in range(a1, a2 + 1):
        words = src.words(s, a)
        nw = [norm(w) for w in words]
        times = src.word_times(s, a, len(words))
        pcm = src.pcm(s, a)
        db = level_db(pcm)
        onset, speech_end = speech_bounds(db)
        w_from, w_to = 0, len(words) - 1
        t0, t1 = max(0.0, onset - 0.12), min(len(pcm) / RATE, speech_end + 0.45)
        fade_in, fade_out = 0.005, 0.01

        if a == a1 and first:
            ph = first.split()
            hits = [i for i in range(len(nw) - len(ph) + 1) if nw[i:i + len(ph)] == ph]
            if not hits:
                raise SystemExit(f'{did}: "{first}" not found in {s}:{a}: {" ".join(nw)}')
            w_from = hits[0]
            if w_from > 0:
                if times[w_from] is None or times[w_from][2] != 1 or times[w_from - 1] is None:
                    raise SystemExit(f'{did}: no separate timing for word {w_from + 1} of {s}:{a}')
                want = times[w_from][0]
                full, upper = band_levels(pcm)
                how, detail = 'manual', ''
                if did in MANUAL and 'start' in MANUAL[did]:
                    t0 = MANUAL[did]['start']
                elif after_pause(full, want) is not None:
                    t0, how = after_pause(full, want), 'pause'
                elif ph[0] in ('رب', 'ربنا'):
                    found = rabb_onset(upper, want, ends_in_consonant(words[w_from - 1]))
                    if found is None:
                        raise SystemExit(f'{did}: no doubled b found after {want}s in {s}:{a}')
                    t0, how = found['cut'], 'rabb'
                    detail = (f" {found['how']} {found['vowel']:.3f}-{found['closure']:.3f}"
                              f" bb to {found['closure_end']:.3f} dip {found['dip']} dB")
                    if found['how'].startswith('tap') or found['dip'] < 5 or found['vowel'] - want > 0.55:
                        detail += ' CHECK'
                    info['marks'] = [found['vowel'], found['closure'], found['closure_end']]
                else:
                    t0, how = want, 'UNVERIFIED'  # needs a MANUAL entry
                info['start'] = (how, round(want, 3), round(t0, 3), detail)
                info['src'] = (s, a)
                fade_in = 0.015
        if a == a2 and last:
            ph = last.split()
            hits = [i for i in range(w_from, len(nw) - len(ph) + 1) if nw[i:i + len(ph)] == ph]
            if not hits:
                raise SystemExit(f'{did}: "{last}" not found in {s}:{a}: {" ".join(nw)}')
            w_to = hits[0] + len(ph) - 1
            if w_to < len(words) - 1:
                if times[w_to] is None or times[w_to + 1] is None or times[w_to + 1][2] != 1:
                    raise SystemExit(f'{did}: no separate timing for word {w_to + 1} of {s}:{a}')
                want = times[w_to][1]
                how = 'manual' if 'end' in MANUAL.get(did, {}) else 'UNVERIFIED'
                t1 = MANUAL[did]['end'] if how == 'manual' else want
                info['end'] = (how, round(want, 3), round(t1, 3), '')
                info['end_src'] = (s, a)
                fade_out = 0.04

        seg = pcm[int(t0 * RATE):int(t1 * RATE)]
        seg = fade(fade(seg, int(fade_in * RATE), out=False), int(fade_out * RATE), out=True)
        parts.append(seg)
        text.append(' '.join(words[w_from:w_to + 1]))
        info.setdefault('ayahs', []).append({'a': a, 'w': [w_from + 1, w_to + 1], 'of': len(words),
                                             'aligned': max(w1 for _, w1, _, _ in src.align[(s, a)])})
    samples = np.clip(np.concatenate(parts), -32768, 32767).astype(np.int16)
    return samples, ' '.join(text), info


def speech_level(samples):
    """Loudness of the voiced parts of a clip, in dB."""
    mono = samples.astype(np.float64).mean(axis=1)
    n = len(mono) // HOP
    power = (mono[:n * HOP].reshape(n, HOP) ** 2).mean(axis=1) + 1e-9
    return 10 * np.log10(power[power > power.max() / 1000].mean())


PAGE = """<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Qurʼoniy duolar: tinglab tekshirish</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap">
<style>
  body { margin: 0; background: #f1f4ec; color: #17231d; font: 15px/1.5 system-ui, sans-serif; }
  header { background: #0b5d3b; color: #fff; padding: 20px max(16px, calc(50% - 400px)); }
  header h1 { margin: 0; font-size: 22px; }
  header p { margin: 6px 0 0; opacity: .85; }
  main { max-width: 800px; margin: 0 auto; padding: 16px; display: grid; gap: 10px; }
  article { background: #fff; border: 1px solid #dbe2d5; border-radius: 12px; padding: 12px 14px; }
  .top { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .n { color: #0b5d3b; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ref { margin-left: auto; color: #5a6a61; font-size: 13px; font-variant-numeric: tabular-nums; }
  .ar { direction: rtl; font: 24px/2 "Amiri", "Noto Naskh Arabic", serif; margin: 6px 0 8px; }
  audio { width: 100%; height: 36px; }
</style>
</head>
<body>
<header>
  <h1>Qurʼoniy duolar</h1>
  <p>__COUNT__ ta duo, qori Mahmud Xalil al-Husariy. Har birini tinglab, boshlanishi va tugashini tekshiring.</p>
</header>
<main>
__ROWS__
</main>
</body>
</html>
"""


def write_page(out, manifest):
    rows = []
    for i, m in enumerate(manifest, 1):
        ref = f"{m['s']}:{m['a'][0]}" + (f"–{m['a'][1]}" if m['a'][1] != m['a'][0] else '')
        rows.append(f'<article><div class="top"><span class="n">{i}.</span><b>{m["uz"]}</b>'
                    f'<span class="ref">{ref} · {m["dur"]:.0f} s · {m["file"]}</span></div>'
                    f'<div class="ar">{m["ar"]}</div>'
                    f'<audio controls preload="none" src="{m["file"]}"></audio></article>')
    with open(os.path.join(out, 'tinglash.html'), 'w', encoding='utf-8') as f:
        f.write(PAGE.replace('__COUNT__', str(len(manifest))).replace('__ROWS__', '\n'.join(rows)))


# Meanings: Shaykh Muhammad Sodiq Muhammad Yusuf's translation of the meanings
# (Latin script), as quran.com publishes it. Taken word for word, footnote marks dropped.
MEANING_URL = 'https://api.qurancdn.com/api/qdc/verses/by_key/{s}:{a}?translations=55'
MEANING_SOURCE = 'Shayx Muhammad Sodiq Muhammad Yusuf tarjimasi'


def meaning(s, a, cache):
    path = os.path.join(cache, f'uz55-{s:03d}{a:03d}.json')
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        subprocess.run(['curl', '-sfL', '--retry', '3', '--max-time', '60', '-A', 'Mozilla/5.0',
                        '-o', path, MEANING_URL.format(s=s, a=a)], check=True)
    tr = json.load(open(path, encoding='utf-8'))['verse']['translations']
    if len(tr) != 1 or tr[0]['resource_id'] != 55:
        raise SystemExit(f'no Muhammad Sodiq translation for {s}:{a}')
    text = re.sub(r'<sup[^>]*>.*?</sup>', '', tr[0]['text'])
    if '<' in text:
        raise SystemExit(f'unexpected markup in {s}:{a}: {text}')
    # the site writes oʻ/gʻ with a backtick and the tutuq belgisi with an apostrophe
    text = text.replace('`', 'ʻ').replace("'", 'ʼ')
    return ' '.join(text.split())


def export(out, www, cache=None):
    """Writes the dua list for the app: www/duas.js."""
    manifest = json.load(open(os.path.join(out, 'duolar.json'), encoding='utf-8'))
    order = [d[0] for d in DUAS]
    if [m['id'] for m in manifest] != order:
        raise SystemExit('duolar.json does not match DUAS; cut the audio again first')
    duas = [{'id': m['id'], 'g': 0 if i < RABBANA_COUNT else 1, 's': m['s'], 'a': m['a'],
             'uz': m['uz'], 'ar': m['ar'], 'dur': m['dur'], 'size': m['size']}
            for i, m in enumerate(manifest)]
    if cache:
        os.makedirs(cache, exist_ok=True)
        for d in duas:
            d['m'] = [meaning(d['s'], a, cache) for a in range(d['a'][0], d['a'][1] + 1)]
    with open(os.path.join(www, 'duas.js'), 'w', encoding='utf-8') as f:
        f.write(f'// meanings (m): {MEANING_SOURCE}, quran.com\n')
        f.write('window.DUAS = ')
        json.dump(duas, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print(f'{len(duas)} duas -> {os.path.join(www, "duas.js")}')


def main():
    if sys.argv[1] == '--export':
        # optional 4th argument: a cache folder; with it the Uzbek meanings are added
        export(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
        return
    cache, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    src = Source(cache)
    clips = [cut_dua(src, dua) for dua in DUAS]

    # the ayahs were recorded at different levels: bring every dua to the same
    # loudness with one fixed gain each (at most 6 dB, never into clipping)
    levels = [speech_level(samples) for samples, _, _ in clips]
    target = float(np.median(levels))

    manifest, unverified = [], []
    for dua, (samples, text, info), level in zip(DUAS, clips, levels):
        did, s, a1, a2, first, last, title = dua
        gain = 10 ** (float(np.clip(target - level, -6, 6)) / 20)
        gain = min(gain, 0.89 * 32768 / max(1, int(np.abs(samples).max())))
        samples = np.round(samples * gain).astype(np.int16)
        ref = f'{s}:{a1}' + (f'–{a2}' if a2 != a1 else '')
        path = os.path.join(out, did + '.mp3')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 's16le', '-ar', str(RATE), '-ac', '2', '-i', '-',
                        '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3',
                        '-metadata', f'title=Duo {ref}', '-metadata', 'artist=Mahmud Xalil al-Husariy',
                        '-metadata', 'album=Muallim Qurʼon: duolar', path],
                       input=samples.tobytes(), check=True)
        dur = round(len(samples) / RATE, 2)
        manifest.append({'id': did, 'file': did + '.mp3', 's': s, 'a': [a1, a2],
                         'w': [info['ayahs'][0]['w'][0], info['ayahs'][-1]['w'][1]],
                         'uz': title, 'ar': ' '.join(text.replace('۞', ' ').split()),
                         'dur': dur, 'size': os.path.getsize(path)})
        note = f' {20 * np.log10(gain):+.1f} dB'
        for edge in ('start', 'end'):
            if edge in info:
                how, want, got, detail = info[edge]
                note += f' {edge}[{how}] {want}→{got}s ({(got - want) * 1000:+.0f} ms){detail}'
                if how == 'UNVERIFIED':
                    unverified.append(did)
        bad = [x for x in info['ayahs'] if x['of'] != x['aligned']]
        if bad:
            note += f' WORD COUNT MISMATCH {bad}'
        print(f'{did} {ref:10s} {dur:6.2f}s{note}')
    with open(os.path.join(out, 'duolar.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    write_page(out, manifest)
    total = sum(m['size'] for m in manifest)
    print(f'{len(manifest)} duas, {sum(m["dur"] for m in manifest) / 60:.1f} min, {total / 1048576:.1f} MB')
    if unverified:
        raise SystemExit(f'cut by rough timing only, add MANUAL entries: {", ".join(unverified)}')


if __name__ == '__main__':
    main()
