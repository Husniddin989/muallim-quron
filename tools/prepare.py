"""Builds the app's assets from the source mushaf PDF and surah recitations.

For every mushaf page it extracts the page image, finds the ayah-end markers by
template matching and turns them into tappable ayah regions.  For every surah
recitation it finds where the basmala and each ayah start and end, so the app
can play one ayah out of the whole-surah file (which is served from Cloudflare
R2, not bundled).

Usage (needs numpy, scipy, pillow, plus pdfimages and ffmpeg on PATH):
    python prepare.py <source_dir> <assets_www_dir> [debug_dir]
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
PDF_NAME = 'مصحف التجويد الجديد.pdf'
PDF_PAGE_OFFSET = 1  # PDF page = mushaf page + 1 (the PDF starts with a cover)

# (arabic name, uzbek name, ayah count) for surah 1..114
SURAH_LIST = [
    ('الفاتحة', 'Fotiha', 7), ('البقرة', 'Baqara', 286), ('آل عمران', 'Oli Imron', 200),
    ('النساء', 'Niso', 176), ('المائدة', 'Moida', 120), ('الأنعام', 'Anʼom', 165),
    ('الأعراف', 'Aʼrof', 206), ('الأنفال', 'Anfol', 75), ('التوبة', 'Tavba', 129),
    ('يونس', 'Yunus', 109), ('هود', 'Hud', 123), ('يوسف', 'Yusuf', 111),
    ('الرعد', 'Raʼd', 43), ('إبراهيم', 'Ibrohim', 52), ('الحجر', 'Hijr', 99),
    ('النحل', 'Nahl', 128), ('الإسراء', 'Isro', 111), ('الكهف', 'Kahf', 110),
    ('مريم', 'Maryam', 98), ('طه', 'Toha', 135), ('الأنبياء', 'Anbiyo', 112),
    ('الحج', 'Haj', 78), ('المؤمنون', 'Moʻminun', 118), ('النور', 'Nur', 64),
    ('الفرقان', 'Furqon', 77), ('الشعراء', 'Shuaro', 227), ('النمل', 'Naml', 93),
    ('القصص', 'Qasas', 88), ('العنكبوت', 'Ankabut', 69), ('الروم', 'Rum', 60),
    ('لقمان', 'Luqmon', 34), ('السجدة', 'Sajda', 30), ('الأحزاب', 'Ahzob', 73),
    ('سبأ', 'Saba', 54), ('فاطر', 'Fotir', 45), ('يس', 'Yosin', 83),
    ('الصافات', 'Soffot', 182), ('ص', 'Sod', 88), ('الزمر', 'Zumar', 75),
    ('غافر', 'Gʻofir', 85), ('فصلت', 'Fussilat', 54), ('الشورى', 'Shuro', 53),
    ('الزخرف', 'Zuxruf', 89), ('الدخان', 'Duxon', 59), ('الجاثية', 'Josiya', 37),
    ('الأحقاف', 'Ahqof', 35), ('محمد', 'Muhammad', 38), ('الفتح', 'Fath', 29),
    ('الحجرات', 'Hujurot', 18), ('ق', 'Qof', 45), ('الذاريات', 'Zoriyot', 60),
    ('الطور', 'Tur', 49), ('النجم', 'Najm', 62), ('القمر', 'Qamar', 55),
    ('الرحمن', 'Rahmon', 78), ('الواقعة', 'Voqiʼa', 96), ('الحديد', 'Hadid', 29),
    ('المجادلة', 'Mujodala', 22), ('الحشر', 'Hashr', 24), ('الممتحنة', 'Mumtahana', 13),
    ('الصف', 'Saff', 14), ('الجمعة', 'Jumʼa', 11), ('المنافقون', 'Munofiqun', 11),
    ('التغابن', 'Tagʻobun', 18), ('الطلاق', 'Taloq', 12), ('التحريم', 'Tahrim', 12),
    ('الملك', 'Mulk', 30), ('القلم', 'Qalam', 52), ('الحاقة', 'Hoqqa', 52),
    ('المعارج', 'Maʼorij', 44), ('نوح', 'Nuh', 28), ('الجن', 'Jin', 28),
    ('المزمل', 'Muzzammil', 20), ('المدثر', 'Muddassir', 56), ('القيامة', 'Qiyomat', 40),
    ('الإنسان', 'Inson', 31), ('المرسلات', 'Mursalot', 50), ('النبأ', 'Naba', 40),
    ('النازعات', 'Noziʼot', 46), ('عبس', 'Abasa', 42), ('التكوير', 'Takvir', 29),
    ('الانفطار', 'Infitor', 19), ('المطففين', 'Mutaffifin', 36), ('الانشقاق', 'Inshiqoq', 25),
    ('البروج', 'Buruj', 22), ('الطارق', 'Toriq', 17), ('الأعلى', 'Aʼlo', 19),
    ('الغاشية', 'Gʻoshiya', 26), ('الفجر', 'Fajr', 30), ('البلد', 'Balad', 20),
    ('الشمس', 'Shams', 15), ('الليل', 'Layl', 21), ('الضحى', 'Zuho', 11),
    ('الشرح', 'Sharh', 8), ('التين', 'Tiyn', 8), ('العلق', 'Alaq', 19),
    ('القدر', 'Qadr', 5), ('البينة', 'Bayyina', 8), ('الزلزلة', 'Zalzala', 8),
    ('العاديات', 'Odiyot', 11), ('القارعة', 'Qoriʼa', 11), ('التكاثر', 'Takosur', 8),
    ('العصر', 'Asr', 3), ('الهمزة', 'Humaza', 9), ('الفيل', 'Fil', 5),
    ('قريش', 'Quraysh', 4), ('الماعون', 'Moʻun', 7), ('الكوثر', 'Kavsar', 3),
    ('الكافرون', 'Kofirun', 6), ('النصر', 'Nasr', 3), ('المسد', 'Masad', 5),
    ('الإخلاص', 'Ixlos', 4), ('الفلق', 'Falaq', 5), ('الناس', 'Nos', 6),
]
SURAHS = {n: v for n, v in enumerate(SURAH_LIST, 1)}
# al-Fatiha's basmala is its first ayah; at-Tawba has none
NO_BASMALA = (1, 9)

FIRST_PAGE, LAST_PAGE = 1, 604

# mushaf page -> (surah, ayah) the page starts with.  Ayah 0 means the page
# starts with the surah's basmala (its header is the last line of the page before).
# Pages not listed continue from where the page before ended; the listed ones
# check that the ayah markers were counted right up to there.
PAGES = {
    1: (1, 1),
    568: (69, 35),
    594: (89, 24),
    595: (91, 0),
    596: (92, 15),
    597: (95, 1),
    598: (97, 1),
    599: (98, 8),
    600: (100, 10),
    601: (103, 1),
    602: (106, 1),
    603: (109, 1),
    604: (112, 1),
}

# Husary per-ayah durations (seconds) from the same recording, used to decide
# which pauses inside a recitation are ayah ends and which are pauses inside
# a long ayah.  Reference files carry about REF_GAP s more silence than speech.
REF_DURATIONS = os.path.join(HERE, 'husary_ayah_durations.json')
REF_GAP = 1.6
# Husary's basmala at the start of a surah, same measure as REF_DURATIONS; some
# recordings open with the isti'adha before it, so anything in this range fits
BASMALA_RANGE = (6.0, 16.0)
# Shortest pause looked at: the reciter joins some ayahs with only a brief breath.
MIN_PAUSE = 0.2
# Loudness below which a pause counts as silence, tried in turn while the result
# still disagrees with the reference: some recordings have a louder noise floor.
NOISE_LEVELS = (-35, -30, -26)
# Cost (s^2) of ending an ayah at a pause shorter than 0.6 s, per second missing.
SHORT_PAUSE_COST = 4.0
MAX_CHUNKS_PER_AYAH = 40
# Cost (s^2) of treating one stretch of speech as two ayahs read without any pause.
FUSED_COST = 20.0

# Regular pages: 15 lines on a fixed grid.
LINES = 15
LINE_PITCH = 60.2
FIRST_LINE_CENTER = 77.5
# Normalized correlation with the marker outline: true markers score >= 0.55,
# everything else on these pages <= 0.38.
MARKER_THRESHOLD = 0.47
# markers are drawn at slightly different sizes: (x scale, y scale)
MARKER_SCALES = [(1, 1), (1, 1.1), (1, 1.2), (1.1, 1.1), (1.1, 1.2), (0.95, 1.0)]

# Two ayah markers in the whole mushaf are squeezed so narrow (or touch a letter)
# that template matching misses them: page -> [(marker center x, line index)]
MANUAL_MARKERS = {
    229: [(91, 11)],   # Hud 69
    455: [(544, 4)],   # Sad 29
}

# The two opening pages sit in an ornamental frame: 8 wider-spaced lines and
# small gold ayah markers.
OPENING_PAGES = {
    1: {'centers': [202, 273, 353, 431, 513, 588, 669, 743], 'bounds': (161, 594)},
    2: {'centers': [204, 280, 362, 440, 521, 597, 677, 753], 'bounds': (186, 618)},
}
OPENING_PITCH = 78
OPENING_THRESHOLD = 0.7
OPENING_SCALES = [(s, s) for s in (1.0, 1.1, 1.2, 1.25)]


def line_center(k):
    return FIRST_LINE_CENTER + k * LINE_PITCH


def marker_scores(page_img, template, scales, mask_digits):
    """Best normalized cross-correlation over `scales`, indexed by marker center."""
    I = np.asarray(page_img.convert('L'), dtype=np.float64)
    best = np.full(I.shape, -1.0)

    def corr(a, k):
        return fftconvolve(a, k[::-1, ::-1], mode='valid')

    for sx, sy in scales:
        tw, th = round(template.width * sx), round(template.height * sy)
        T = np.asarray(template.convert('L').resize((tw, th), Image.BILINEAR), dtype=np.float64)
        M = np.ones_like(T)
        if mask_digits:
            M[round(11 * sy):round(30 * sy), round(10 * sx):round(34 * sx)] = 0  # digits differ
        n = M.sum()
        Tc = (T - (T * M).sum() / n) * M
        S1, S2, S3 = corr(I, M), corr(I * I, M), corr(I, Tc)
        score = S3 / (np.sqrt((Tc ** 2).sum()) * np.sqrt(np.maximum(S2 - S1 * S1 / n, 1e-6)))
        view = best[th // 2:th // 2 + score.shape[0], tw // 2:tw // 2 + score.shape[1]]
        np.maximum(view, score, out=view)
    return best


def find_markers(page_img, template, centers, scales=MARKER_SCALES, threshold=MARKER_THRESHOLD,
                 mask_digits=True):
    score = marker_scores(page_img, template, scales, mask_digits)
    tw, th = template.size
    found = []
    while True:
        cy, cx = np.unravel_index(np.argmax(score), score.shape)
        if score[cy, cx] < threshold:
            break
        line = int(np.argmin([abs(cy - c) for c in centers]))
        found.append({'x': int(cx - tw // 2), 'y': int(cy - th // 2), 'w': tw, 'h': th, 'line': line})
        score[max(0, cy - 20):cy + 20, max(0, cx - 20):cx + 20] = -9
    return sorted(found, key=lambda m: (m['line'], -m['x']))


def header_lines(page_img):
    a = np.asarray(page_img.convert('RGB')).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    green = (g > r + 40) & (g > b + 10) & (g < 200)
    out = []
    for k in range(LINES):
        c = line_center(k)
        if green[int(c - 25):int(c + 25)].mean() > 0.1:
            out.append(k)
    return out


def text_bounds(page_img):
    """Left/right x of the white text area inside the page frame."""
    a = np.asarray(page_img.convert('RGB')).astype(int)
    col = (a.min(2) > 235)[100:950].mean(0) > 0.5
    best, start = (0, 0), None
    for x, v in enumerate(list(col) + [False]):
        if v and start is None:
            start = x
        elif not v and start is not None:
            if x - start > best[1] - best[0]:
                best = (start, x - 1)
            start = None
    return best[0] + 2, best[1] - 2


def analyze_page(job):
    """Extracts one page and finds its layout: lines, headers, text bounds and markers."""
    page, pdf, www = job
    with tempfile.TemporaryDirectory() as tmp:
        pdf_page = str(page + PDF_PAGE_OFFSET)
        subprocess.run(['pdfimages', '-f', pdf_page, '-l', pdf_page, '-png', pdf,
                        os.path.join(tmp, 'p')], check=True)
        img = Image.open(os.path.join(tmp, 'p-000.png')).convert('RGB')
    if page in OPENING_PAGES:
        lay = OPENING_PAGES[page]
        template = Image.open(os.path.join(HERE, 'marker_template_opening.png'))
        centers, pitch, headers, bounds = lay['centers'], OPENING_PITCH, [0], lay['bounds']
        markers = find_markers(img, template, centers, OPENING_SCALES, OPENING_THRESHOLD, False)
        # the source is a photo-like JPEG here: lossy keeps it small
        img.save(os.path.join(www, 'pages', f'{page}.webp'), quality=85, method=6)
    else:
        template = Image.open(os.path.join(HERE, 'marker_template.png'))
        centers = [line_center(k) for k in range(LINES)]
        pitch, headers, bounds = LINE_PITCH, header_lines(img), text_bounds(img)
        markers = find_markers(img, template, centers)
        img.save(os.path.join(www, 'pages', f'{page}.webp'), lossless=True, quality=100, method=6)
    return {'page': page, 'w': img.width, 'h': img.height, 'centers': centers, 'pitch': pitch,
            'headers': headers, 'bounds': bounds, 'markers': markers}


def page_regions(lay, start):
    """Tappable regions of one page, walked in reading order from `start`.

    Returns the regions and the (surah, ayah) the next page should start with.
    """
    page, centers, pitch = lay['page'], lay['centers'], lay['pitch']
    headers = lay['headers']
    markers = sorted(lay['markers'] + [{'x': cx - 21, 'line': line} for cx, line in MANUAL_MARKERS.get(page, [])],
                     key=lambda m: (m['line'], -m['x']))
    L, R = lay['bounds']
    lines = len(centers)
    surah, ayah = start
    regions = []

    def rect(line, x0, x1):
        c = centers[line]
        return [int(x0), int(c - pitch / 2), int(x1 - x0), int(pitch)]

    def basmala(line):
        regions.append({'s': surah, 'a': 0, 'r': [rect(line, L, R)]})

    skip = set()  # header and basmala lines carry no ayah markers
    pos = (0, R)  # (line, x) where the current ayah starts
    if ayah == 0:
        basmala(0)
        skip.add(0)
        ayah, pos = 1, (1, R)

    for k in range(lines):
        if k in headers:
            if k > 0:
                if ayah - 1 != SURAHS[surah][2]:
                    raise SystemExit(f'page {page}: surah {surah} ends at ayah {ayah - 1}, '
                                     f'expected {SURAHS[surah][2]}')
                surah, ayah = surah + 1, 1
            regions.append({'s': surah, 'a': -1, 'r': [rect(k, L, R)]})
            skip.add(k)
            if surah in NO_BASMALA:
                pos = (k + 1, R)
            elif k + 1 < lines:
                basmala(k + 1)
                skip.add(k + 1)
                pos = (k + 2, R)
            else:
                ayah = 0  # the basmala is on the next page
            continue
        if k in skip:
            continue
        for m in (m for m in markers if m['line'] == k):
            ls, xs = pos
            rects = []
            for line in range(ls, k + 1):
                x1 = xs if line == ls else R
                x0 = m['x'] if line == k else L
                if x1 - x0 > 12:
                    rects.append(rect(line, x0, x1))
            regions.append({'s': surah, 'a': ayah, 'r': rects})
            ayah += 1
            pos = (k, m['x']) if m['x'] - L > 15 else (k + 1, R)

    # an ayah that runs on to the next page: its beginning here is tappable too
    ls, xs = pos
    if 1 <= ayah <= SURAHS[surah][2] and ls < lines:
        rects = [rect(line, L, xs if line == ls else R) for line in range(ls, lines)
                 if line not in skip and (xs if line == ls else R) - L > 12]
        if rects:
            regions.append({'s': surah, 'a': ayah, 'r': rects})

    if ayah == SURAHS[surah][2] + 1:
        surah, ayah = surah + 1, 1
    return regions, (surah, ayah)


def silences(path, min_pause, noise):
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af',
         f'silencedetect=noise={noise}dB:d={min_pause}', '-f', 'null', '-'],
        capture_output=True, text=True).stderr
    starts = [float(v) for v in re.findall(r'silence_start: ([\d.]+)', out)]
    ends = [float(v) for v in re.findall(r'silence_end: ([\d.]+)', out)]
    return list(zip(starts, ends))


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    return float(out)


def spans_needed(surah):
    """Basmala plus ayahs, or just the ayahs for al-Fatiha and at-Tawba."""
    return SURAHS[surah][2] + (0 if surah in NO_BASMALA else 1)


def quietest_point(src, start, end, guess):
    """The quietest 50 ms in [start, end] near `guess` (seconds): where two ayahs
    read without a pause meet."""
    lo, hi = max(start, guess - 2.0), min(end, guess + 2.0)
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-ss', f'{lo:.3f}', '-to', f'{hi:.3f}', '-i', src,
         '-af', 'asetnsamples=2205,astats=metadata=1:reset=1,'
                'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
         '-f', 'null', '-'], capture_output=True, text=True).stdout
    times = [float(v) for v in re.findall(r'pts_time:([\d.]+)', out)]
    levels = [float(v) if v not in ('-inf', 'inf') else -200.0
              for v in re.findall(r'RMS_level=(\S+)', out)]
    if not times or len(times) != len(levels):
        return guess
    # prefer quiet frames close to the guess
    best = min(range(len(times)), key=lambda i: levels[i] + 3.0 * abs(lo + times[i] - guess))
    return lo + times[best] + 0.025


def group_into_ayahs(surah, chunks, ref, src=None):
    """Merges speech chunks (start, speech_end, pause_end) so there is one per
    ayah, with the basmala first.

    The reciter sometimes pauses inside a long ayah, and now and then joins two
    ayahs without any pause; the reference durations decide which is which
    (least squares over all contiguous groupings).
    """
    n = spans_needed(surah)
    warnings = []
    lo, hi = BASMALA_RANGE
    if ref and surah not in NO_BASMALA:
        ref = [(lo + hi) / 2] + ref

    def fit(span, j):
        """Squared mismatch of a stretch of `span` seconds of speech as span j."""
        x = span + REF_GAP
        if j == 1 and surah not in NO_BASMALA:
            return max(0.0, lo - x, x - hi) ** 2
        return (x - ref[j - 1]) ** 2
    if not ref and len(chunks) == n:
        groups = [[c] for c in chunks]
    elif ref:
        INF = float('inf')
        m = len(chunks)
        best = [[INF] * (n + 1) for _ in range(m + 1)]
        back = [[None] * (n + 1) for _ in range(m + 1)]
        best[0][0] = 0
        for i in range(1, m + 1):
            pause = chunks[i - 1][2] - chunks[i - 1][1]
            # every chunk holds at most two ayahs
            for j in range(max(1, n - 2 * (m - i)), min(n, 2 * i) + 1):
                short = SHORT_PAUSE_COST * max(0.0, 0.6 - pause) if j < n else 0.0
                for s in range(max(0, i - MAX_CHUNKS_PER_AYAH), i):
                    span = chunks[i - 1][1] - chunks[s][0]
                    # chunks s..i-1 are ayah j
                    if best[s][j - 1] < INF:
                        c = best[s][j - 1] + fit(span, j) + short
                        if c < best[i][j]:
                            best[i][j], back[i][j] = c, (s, 1)
                    # ... or ayahs j-1 and j, read without a pause between them
                    if j >= 2 and best[s][j - 2] < INF:
                        c = (best[s][j - 2] + (span + 2 * REF_GAP - ref[j - 2] - ref[j - 1]) ** 2
                             + FUSED_COST + short)
                        if c < best[i][j]:
                            best[i][j], back[i][j] = c, (s, 2)
        if best[m][n] == INF:
            raise SystemExit(f'surah {surah}: could not match {m} recitation chunks to {n} spans')
        groups, i, j = [], m, n
        while j > 0:
            s, k = back[i][j]
            if k == 1:
                groups.insert(0, chunks[s:i])
            else:
                start, end = chunks[s][0], chunks[i - 1][1]
                guess = start + (end - start) * (ref[j - 2] / (ref[j - 2] + ref[j - 1]))
                cut = quietest_point(src, start, end, guess) if src else guess
                groups.insert(0, [(cut, chunks[i - 1][1], chunks[i - 1][2])])
                groups.insert(0, [(start, cut, cut)])
                warnings.append(f'{surah}:{j - (0 if surah in NO_BASMALA else 1)} follows the ayah '
                                f'before without a pause; split at {cut:.1f}s')
            i, j = s, j - k
    else:
        raise SystemExit(f'surah {surah}: {len(chunks)} recitation chunks for {n} spans '
                         f'and no reference durations to group them')

    merged = [(g[0][0], g[-1][1], g[-1][2]) for g in groups]
    if ref:
        first = 0 if surah in NO_BASMALA else 1
        for i, (s, e, _) in enumerate(merged):
            if fit(e - s, i + 1) > max(3.0, 0.25 * ref[i]) ** 2:
                warnings.append(f'{surah}:{i + 1 - first} lasts {e - s:.1f}s, reference {ref[i]:.1f}s')
    return merged, [len(g) for g in groups], warnings


def speech_chunks(src, dur, min_pause, noise=-35):
    """(start, speech_end, pause_end) for every stretch of speech between pauses."""
    chunks, t = [], 0.0
    for s, e in silences(src, min_pause, noise):
        if s - t < 0.15:
            # no real speech before this pause: silence at the start, or one longer pause
            if chunks:
                chunks[-1] = (chunks[-1][0], chunks[-1][1], e)
        else:
            chunks.append((t, s, e))
        t = e
    if dur - t > 0.3:
        chunks.append((t, dur, dur))
    return chunks


def ayah_times(job):
    """[start, end] seconds of the basmala and every ayah in the whole-surah file.

    Each span runs from the middle of the pause before it to the middle of the
    pause after it, so consecutive spans meet and playing on is seamless.
    """
    surah, src, ref = job
    dur = duration(src)
    best = None
    for noise in NOISE_LEVELS:
        chunks = speech_chunks(src, dur, MIN_PAUSE, noise)
        result = group_into_ayahs(surah, chunks, ref, src)
        warnings = result[2]
        mismatches = sum(1 for w in warnings if 'without a pause' not in w)
        badness = 3 * mismatches + len(warnings) - mismatches
        if best is None or badness < best[0]:
            best = (badness, noise, result)
        if not warnings or not ref:
            break
    _, noise, (parts, sizes, warnings) = best
    times = []
    for i, (start, speech_end, pause_end) in enumerate(parts):
        a = 0.0 if i == 0 else (start + parts[i - 1][1]) / 2
        last = i == len(parts) - 1
        b = min(speech_end + 0.8, dur) if last else (speech_end + pause_end) / 2
        times.append([round(a, 2), round(b, 2)])
    inner = sum(1 for k in sizes if k > 1)
    note = f', {inner} ayahs read with an inner pause' if inner else ''
    lines = [f'surah {surah}: {len(times)} spans, silence below {noise} dB{note}']
    lines += ['  warning: ' + w for w in warnings]
    return surah, times, '\n'.join(lines)


def main():
    src, www = sys.argv[1], sys.argv[2]
    debug = sys.argv[3] if len(sys.argv) > 3 else None
    refs = json.load(open(REF_DURATIONS)) if os.path.exists(REF_DURATIONS) else {}
    os.makedirs(os.path.join(www, 'pages'), exist_ok=True)
    pdf = os.path.join(src, PDF_NAME)

    # page analysis takes minutes; with a debug dir its result is kept for re-runs
    cache = os.path.join(debug, 'layouts.json') if debug else None
    if cache and os.path.exists(cache):
        layouts = json.load(open(cache))
    else:
        with ProcessPoolExecutor() as pool:
            layouts = list(pool.map(analyze_page, [(p, pdf, www) for p in range(FIRST_PAGE, LAST_PAGE + 1)],
                                    chunksize=4))
        if cache:
            os.makedirs(debug, exist_ok=True)
            json.dump(layouts, open(cache, 'w'))

    pages = {}
    start = PAGES[FIRST_PAGE]
    for lay in layouts:
        page = lay['page']
        if page in PAGES and PAGES[page] != start:
            raise SystemExit(f'page {page - 1} ends before {start}, '
                             f'but page {page} is set to start at {PAGES[page]}')
        regions, start = page_regions(lay, start)
        pages[page] = {'w': lay['w'], 'h': lay['h'], 'regions': regions}
        if debug and os.environ.get('DRAW_PAGES'):
            draw_debug(debug, www, page, regions)
    print(f'pages {FIRST_PAGE}-{LAST_PAGE}: {sum(len(p["regions"]) for p in pages.values())} regions')

    surahs, jobs = [], []
    for n, (ar, uz, count) in sorted(SURAHS.items()):
        on = [p for p in sorted(pages) if any(r['s'] == n for r in pages[p]['regions'])]
        if not on:
            continue
        # the page with ayah 1 (a surah header can sit alone at the end of the page before)
        first = [p for p in on if any(r['s'] == n and r['a'] == 1 for r in pages[p]['regions'])]
        entry = {'n': n, 'ar': ar, 'uz': uz, 'ayahs': count, 'page': (first or on)[0]}
        mp3 = os.path.join(src, f'{n:03d}.mp3')
        if os.path.exists(mp3):
            entry['size'] = os.path.getsize(mp3)
            jobs.append((n, mp3, refs.get(str(n))))
        surahs.append(entry)

    by_n = {s['n']: s for s in surahs}
    with ProcessPoolExecutor() as pool:
        for n, times, log in pool.map(ayah_times, jobs):
            by_n[n]['t'] = times
            print(log)

    with open(os.path.join(www, 'data.js'), 'w', encoding='utf-8') as f:
        f.write('window.QURAN = ')
        json.dump({'surahs': surahs, 'pages': pages}, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def draw_debug(debug, www, page, regions):
    os.makedirs(debug, exist_ok=True)
    img = Image.open(os.path.join(www, 'pages', f'{page}.webp')).convert('RGB')
    d = ImageDraw.Draw(img, 'RGBA')
    for i, reg in enumerate(regions):
        color = [(255, 0, 0, 60), (0, 0, 255, 60), (0, 160, 0, 60)][i % 3]
        for x, y, w, h in reg['r']:
            d.rectangle((x, y, x + w, y + h), fill=color, outline=color[:3])
        x, y, w, h = reg['r'][-1]
        d.text((x + 2, y + 2), f"{reg['s']}:{reg['a']}", fill=(0, 0, 0))
    img.save(os.path.join(debug, f'regions-{page}.png'))


if __name__ == '__main__':
    main()
