(function () {
  'use strict';

  var Q = window.QURAN;
  var $ = function (id) { return document.getElementById(id); };
  var native = window.Android || null;

  var bySurah = {};
  Q.surahs.forEach(function (s) { bySurah[s.n] = s; });
  var playable = Q.surahs.filter(function (s) { return s.durations; });
  var pageNums = Object.keys(Q.pages).map(Number).sort(function (a, b) { return a - b; });

  var MODES = { ayah: 'Bitta oyat', surah: 'Butun sura', all: 'Davomli' };
  var MODE_ORDER = ['ayah', 'surah', 'all'];
  var JUZ_START = [1, 22, 42, 62, 82, 102, 121, 142, 162, 182, 201, 222, 242, 262, 282,
    302, 322, 342, 362, 382, 402, 422, 442, 462, 482, 502, 522, 542, 562, 582];

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('tq.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('tq.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
    }
  };

  var state = {
    s: null,                 // selected surah
    a: null,                 // selected ayah (0 = basmala)
    mode: store.get('mode', 'ayah'),
    repeat: store.get('repeat', false),
    page: store.get('page', null),
    spread: false
  };
  if (!MODES[state.mode]) state.mode = 'ayah';
  var visible = {};          // page number -> true while it is on screen

  var audio = new Audio();
  audio.preload = 'auto';

  // ---------- helpers

  function pad(n) { return ('00' + n).slice(-3); }
  function audioUrl(s, a) { return 'audio/' + s + '/' + pad(a) + '.mp3'; }
  function firstIndex(s) { return bySurah[s].durations.length > bySurah[s].ayahs ? 0 : 1; }
  function lastIndex(s) { return bySurah[s].ayahs; }
  function key(s, a) { return s + ':' + a; }
  function juzOf(p) {
    var j = 0;
    while (j < JUZ_START.length && JUZ_START[j] <= p) j++;
    return j;
  }
  function readerOpen() { return !$('reader').classList.contains('hidden'); }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  function ayahLabel(s, a) {
    var name = bySurah[s].uz + ' surasi';
    return a === 0 ? name + ' · Bismillah' : name + ' · ' + a + '-oyat';
  }

  // ---------- surah list

  function renderList() {
    var ul = $('surahList');
    playable.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'surah';
      li.innerHTML =
        '<span class="num">' + s.n + '</span>' +
        '<span class="meta"><b>' + s.uz + '</b><small>' + s.ayahs + ' oyat · ' + s.page + '-bet</small></span>' +
        '<span class="ar">' + s.ar + '</span>' +
        '<button class="listen" aria-label="' + s.uz + ' surasini tinglash">' +
        '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>';
      li.addEventListener('click', function (e) {
        openReader(s.page);
        if (e.target.closest('.listen')) startSurah(s.n);
        else flash(key(s.n, -1));
      });
      ul.appendChild(li);
    });
    $('listLabel').textContent = playable.length + ' sura · ' + juzOf(pageNums[0]) + '-pora';

    $('playAll').addEventListener('click', function () {
      var s = playable[0];
      setMode('all');
      openReader(s.page);
      playAt(s.n, firstIndex(s.n));
    });
    $('resume').addEventListener('click', function () { openReader(state.page); });
    updateResume();
  }

  function updateResume() {
    var has = state.page && Q.pages[state.page];
    $('resume').classList.toggle('hidden', !has);
    if (has) $('resumeText').textContent = 'Davom ettirish · ' + state.page + '-bet';
  }

  // ---------- mushaf pages

  var pageEls = {};
  var regionEls = {};   // "s:a" -> [div]
  var regionPage = {};  // "s:a" -> page number

  function buildPages() {
    var pager = $('pager');
    // in a printed mushaf odd pages sit on the right; pad the first spread when it starts on an even page
    if (pageNums[0] % 2 === 0) {
      var blank = document.createElement('div');
      blank.className = 'page blank right';
      pager.appendChild(blank);
    }
    pageNums.forEach(function (p) {
      var P = Q.pages[p];
      var page = document.createElement('div');
      page.className = 'page ' + (p % 2 ? 'right' : 'left');
      page.dataset.page = p;
      var sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.setProperty('--ratio', P.w / P.h);
      var img = new Image();
      img.src = 'pages/' + p + '.webp';
      img.alt = p + '-bet';
      img.loading = 'lazy';
      sheet.appendChild(img);
      P.regions.forEach(function (r) {
        var k = key(r.s, r.a);
        regionPage[k] = regionPage[k] || p;
        r.r.forEach(function (box) {
          var d = document.createElement('div');
          d.className = 'rg';
          d.style.left = (box[0] / P.w * 100) + '%';
          d.style.top = (box[1] / P.h * 100) + '%';
          d.style.width = (box[2] / P.w * 100) + '%';
          d.style.height = (box[3] / P.h * 100) + '%';
          d.dataset.s = r.s;
          d.dataset.a = r.a;
          sheet.appendChild(d);
          (regionEls[k] = regionEls[k] || []).push(d);
        });
      });
      page.appendChild(sheet);
      pager.appendChild(page);
      pageEls[p] = page;
    });

    pager.addEventListener('click', function (e) {
      var rg = e.target.closest('.rg');
      if (!rg) return;
      onRegionTap(Number(rg.dataset.s), Number(rg.dataset.a));
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var p = Number(en.target.dataset.page);
        if (en.isIntersecting) visible[p] = true; else delete visible[p];
      });
      updateTitle();
    }, { root: pager, threshold: 0.6 });
    pageNums.forEach(function (p) { io.observe(pageEls[p]); });
  }

  function visiblePages() {
    return Object.keys(visible).map(Number).sort(function (a, b) { return a - b; });
  }

  function surahsOnPage(p) {
    var seen = [];
    Q.pages[p].regions.forEach(function (r) {
      if (seen.indexOf(r.s) < 0 && bySurah[r.s]) seen.push(r.s);
    });
    return seen;
  }

  function updateTitle() {
    var vp = visiblePages();
    if (!vp.length) return;
    var names = [];
    vp.forEach(function (p) {
      surahsOnPage(p).forEach(function (s) { if (names.indexOf(s) < 0) names.push(s); });
    });
    $('readerTitle').textContent = names.map(function (s) { return bySurah[s].uz; }).join(' · ');
    var pages = vp.length > 1 ? vp[0] + '–' + vp[vp.length - 1] : vp[0];
    $('readerSub').textContent = pages + '-bet · ' + juzOf(vp[0]) + '-pora';
    state.page = vp[0];
    store.set('page', vp[0]);
    $('turnPrev').disabled = vp[0] <= pageNums[0];
    $('turnNext').disabled = vp[vp.length - 1] >= pageNums[pageNums.length - 1];
  }

  function showPage(p, smooth) {
    var el = pageEls[p];
    if (!el) return;
    if (state.spread && p % 2 === 0) el = el.previousElementSibling || el; // the right-hand page of the spread
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', inline: 'start', block: 'nearest' });
  }

  function turnPage(dir) {
    var vp = visiblePages();
    var from = dir > 0 ? vp[vp.length - 1] : vp[0];
    var to = Math.min(Math.max(from + dir, pageNums[0]), pageNums[pageNums.length - 1]);
    if (from !== undefined && to !== from) showPage(to, true);
  }

  function updateLayout() {
    var spread = window.innerWidth >= 900 && window.innerWidth > window.innerHeight * 1.15;
    if (spread === state.spread) return;
    var keep = visiblePages()[0] || state.page;
    state.spread = spread;
    $('pager').classList.toggle('spread', spread);
    if (keep && readerOpen()) requestAnimationFrame(function () { showPage(keep, false); });
  }

  function flash(k) {
    (regionEls[k] || []).forEach(function (d) {
      d.classList.add('tap');
      setTimeout(function () { d.classList.remove('tap'); }, 600);
    });
  }

  var highlighted = null;
  function highlight(k) {
    if (highlighted) (regionEls[highlighted] || []).forEach(function (d) { d.classList.remove('on'); });
    highlighted = k;
    if (k) (regionEls[k] || []).forEach(function (d) { d.classList.add('on'); });
  }

  // ---------- screens

  function openReader(p) {
    $('list').classList.add('hidden');
    $('reader').classList.remove('hidden');
    updateLayout();
    var target = Q.pages[p] ? p : pageNums[0];
    requestAnimationFrame(function () { showPage(target, false); });
  }

  function closeReader() {
    audio.pause();
    $('reader').classList.add('hidden');
    $('list').classList.remove('hidden');
    updateResume();
  }

  // ---------- playback

  function onRegionTap(s, a) {
    if (!bySurah[s] || !bySurah[s].durations) {
      flash(key(s, a));
      toast('Bu sura audiosi hali qoʻshilmagan');
      return;
    }
    if (a === -1) {
      startSurah(s);
      return;
    }
    if (state.s === s && state.a === a && audio.src && !audio.ended) {
      if (audio.paused) audio.play(); else audio.pause();
      return;
    }
    playAt(s, a);
  }

  // Starting a surah from its beginning means listening to the whole surah.
  function startSurah(s) {
    if (state.mode === 'ayah') {
      setMode('surah');
      toast('Rejim: ' + MODES.surah);
    }
    playAt(s, firstIndex(s));
  }

  function playAt(s, a) {
    state.s = s;
    state.a = a;
    audio.src = audioUrl(s, a);
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
    showCurrent();
  }

  function showCurrent() {
    var k = key(state.s, state.a);
    highlight(k);
    $('nowLabel').textContent = ayahLabel(state.s, state.a);
    var p = regionPage[k];
    if (!p || !readerOpen()) return;
    if (!visible[p]) showPage(p, true);
    var el = (regionEls[k] || [])[0];
    var page = pageEls[p];
    if (el && page) {
      // pages taller than the screen (phone in landscape): keep the ayah in view
      var r = el.getBoundingClientRect(), pr = page.getBoundingClientRect();
      if (r.top < pr.top || r.bottom > pr.bottom) {
        page.scrollTo({ top: page.scrollTop + r.top - pr.top - pr.height / 3, behavior: 'smooth' });
      }
    }
  }

  function step(s, a, dir, crossSurah) {
    if (dir > 0 && a < lastIndex(s)) return [s, a + 1];
    if (dir < 0 && a > firstIndex(s)) return [s, a - 1];
    if (!crossSurah) return null;
    var t = playable[playable.indexOf(bySurah[s]) + dir];
    if (!t) return null;
    return [t.n, dir > 0 ? firstIndex(t.n) : lastIndex(t.n)];
  }

  function afterAyah() {
    var s = state.s, a = state.a, next = null;
    if (state.mode === 'ayah') {
      next = state.repeat ? [s, a] : null;
    } else if (state.mode === 'surah') {
      next = step(s, a, 1, false) || (state.repeat ? [s, firstIndex(s)] : null);
    } else {
      next = step(s, a, 1, true) ||
        (state.repeat ? [playable[0].n, firstIndex(playable[0].n)] : null);
    }
    if (next) playAt(next[0], next[1]);
  }

  function firstSurahOnScreen() {
    var vp = visiblePages();
    for (var i = 0; i < vp.length; i++) {
      var list = surahsOnPage(vp[i]);
      for (var j = 0; j < list.length; j++) if (bySurah[list[j]].durations) return list[j];
    }
    return playable[0].n;
  }

  function setPlaying(on) {
    $('reader').classList.toggle('playing', on);
    if (native && native.keepScreenOn) native.keepScreenOn(on);
  }

  audio.addEventListener('play', function () { setPlaying(true); });
  audio.addEventListener('pause', function () { setPlaying(false); });
  audio.addEventListener('ended', function () { setPlaying(false); afterAyah(); });
  audio.addEventListener('error', function () {
    setPlaying(false);
    if (audio.src) toast('Audio faylni ochib boʻlmadi');
  });

  // ---------- controls

  function setMode(m) {
    state.mode = m;
    store.set('mode', m);
    $('mode').textContent = MODES[m];
  }

  function setRepeat(on) {
    state.repeat = on;
    store.set('repeat', on);
    $('repeat').classList.toggle('on', on);
    $('repeat').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function togglePlay() {
    if (!audio.paused) { audio.pause(); return; }
    if (state.s === null) { startSurah(firstSurahOnScreen()); return; }
    if (audio.src && !audio.ended) audio.play(); else playAt(state.s, state.a);
  }

  function stepAyah(dir) {
    if (state.s === null) { startSurah(firstSurahOnScreen()); return; }
    var n = step(state.s, state.a, dir, true);
    if (n) playAt(n[0], n[1]); else toast(dir > 0 ? 'Bu oxirgi oyat' : 'Bu birinchi oyat');
  }

  function bindControls() {
    $('play').addEventListener('click', togglePlay);
    $('next').addEventListener('click', function () { stepAyah(1); });
    $('prev').addEventListener('click', function () { stepAyah(-1); });
    $('mode').addEventListener('click', function () {
      var m = MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length];
      setMode(m);
      toast({
        ayah: 'Faqat tanlangan oyat oʻqiladi',
        surah: 'Tanlangan oyatdan sura oxirigacha',
        all: 'Tanlangan oyatdan oxirgi suragacha'
      }[m]);
    });
    $('repeat').addEventListener('click', function () {
      setRepeat(!state.repeat);
      toast(state.repeat ? 'Takrorlash yoqildi' : 'Takrorlash oʻchirildi');
    });
    $('back').addEventListener('click', closeReader);
    // pages run right to left: the next page is on the left
    $('turnNext').addEventListener('click', function () { turnPage(1); });
    $('turnPrev').addEventListener('click', function () { turnPage(-1); });

    document.addEventListener('keydown', function (e) {
      if (!readerOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { turnPage(1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { turnPage(-1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { stepAyah(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { stepAyah(-1); e.preventDefault(); }
      else if (e.key === ' ' && e.target.tagName !== 'BUTTON') { togglePlay(); e.preventDefault(); }
      else if (e.key === 'Escape') closeReader();
    });
    window.addEventListener('resize', updateLayout);
  }

  // called by the Android back button; returns true when handled
  window.app = {
    back: function () {
      if (readerOpen()) { closeReader(); return true; }
      return false;
    }
  };

  renderList();
  buildPages();
  bindControls();
  setMode(state.mode);
  setRepeat(state.repeat);
})();
