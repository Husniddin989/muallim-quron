"""Builds the app's assets from the source mushaf PDF and surah recitations.

For every configured mushaf page it extracts the page image, finds the ayah-end
markers by template matching and turns them into tappable ayah regions.  Every
surah recitation is split into one file per ayah at the pauses between ayahs.

Usage (needs numpy, scipy, pillow, plus pdfimages and ffmpeg on PATH):
    python prepare.py <source_dir> <assets_www_dir> [debug_dir]
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw
from scipy.signal import fftconvolve

HERE = os.path.dirname(os.path.abspath(__file__))
PDF_NAME = 'مصحف التجويد الجديد.pdf'
PDF_PAGE_OFFSET = 1  # PDF page = mushaf page + 1 (the PDF starts with a cover)

# number: (arabic name, uzbek name, ayah count)
SURAHS = {
    89: ('الفجر', 'Fajr', 30),
    90: ('البلد', 'Balad', 20),
    91: ('الشمس', 'Shams', 15),
    92: ('الليل', 'Layl', 21),
    93: ('الضحى', 'Zuho', 11),
    94: ('الشرح', 'Sharh', 8),
    95: ('التين', 'Tiyn', 8),
    96: ('العلق', 'Alaq', 19),
    97: ('القدر', 'Qadr', 5),
    98: ('البينة', 'Bayyina', 8),
    99: ('الزلزلة', 'Zalzala', 8),
    100: ('العاديات', 'Odiyot', 11),
    101: ('القارعة', 'Qoriʼa', 11),
    102: ('التكاثر', 'Takosur', 8),
    103: ('العصر', 'Asr', 3),
    104: ('الهمزة', 'Humaza', 9),
    105: ('الفيل', 'Fil', 5),
    106: ('قريش', 'Quraysh', 4),
    107: ('الماعون', 'Moʻun', 7),
    108: ('الكوثر', 'Kavsar', 3),
    109: ('الكافرون', 'Kofirun', 6),
    110: ('النصر', 'Nasr', 3),
    111: ('المسد', 'Masad', 5),
    112: ('الإخلاص', 'Ixlos', 4),
    113: ('الفلق', 'Falaq', 5),
    114: ('الناس', 'Nos', 6),
}

# mushaf page -> (surah, ayah) the page starts with.  Ayah 0 means the page
# starts with the surah's basmala (its header is the last line of the page before).
PAGES = {
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

LINES = 15
LINE_PITCH = 60.2
FIRST_LINE_CENTER = 77.5
# Normalized correlation with the marker outline: true markers score >= 0.55,
# everything else on these pages <= 0.38.
MARKER_THRESHOLD = 0.47
# markers are drawn at slightly different sizes: (x scale, y scale)
MARKER_SCALES = [(1, 1), (1, 1.1), (1, 1.2), (1.1, 1.1), (1.1, 1.2), (0.95, 1.0)]


def line_center(k):
    return FIRST_LINE_CENTER + k * LINE_PITCH


def marker_scores(page_img, template):
    """Best normalized cross-correlation over MARKER_SCALES, indexed by marker center."""
    I = np.asarray(page_img.convert('L'), dtype=np.float64)
    best = np.full(I.shape, -1.0)

    def corr(a, k):
        return fftconvolve(a, k[::-1, ::-1], mode='valid')

    for sx, sy in MARKER_SCALES:
        tw, th = round(template.width * sx), round(template.height * sy)
        T = np.asarray(template.convert('L').resize((tw, th), Image.BILINEAR), dtype=np.float64)
        M = np.ones_like(T)
        M[round(11 * sy):round(30 * sy), round(10 * sx):round(34 * sx)] = 0  # digits differ
        n = M.sum()
        Tc = (T - (T * M).sum() / n) * M
        S1, S2, S3 = corr(I, M), corr(I * I, M), corr(I, Tc)
        score = S3 / (np.sqrt((Tc ** 2).sum()) * np.sqrt(np.maximum(S2 - S1 * S1 / n, 1e-6)))
        view = best[th // 2:th // 2 + score.shape[0], tw // 2:tw // 2 + score.shape[1]]
        np.maximum(view, score, out=view)
    return best


def find_markers(page_img, template):
    score = marker_scores(page_img, template)
    tw, th = template.size
    found = []
    while True:
        cy, cx = np.unravel_index(np.argmax(score), score.shape)
        if score[cy, cx] < MARKER_THRESHOLD:
            break
        line = int(round((cy - FIRST_LINE_CENTER) / LINE_PITCH))
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


def page_regions(page, img, template):
    """Tappable regions of one page, walked in reading order.

    Returns the regions and the (surah, ayah) the next page should start with.
    """
    markers = find_markers(img, template)
    headers = header_lines(img)
    L, R = text_bounds(img)
    surah, ayah = PAGES[page]
    regions = []

    def rect(line, x0, x1):
        c = line_center(line)
        return [int(x0), int(c - LINE_PITCH / 2), int(x1 - x0), int(LINE_PITCH)]

    def basmala(line):
        regions.append({'s': surah, 'a': 0, 'r': [rect(line, L, R)]})

    skip = set()  # header and basmala lines carry no ayah markers
    pos = (0, R)  # (line, x) where the current ayah starts
    if ayah == 0:
        basmala(0)
        skip.add(0)
        ayah, pos = 1, (1, R)

    for k in range(LINES):
        if k in headers:
            if k > 0:
                if ayah - 1 != SURAHS[surah][2]:
                    raise SystemExit(f'page {page}: surah {surah} ends at ayah {ayah - 1}, '
                                     f'expected {SURAHS[surah][2]}')
                surah, ayah = surah + 1, 1
            regions.append({'s': surah, 'a': -1, 'r': [rect(k, L, R)]})
            skip.add(k)
            if k + 1 < LINES:
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

    if ayah == SURAHS[surah][2] + 1:
        surah, ayah = surah + 1, 1
    return regions, markers, (surah, ayah)


def silences(path):
    out = subprocess.run(
        ['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af',
         'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-'],
        capture_output=True, text=True).stderr
    starts = [float(v) for v in re.findall(r'silence_start: ([\d.]+)', out)]
    ends = [float(v) for v in re.findall(r'silence_end: ([\d.]+)', out)]
    return list(zip(starts, ends))


def duration(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'csv=p=0', path], capture_output=True, text=True).stdout
    return float(out)


def group_into_ayahs(surah, chunks, ref):
    """Merges speech chunks (start, speech_end, pause_end) so there is one per ayah.

    The reciter sometimes pauses inside a long ayah; the reference durations
    decide which pauses those are (least-squares over all contiguous groupings).
    """
    n = SURAHS[surah][2]
    if len(chunks) == n:
        groups = [[c] for c in chunks]
    elif len(chunks) > n and ref:
        INF = float('inf')
        m = len(chunks)
        best = [[INF] * (n + 1) for _ in range(m + 1)]
        back = [[0] * (n + 1) for _ in range(m + 1)]
        best[0][0] = 0
        for i in range(1, m + 1):
            for j in range(1, min(i, n) + 1):
                for s in range(j - 1, i):
                    if best[s][j - 1] == INF:
                        continue
                    span = chunks[i - 1][1] - chunks[s][0] + REF_GAP
                    c = best[s][j - 1] + (span - ref[j - 1]) ** 2
                    if c < best[i][j]:
                        best[i][j], back[i][j] = c, s
        groups, i = [], m
        for j in range(n, 0, -1):
            s = back[i][j]
            groups.insert(0, chunks[s:i])
            i = s
    else:
        raise SystemExit(f'surah {surah}: {len(chunks)} recitation chunks for {n} ayahs '
                         f'and no reference durations to group them')

    merged = [(g[0][0], g[-1][1], g[-1][2]) for g in groups]
    if ref:
        for a, (s, e, _) in enumerate(merged, 1):
            if abs(e - s + REF_GAP - ref[a - 1]) > max(3.0, 0.25 * ref[a - 1]):
                print(f'  warning: {surah}:{a} lasts {e - s:.1f}s, reference {ref[a - 1]:.1f}s')
    return merged, [len(g) for g in groups]


def split_audio(surah, src, dst_dir, refs):
    dur = duration(src)
    # speech chunks between the pauses; the last pause runs to the end of the file
    chunks, t = [], 0.0
    for s, e in silences(src):
        chunks.append((t, s, e))  # speech from t to s, followed by a pause until e
        t = e
    if dur - t > 0.3:
        chunks.append((t, dur, dur))
    # chunk 0 is the basmala
    ayahs, sizes = group_into_ayahs(surah, chunks[1:], refs.get(str(surah)))
    parts = [chunks[0]] + ayahs

    os.makedirs(dst_dir, exist_ok=True)
    durations = []
    for i, (start, speech_end, pause_end) in enumerate(parts):
        a = 0.0 if i == 0 else (start + parts[i - 1][1]) / 2
        last = i == len(parts) - 1
        b = min(speech_end + 0.8, dur) if last else (speech_end + pause_end) / 2
        out = os.path.join(dst_dir, f'{i:03d}.mp3')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{a:.3f}', '-to', f'{b:.3f}',
                        '-i', src, '-map', '0:a', '-c', 'copy', out], check=True)
        durations.append(round(b - a, 2))
    merged = [f'{a}' for a, k in enumerate(sizes, 1) if k > 1]
    note = f' (ayahs read with an inner pause: {", ".join(merged)})' if merged else ''
    print(f'surah {surah}: {len(parts)} audio files{note}')
    return durations


def main():
    src, www = sys.argv[1], sys.argv[2]
    debug = sys.argv[3] if len(sys.argv) > 3 else None
    template = Image.open(os.path.join(HERE, 'marker_template.png'))
    refs = json.load(open(REF_DURATIONS)) if os.path.exists(REF_DURATIONS) else {}
    os.makedirs(os.path.join(www, 'pages'), exist_ok=True)

    pages = {}
    with tempfile.TemporaryDirectory() as tmp:
        for page in sorted(PAGES):
            pdf_page = str(page + PDF_PAGE_OFFSET)
            subprocess.run(['pdfimages', '-f', pdf_page, '-l', pdf_page, '-png',
                            os.path.join(src, PDF_NAME), os.path.join(tmp, f'p{page}')],
                           check=True)
            img = Image.open(os.path.join(tmp, f'p{page}-000.png')).convert('RGB')
            regions, markers, next_start = page_regions(page, img, template)
            if page + 1 in PAGES and PAGES[page + 1] != next_start:
                raise SystemExit(f'page {page} ends before {next_start}, '
                                 f'but page {page + 1} is set to start at {PAGES[page + 1]}')
            img.save(os.path.join(www, 'pages', f'{page}.webp'), lossless=True, quality=100)
            pages[page] = {'w': img.width, 'h': img.height, 'regions': regions}
            print(f'page {page}: {len(markers)} markers, {len(regions)} regions')
            if debug:
                os.makedirs(debug, exist_ok=True)
                d = ImageDraw.Draw(img, 'RGBA')
                for i, reg in enumerate(regions):
                    color = [(255, 0, 0, 60), (0, 0, 255, 60), (0, 160, 0, 60)][i % 3]
                    for x, y, w, h in reg['r']:
                        d.rectangle((x, y, x + w, y + h), fill=color, outline=color[:3])
                    x, y, w, h = reg['r'][-1]
                    d.text((x + 2, y + 2), f"{reg['s']}:{reg['a']}", fill=(0, 0, 0))
                img.save(os.path.join(debug, f'regions-{page}.png'))

    surahs = []
    for n, (ar, uz, count) in sorted(SURAHS.items()):
        on = [p for p in sorted(pages) if any(r['s'] == n for r in pages[p]['regions'])]
        if not on:
            continue
        # the page with ayah 1 (a surah header can sit alone at the end of the page before)
        first = [p for p in on if any(r['s'] == n and r['a'] == 1 for r in pages[p]['regions'])]
        entry = {'n': n, 'ar': ar, 'uz': uz, 'ayahs': count, 'page': (first or on)[0]}
        mp3 = os.path.join(src, f'{n:03d}.mp3')
        if os.path.exists(mp3):
            entry['durations'] = split_audio(n, mp3, os.path.join(www, 'audio', str(n)), refs)
        surahs.append(entry)

    with open(os.path.join(www, 'data.js'), 'w', encoding='utf-8') as f:
        f.write('window.QURAN = ')
        json.dump({'surahs': surahs, 'pages': pages}, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


if __name__ == '__main__':
    main()
