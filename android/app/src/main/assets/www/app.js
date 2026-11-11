(function () {
  'use strict';

  var Q = window.QURAN;
  var $ = function (id) { return document.getElementById(id); };
  var native = window.Android || null;

  var bySurah = {};
  Q.surahs.forEach(function (s) { bySurah[s.n] = s; });
  var playable = Q.surahs.filter(function (s) { return s.t; });
  var pageNums = Object.keys(Q.pages).map(Number).sort(function (a, b) { return a - b; });

  var MODES = { ayah: 'Bitta oyat', surah: 'Butun sura', all: 'Davomli' };
  var MODE_ORDER = ['ayah', 'surah', 'all'];
  var JUZ_START = [1, 22, 42, 62, 82, 102, 121, 142, 162, 182, 201, 222, 242, 262, 282,
    302, 322, 342, 362, 382, 402, 422, 442, 462, 482, 502, 522, 542, 562, 582];
  var MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
  var MAX_RECORDING_MS = 20 * 60 * 1000;
  // Whole-surah recitations (NNN.mp3) on Cloudflare R2, under our own domain and,
  // as a fallback for networks that cannot reach it, the bucket's r2.dev address.
  // ?audio=<url>[,<url>] overrides them for testing.
  var AUDIO_BASES = (function () {
    try {
      var q = new URLSearchParams(location.search).get('audio');
      if (q) return q.split(',').map(function (u) { return u.replace(/\/?$/, '/'); });
    } catch (e) { /* no query string support */ }
    return ['https://audio.muallim-quron.uz/quron/',
      'https://pub-81726ee9fa7c43fc978b4d5669dfb239.r2.dev/quron/'];
  })();
  var isApp = !!(native && native.keepScreenOn);

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
    limit: null,             // one-off mode for the current listen (the practice "Qori" button)
    repeat: store.get('repeat', false),
    page: store.get('page', null),
    spread: false
  };
  if (!MODES[state.mode]) state.mode = 'ayah';
  var visible = {};          // page number -> true while it is on screen
  var focus = null;          // the surah the user last opened, tapped or listened to

  var audio = new Audio();
  audio.preload = 'auto';

  // ---------- helpers

  function pad(n) { return ('00' + n).slice(-3); }
  function hasBasmala(s) { return bySurah[s].t.length > bySurah[s].ayahs; }
  function firstIndex(s) { return hasBasmala(s) ? 0 : 1; }
  // [start, end] seconds of an ayah (0 = basmala) in the surah's recitation
  function span(s, a) { return bySurah[s].t[hasBasmala(s) ? a : a - 1]; }
  // the host that last worked is remembered for a day, then our own domain is tried again
  var audioHost = (function () {
    var h = store.get('audioHost', null);
    return h && Date.now() - h.at < 864e5 && h.i < AUDIO_BASES.length ? h.i : 0;
  })();
  function remoteUrl(s) { return AUDIO_BASES[audioHost] + pad(s) + '.mp3'; }
  function switchHost() {
    if (AUDIO_BASES.length < 2) return false;
    audioHost = (audioHost + 1) % AUDIO_BASES.length;
    store.set('audioHost', { i: audioHost, at: Date.now() });
    return true;
  }
  function megabytes(bytes) {
    var mb = bytes / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
  }
  function lastIndex(s) { return bySurah[s].ayahs; }
  function key(s, a) { return s + ':' + a; }
  function juzOf(p) {
    var j = 0;
    while (j < JUZ_START.length && JUZ_START[j] <= p) j++;
    return j;
  }
  function readerOpen() { return !$('reader').classList.contains('hidden'); }
  function clock(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2);
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2400);
  }

  function ayahLabel(s, a) {
    var name = bySurah[s].uz + ' surasi';
    return a === 0 ? name + ' · Bismillah' : name + ' · ' + a + '-oyat';
  }

  // ---------- surah list

  function renderList() {
    var groups = {};
    playable.forEach(function (s) {
      var j = juzOf(s.page);
      (groups[j] = groups[j] || []).push(s);
    });
    Object.keys(groups).map(Number).sort(function (a, b) { return a - b; }).forEach(function (j) {
      var wrap = document.createElement('section');
      wrap.className = 'surah-group';
      wrap.innerHTML = '<p class="section-label">' + j + '-pora · ' + groups[j].length + ' sura</p>';
      var ul = document.createElement('ul');
      ul.className = 'surah-list';
      groups[j].forEach(function (s) { ul.appendChild(surahRow(s)); });
      wrap.appendChild(ul);
      $('surahGroups').appendChild(wrap);
    });

    $('playAll').addEventListener('click', function () {
      var s = playable[0];
      setMode('all');
      openReader(s.page);
      play(s.n, firstIndex(s.n));
    });
    $('resume').addEventListener('click', function () { openReader(state.page); });
    $('dlAll').addEventListener('click', downloadAll);
    $('search').addEventListener('input', filterList);
    updateResume();
  }

  function normalize(text) {
    return String(text).toLowerCase().replace(/[ʼʻ'`’‘\s-]/g, '');
  }

  function filterList() {
    var q = normalize($('search').value);
    var any = false;
    Array.prototype.forEach.call(document.querySelectorAll('.surah-group'), function (group) {
      var shown = 0;
      Array.prototype.forEach.call(group.querySelectorAll('.surah'), function (li) {
        // digits match the surah number from its start: "11" finds 11 and 110-114
        var hit = !q || (/^\d+$/.test(q) ? li.dataset.n.indexOf(q) === 0 : li.dataset.q.indexOf(q) >= 0);
        li.classList.toggle('hidden', !hit);
        if (hit) shown++;
      });
      group.classList.toggle('hidden', !shown);
      if (shown) any = true;
    });
    $('noMatch').classList.toggle('hidden', any);
  }

  function surahRow(s) {
    var li = document.createElement('li');
    li.className = 'surah';
    li.dataset.n = s.n;
    li.dataset.q = normalize(s.uz) + '|' + s.ar;
    li.innerHTML =
      '<span class="num">' + s.n + '</span>' +
      '<span class="meta"><b>' + s.uz + '</b><small>' + s.ayahs + ' oyat · ' +
      (isApp ? megabytes(s.size) : s.page + '-bet') + '</small></span>' +
      '<span class="ar">' + s.ar + '</span>' +
      '<button class="save star" data-s="' + s.n + '"></button>' +
      (isApp ? '<button class="dl" data-s="' + s.n + '"></button>' : '') +
      '<button class="listen" aria-label="' + s.uz + ' surasini tinglash">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>';
    paintSave(li.querySelector('.save'), s.n);
    li.addEventListener('click', function (e) {
      if (e.target.closest('.save')) { toggleSaved(s.n); return; }
      if (e.target.closest('.dl')) { onDownloadTap(s.n, e.target.closest('.dl')); return; }
      focus = s.n;
      openReader(s.page);
      if (e.target.closest('.listen')) startSurah(s.n);
      else flash(key(s.n, -1));
    });
    return li;
  }

  // ---------- saved surahs

  var STAR = '<svg viewBox="0 0 24 24"><path d="M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2 7.5 14l-1.7 7z"/></svg>';
  var saved = store.get('saved', []).filter(function (n) { return bySurah[n]; });

  function isSaved(n) { return saved.indexOf(n) >= 0; }

  function paintSave(btn, n) {
    if (!btn) return;
    if (!btn.firstChild) btn.innerHTML = STAR;
    var on = isSaved(n);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', bySurah[n].uz + (on ? ' saqlangan. Olib tashlash uchun bosing' : ' surasini saqlash'));
  }

  function toggleSaved(n) {
    if (isSaved(n)) saved.splice(saved.indexOf(n), 1);
    else saved.push(n);
    saved.sort(function (a, b) { return a - b; });
    store.set('saved', saved);
    Array.prototype.forEach.call(document.querySelectorAll('.save[data-s="' + n + '"]'), function (b) { paintSave(b, n); });
    renderSaved();
    updateSaveBtn();
    toast(isSaved(n) ? bySurah[n].uz + ' surasi saqlandi' : bySurah[n].uz + ' saqlanganlardan olib tashlandi');
  }

  function renderSaved() {
    var ul = $('savedList');
    ul.innerHTML = '';
    saved.forEach(function (n) { ul.appendChild(surahRow(bySurah[n])); });
    ul.classList.toggle('hidden', !saved.length);
    $('savedEmpty').classList.toggle('hidden', saved.length > 0);
    $('tabSaved').textContent = saved.length ? 'Saqlangan · ' + saved.length : 'Saqlangan';
    if (isApp) saved.forEach(function (n) { updateDownloadUi(n); });
  }

  // the surah the reader is on: the one last opened, tapped or played if it is on screen
  // (a page can hold the end of one surah and the start of the next), else the first one shown
  function readerSurah() {
    if (focus !== null && bySurah[focus] && onScreen(focus)) return focus;
    return firstSurahOnScreen() || focus;
  }

  function updateSaveBtn() {
    var n = readerSurah();
    var btn = $('saveBtn');
    btn.classList.toggle('hidden', !n);
    if (!n) return;
    var on = isSaved(n);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? bySurah[n].uz + ' saqlangan. Olib tashlash' : bySurah[n].uz + ' surasini saqlash');
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
    // every page gets an empty sheet of the right size; its image and ayah
    // regions are added only while it is near the screen (604 pages in all)
    pageNums.forEach(function (p) {
      var P = Q.pages[p];
      P.regions.forEach(function (r) {
        var k = key(r.s, r.a);
        regionPage[k] = regionPage[k] || p;
      });
      var page = document.createElement('div');
      page.className = 'page ' + (p % 2 ? 'right' : 'left');
      page.dataset.page = p;
      var sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.style.setProperty('--ratio', P.w / P.h);
      page.appendChild(sheet);
      pager.appendChild(page);
      pageEls[p] = page;
    });

    var near = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var p = Number(en.target.dataset.page);
        if (en.isIntersecting) fillPage(p); else emptyPage(p);
      });
    }, { root: pager, rootMargin: '0px 200%' });
    pageNums.forEach(function (p) { near.observe(pageEls[p]); });

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

  var filled = {};  // page number -> true while its image and regions are in the page

  function fillPage(p) {
    if (filled[p]) return;
    filled[p] = true;
    var P = Q.pages[p];
    var sheet = pageEls[p].firstChild;
    var img = new Image();
    img.decoding = 'async';
    img.src = 'pages/' + p + '.webp';
    img.alt = p + '-bet';
    sheet.appendChild(img);
    P.regions.forEach(function (r) {
      var k = key(r.s, r.a);
      r.r.forEach(function (box) {
        var d = document.createElement('div');
        d.className = k === highlighted ? 'rg on' : 'rg';
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
  }

  function emptyPage(p) {
    if (!filled[p]) return;
    delete filled[p];
    pageEls[p].firstChild.textContent = '';
    // an ayah running over two pages keeps the regions on the other page
    Q.pages[p].regions.forEach(function (r) {
      var k = key(r.s, r.a);
      var left = (regionEls[k] || []).filter(function (d) { return d.isConnected; });
      if (left.length) regionEls[k] = left; else delete regionEls[k];
    });
  }

  function visiblePages() {
    var vp = Object.keys(visible).map(Number).sort(function (a, b) { return a - b; });
    // before the first intersection report, trust the page we scrolled to
    return vp.length || !state.page ? vp : [state.page];
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
    updateSaveBtn();
  }

  function showPage(p, smooth) {
    var el = pageEls[p];
    if (!el) return;
    // the page, its partner in a spread and the next turn each way are drawn right away
    for (var q = p - 2; q <= p + 2; q++) if (pageEls[q]) fillPage(q);
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
    var keep = visiblePages()[0];
    state.spread = spread;
    $('pager').classList.toggle('spread', spread);
    if (keep && readerOpen()) {
      void $('pager').offsetWidth;
      showPage(keep, false);
    }
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
    state.page = target;
    void $('pager').offsetWidth;  // lay the pager out before scrolling it
    showPage(target, false);
    updateSaveBtn();
  }

  function closeReader() {
    exitDuaView();
    exitPractice();
    audio.pause();
    $('reader').classList.add('hidden');
    $('list').classList.remove('hidden');
    updateResume();
  }

  // ---------- playback

  function onRegionTap(s, a) {
    focus = s;
    updateSaveBtn();
    if (!bySurah[s] || !bySurah[s].t) {
      flash(key(s, a));
      toast('Bu sura audiosi hali qoʻshilmagan');
      return;
    }
    if (practice.on) {
      flash(key(s, a));
      setPracticeTarget(s, a > 0 ? a : null);
      return;
    }
    if (duaView !== null) duaAudio.pause();
    if (a === -1) {
      startSurah(s);
      return;
    }
    if (state.s === s && state.a === a && engine.end !== null) {
      if (audio.paused) audio.play(); else audio.pause();
      return;
    }
    play(s, a);
  }

  // Starting a surah from its beginning means listening to the whole surah.
  function startSurah(s) {
    if (state.mode === 'ayah') {
      setMode('surah');
      toast('Rejim: ' + MODES.surah);
    }
    play(s, firstIndex(s));
  }

  // a listen the user asked for; `limit` overrides the reading mode until it ends
  function play(s, a, limit) {
    state.limit = limit || null;
    playAt(s, a);
  }

  // Plays one ayah out of the surah's recitation; engine.end is where it stops.
  var engine = { url: null, end: null, seekTo: null, timer: 0, lastTime: 0, retries: 0, retryTimer: 0 };
  var MAX_RETRIES = 3;

  function playAt(s, a) {
    exitDuaView();
    focus = s;
    updateSaveBtn();
    var sp = span(s, a);
    var url = (isApp && localUrl(s)) || remoteUrl(s);
    if (url === remoteUrl(s) && navigator.onLine === false) {
      toast('Internet yoʻq. Bu surani tinglash uchun uni oldin yuklab oling.');
      return;
    }
    // the next ayah of the same recitation simply plays on, without a seek
    var flowing = engine.url === url && !audio.paused && Math.abs(audio.currentTime - sp[0]) < 0.4;
    state.s = s;
    state.a = a;
    engine.end = sp[1];
    engine.retries = 0;
    engine.lastTime = sp[0];
    clearTimeout(engine.retryTimer);
    if (engine.url !== url) {
      engine.url = url;
      engine.seekTo = sp[0];
      audio.src = url;
      audio.currentTime = sp[0];
    } else if (!flowing) {
      audio.currentTime = sp[0];
    }
    var pr = audio.play();
    if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
    armEnd();
    showCurrent();
  }

  function armEnd() {
    clearTimeout(engine.timer);
    if (engine.end === null || audio.paused) return;
    var left = engine.end - audio.currentTime;
    if (left <= 0.04 && !audio.seeking) { ayahDone(); return; }
    engine.timer = setTimeout(armEnd, Math.max(20, Math.min(left, 0.5) * 1000));
  }

  function ayahDone() {
    clearTimeout(engine.timer);
    engine.end = null;
    afterAyah();
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
    var mode = state.limit || state.mode;
    var repeat = state.repeat && !state.limit;
    if (mode === 'ayah') {
      next = repeat ? [s, a] : null;
    } else if (mode === 'surah') {
      next = step(s, a, 1, false) || (repeat ? [s, firstIndex(s)] : null);
    } else {
      next = step(s, a, 1, true) ||
        (repeat ? [playable[0].n, firstIndex(playable[0].n)] : null);
    }
    if (next) {
      playAt(next[0], next[1]);
    } else {
      audio.pause();
      if (practice.on) setPracticeTarget(practice.s, practice.a);
    }
  }

  function firstSurahOnScreen() {
    var vp = visiblePages();
    for (var i = 0; i < vp.length; i++) {
      var list = surahsOnPage(vp[i]);
      for (var j = 0; j < list.length; j++) if (bySurah[list[j]].t) return list[j];
    }
    return playable[0].n;
  }

  function keepAwake() {
    var on = !audio.paused || !mine.paused || !duaAudio.paused || !!rec.mr;
    if (native && native.keepScreenOn) native.keepScreenOn(on);
  }

  function setPlaying(on) {
    if (duaView !== null) on = !duaAudio.paused && dua.i === duaView;
    $('reader').classList.toggle('playing', on);
    $('refPlay').classList.toggle('playing', on);
    keepAwake();
  }

  audio.addEventListener('play', function () { mine.pause(); duaAudio.pause(); setPlaying(true); });
  audio.addEventListener('playing', function () {
    engine.retries = 0;
    if (state.s !== null) $('nowLabel').textContent = ayahLabel(state.s, state.a);
    armEnd();
  });
  // a big recitation can take a few seconds to start: say so
  audio.addEventListener('waiting', function () {
    if (state.s !== null && engine.end !== null) {
      $('nowLabel').textContent = ayahLabel(state.s, state.a) + ' · yuklanmoqda…';
    }
  });
  audio.addEventListener('seeked', armEnd);
  audio.addEventListener('loadedmetadata', function () {
    if (engine.seekTo !== null && Math.abs(audio.currentTime - engine.seekTo) > 0.25) audio.currentTime = engine.seekTo;
    engine.seekTo = null;
  });
  audio.addEventListener('timeupdate', function () {
    if (!audio.seeking) engine.lastTime = audio.currentTime;
    if (engine.end !== null && !audio.seeking && audio.currentTime >= engine.end - 0.04) ayahDone();
  });
  audio.addEventListener('pause', function () { clearTimeout(engine.timer); setPlaying(false); });
  audio.addEventListener('ended', function () {
    setPlaying(false);
    if (engine.end !== null) ayahDone();
  });
  // A dropped connection while streaming fires "error": reconnect and carry on
  // from where it stopped, and only give up after a few tries.
  audio.addEventListener('error', function () {
    var code = audio.error ? audio.error.code : 0;
    if (!audio.getAttribute('src') || code === 1) return;  // aborted on purpose
    var s = state.s, a = state.a;
    if (s !== null && engine.url && engine.end !== null && engine.retries < MAX_RETRIES) {
      engine.retries++;
      var delay = 1000 * engine.retries;
      // nothing at all came from this host: try the other one straight away
      if (audio.readyState === 0 && engine.url === remoteUrl(s) && switchHost()) {
        engine.url = remoteUrl(s);
        delay = 0;
      }
      var url = engine.url;
      var sp = span(s, a);
      var at = engine.lastTime > sp[0] && engine.lastTime < sp[1] ? engine.lastTime : sp[0];
      $('nowLabel').textContent = ayahLabel(s, a) + ' · qayta ulanmoqda…';
      clearTimeout(engine.retryTimer);
      engine.retryTimer = setTimeout(function () {
        if (state.s !== s || state.a !== a || engine.url !== url) return;  // the user moved on
        engine.seekTo = at;
        audio.src = url;
        audio.currentTime = at;
        var pr = audio.play();
        if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
      }, delay);
      return;
    }
    setPlaying(false);
    engine.url = null;
    engine.end = null;
    if (s !== null) $('nowLabel').textContent = ayahLabel(s, a);
    toast(navigator.onLine === false
      ? 'Internet yoʻq. Bu surani tinglash uchun uni oldin yuklab oling.'
      : 'Audio yuklanmadi. Oyatni yana bir bor bosing yoki surani yuklab oling.');
  });

  // ---------- recordings (kept on this device)

  var dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve) {
        try {
          var req = indexedDB.open('muallim', 2);
          req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('recs')) {
              db.createObjectStore('recs', { keyPath: 'id', autoIncrement: true }).createIndex('s', 's');
            }
            if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 's' });
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
          req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    return dbPromise;
  }
  function done(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var recStore = (function () {
    var mem = [], memId = 1;
    var open = openDb;
    function os(db, mode) { return db.transaction('recs', mode).objectStore('recs'); }
    function inMemory(r) { r.id = 'm' + memId++; mem.push(r); return r; }
    return {
      add: function (r) {
        return open().then(function (db) {
          if (!db) return inMemory(r);
          return done(os(db, 'readwrite').add(r)).then(function (id) { r.id = id; return r; });
        }).catch(function () { return inMemory(r); });
      },
      bySurah: function (s) {
        var fromMem = mem.filter(function (r) { return r.s === s; });
        return open().then(function (db) {
          if (!db) return fromMem;
          return done(os(db, 'readonly').index('s').getAll(s)).then(function (rows) { return rows.concat(fromMem); });
        }).catch(function () { return fromMem; });
      },
      remove: function (id) {
        mem = mem.filter(function (r) { return r.id !== id; });
        return open().then(function (db) {
          if (db && typeof id === 'number') return done(os(db, 'readwrite').delete(id));
        }).catch(function () { /* already gone */ });
      },
      persistent: function () { return open().then(function (db) { return !!db; }); }
    };
  })();

  // ---------- downloaded recitations (Android app: listen without internet)
  // The app writes them straight to files (al-Baqara alone is 190 MB) and reports
  // progress through window.app.onDownload.

  var downloads = { have: {}, busy: {}, waiting: {}, all: false };
  var ICON_DOWNLOAD = '<svg viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z"/></svg>';
  var ICON_DONE = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

  function localUrl(n) { return downloads.have[n] ? native.fileUrl(n) : null; }
  // numbers from 1000 up are duas (see duaKey), below are surahs
  function downloadUrl(n) { return n >= 1000 ? duaRemote(duaByKey[n]) : remoteUrl(n); }

  function loadDownloads() {
    try { downloads.have = JSON.parse(native.downloaded()) || {}; } catch (e) { downloads.have = {}; }
    playable.forEach(function (s) { updateDownloadUi(s.n); });
    updateDuaDownload();
    dropBrowserCopies();
  }

  // version 1.4 kept downloads inside the page's database; free that space
  function dropBrowserCopies() {
    openDb().then(function (db) {
      if (db && db.objectStoreNames.contains('audio')) {
        db.transaction('audio', 'readwrite').objectStore('audio').clear();
      }
    }).catch(function () { /* nothing to free */ });
  }

  function updateDownloadUi(n) {
    if (n >= 1000) { updateDuaDownload(); return; }
    // a saved surah has a second row (and button) in the Saqlangan tab
    Array.prototype.forEach.call(document.querySelectorAll('.dl[data-s="' + n + '"]'), function (btn) {
      if (btn.classList.contains('armed')) return;
      var busy = downloads.busy[n];
      btn.classList.toggle('done', !!downloads.have[n]);
      btn.classList.toggle('busy', busy !== undefined);
      if (busy !== undefined) {
        btn.textContent = Math.round(busy * 100) + '%';
        btn.setAttribute('aria-label', 'Yuklanmoqda, toʻxtatish uchun bosing');
      } else if (downloads.have[n]) {
        btn.innerHTML = ICON_DONE;
        btn.setAttribute('aria-label', bySurah[n].uz + ' yuklab olingan. Oʻchirish uchun bosing');
      } else {
        btn.innerHTML = ICON_DOWNLOAD;
        btn.setAttribute('aria-label', bySurah[n].uz + ' surasini yuklab olish, ' + megabytes(bySurah[n].size));
      }
    });
    updateDownloadAll();
  }

  function updateDownloadAll() {
    var btn = $('dlAll');
    if (!btn) return;
    var left = playable.filter(function (s) { return !downloads.have[s.n]; });
    btn.classList.toggle('hidden', !isApp || !left.length);
    if (downloads.all) {
      var total = playable.length, got = total - left.length;
      $('dlAllText').textContent = 'Yuklanmoqda: ' + got + ' / ' + total + ' sura · toʻxtatish';
    } else {
      var bytes = left.reduce(function (sum, s) { return sum + s.size; }, 0);
      $('dlAllText').textContent = 'Hammasini yuklab olish · ' + megabytes(bytes);
    }
  }

  function onDownloadTap(n, btn) {
    if (downloads.busy[n] !== undefined) {
      native.cancelDownload(n);
      return;
    }
    if (!downloads.have[n]) { downloadSurah(n); return; }
    if (!btn.classList.contains('armed')) {
      // a second tap confirms
      btn.classList.add('armed');
      btn.textContent = 'Oʻchirilsinmi?';
      setTimeout(function () { btn.classList.remove('armed'); updateDownloadUi(n); }, 3000);
      return;
    }
    btn.classList.remove('armed');
    removeDownload(n);
  }

  function downloadSurah(n) {
    if (downloads.have[n]) return Promise.resolve(true);
    if (downloads.waiting[n]) return downloads.waiting[n].promise;
    var w = {};
    w.promise = new Promise(function (resolve) { w.resolve = resolve; });
    downloads.waiting[n] = w;
    downloads.busy[n] = 0;
    updateDownloadUi(n);
    w.hosts = 1;
    native.download(n, downloadUrl(n));
    return w.promise;
  }

  // progress from the app: 0..1, then status 'done', 'error', 'nospace' or 'cancelled'
  function onDownload(n, progress, status) {
    if (!status) {
      downloads.busy[n] = Math.min(progress, 0.99);
      updateDownloadUi(n);
      return;
    }
    var w = downloads.waiting[n];
    if (status === 'error' && w && w.hosts < AUDIO_BASES.length && switchHost()) {
      w.hosts++;
      downloads.busy[n] = 0;
      updateDownloadUi(n);
      native.download(n, downloadUrl(n));
      return;
    }
    delete downloads.busy[n];
    delete downloads.waiting[n];
    if (status === 'done') {
      downloads.have[n] = n >= 1000 ? duaByKey[n].size : bySurah[n].size;
      if (!downloads.all && n < 1000) toast(bySurah[n].uz + ' surasi yuklab olindi');
    } else if (status === 'nospace') {
      toast('Telefonda joy yetmadi');
    } else if (status === 'error') {
      toast('Yuklab boʻlmadi. Internetni tekshiring.');
    }
    updateDownloadUi(n);
    if (w) w.resolve(status === 'done');
  }

  function removeDownload(n) {
    if (engine.url === localUrl(n)) {
      audio.pause();
      engine.url = null;
      engine.end = null;
    }
    native.removeDownload(n);
    delete downloads.have[n];
    updateDownloadUi(n);
    toast(bySurah[n].uz + ' surasi oʻchirildi');
  }

  function downloadAll() {
    if (downloads.all) {
      // a second tap stops the queue after cancelling the current file
      downloads.all = false;
      Object.keys(downloads.busy).forEach(function (n) { native.cancelDownload(Number(n)); });
      updateDownloadAll();
      return;
    }
    downloads.all = true;
    updateDownloadAll();
    var queue = playable.filter(function (s) { return !downloads.have[s.n]; });
    var next = function () {
      var s = queue.shift();
      if (!s || !downloads.all) {
        if (downloads.all) toast('Hamma suralar yuklab olindi');
        downloads.all = false;
        updateDownloadAll();
        return;
      }
      downloadSurah(s.n).then(function (ok) {
        if (ok) next();
        else { downloads.all = false; updateDownloadAll(); }
      });
    };
    next();
  }


  // ---------- Quranic duas (tools/duas.py cuts them out of al-Husary's recitation)

  var DUAS = window.DUAS || [];
  var DUA_GROUPS = ['«Rabbanā» bilan boshlanuvchi duolar', 'Boshqa Qurʼoniy duolar'];
  var duaByKey = {};
  DUAS.forEach(function (d) { duaByKey[duaKey(d)] = d; });
  var duaAudio = new Audio();
  duaAudio.preload = 'none';
  var dua = { i: null, all: false, repeat: store.get('duaRepeat', false), retries: 0, queue: false };

  // the app stores a dua next to the surahs as files/audio/<s*1000 + first ayah>.mp3
  function duaKey(d) { return d.s * 1000 + d.a[0]; }
  // on R2 the duas sit next to the surah folder: <host>/dua/duolar/SSS-AAA.mp3
  // (with ?audio= for testing: <base>/dua/SSS-AAA.mp3)
  function duaRemote(d) {
    var base = AUDIO_BASES[audioHost];
    return (/\/quron\/$/.test(base) ? base.replace(/quron\/$/, 'dua/duolar/') : base + 'dua/') + d.id + '.mp3';
  }
  function duaLocal(d) { return isApp && downloads.have[duaKey(d)] ? native.fileUrl(duaKey(d)) : null; }
  function duaSource(d) {
    var a = d.a[0] === d.a[1] ? d.a[0] : d.a[0] + '–' + d.a[1];
    return bySurah[d.s].uz + ' surasi, ' + a + '-oyat';
  }

  function renderDuas() {
    var n = 0;
    DUA_GROUPS.forEach(function (title, g) {
      var items = DUAS.filter(function (d) { return d.g === g; });
      if (!items.length) return;
      var wrap = document.createElement('section');
      wrap.className = 'surah-group';
      wrap.innerHTML = '<p class="section-label">' + title + ' · ' + items.length + '</p>';
      var ul = document.createElement('ul');
      ul.className = 'dua-list';
      items.forEach(function (d) { ul.appendChild(duaRow(d, DUAS.indexOf(d), ++n)); });
      wrap.appendChild(ul);
      $('duaGroups').appendChild(wrap);
    });
    $('duaPlayAll').addEventListener('click', function () {
      if (dua.all && dua.i !== null && duaAudio.getAttribute('src')) toggleDua();
      else playDua(0, true);
    });
    $('duaRepeat').addEventListener('click', function () {
      dua.repeat = !dua.repeat;
      store.set('duaRepeat', dua.repeat);
      updateDuaUi();
      toast(dua.repeat ? 'Duo takror-takror oʻqiladi' : 'Takrorlash oʻchirildi');
    });
    $('duaDl').addEventListener('click', downloadDuas);
    updateDuaUi();
  }

  function duaRow(d, i, n) {
    var li = document.createElement('li');
    li.className = 'dua';
    li.dataset.i = i;
    li.innerHTML =
      '<div class="dua-head"><span class="num">' + n + '</span>' +
      '<span class="meta"><b>' + d.uz + '</b><small>' + duaSource(d) + ' · ' + clock(d.dur) + '</small></span>' +
      '<button class="listen dua-play" aria-label="Duoni tinglash">' +
      '<svg class="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' +
      '<svg class="i-pause" viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg></button></div>' +
      '<p class="dua-ar" lang="ar" dir="rtl">' + d.ar + '</p>' +
      '<button class="dua-open"><svg viewBox="0 0 24 24"><path d="M21 5c-1.1-.35-2.3-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/></svg>' +
      '<span>Mushafda koʻrish</span></button>' +
      '<span class="dua-bar"></span>';
    li.querySelector('.dua-play').addEventListener('click', function () {
      if (dua.i === i && duaAudio.getAttribute('src')) toggleDua(); else playDua(i, false);
    });
    li.querySelector('.dua-open').addEventListener('click', function () { showDuaInMushaf(i); });
    return li;
  }

  function playDua(i, all) {
    var d = DUAS[i];
    var url = duaLocal(d) || duaRemote(d);
    if (url !== duaLocal(d) && navigator.onLine === false) {
      toast(isApp ? 'Internet yoʻq. Duolarni oldin yuklab oling.' : 'Internet yoʻq.');
      return;
    }
    dua.i = i;
    dua.all = all;
    dua.retries = 0;
    duaAudio.src = url;
    var pr = duaAudio.play();
    if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
    updateDuaUi();
    var li = document.querySelector('.dua[data-i="' + i + '"]');
    if (li && all) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function toggleDua() {
    if (duaAudio.paused) {
      var pr = duaAudio.play();
      if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
    } else {
      duaAudio.pause();
    }
  }

  // "Mushafda koʻrish": the reader marks the dua's ayahs and its player plays the dua
  var duaView = null;    // index of the dua shown in the mushaf
  var duaMarked = [];    // its region keys
  function showDuaInMushaf(i) {
    var d = DUAS[i];
    if (dua.i !== i) duaAudio.pause();
    audio.pause();
    focus = d.s;
    var k = key(d.s, d.a[0]);
    openReader(regionPage[k] || bySurah[d.s].page);
    duaView = i;
    highlight(null);
    markDua(d);
    $('reader').classList.add('dua-view');
    $('nowLabel').textContent = 'Duo: ' + d.uz;
    paintRepeat(dua.repeat);
    setPlaying(false);
  }

  function markDua(d) {
    duaMarked.forEach(function (k) {
      (regionEls[k] || []).forEach(function (el) { el.classList.remove('on'); });
    });
    duaMarked = [];
    if (!d) return;
    for (var a = d.a[0]; a <= d.a[1]; a++) duaMarked.push(key(d.s, a));
    duaMarked.forEach(function (k) {
      (regionEls[k] || []).forEach(function (el) { el.classList.add('on'); });
    });
  }

  function exitDuaView() {
    if (duaView === null) return;
    duaView = null;
    markDua(null);
    $('reader').classList.remove('dua-view');
    paintRepeat(state.repeat);
  }

  function toggleViewedDua() {
    if (dua.i === duaView && duaAudio.getAttribute('src')) toggleDua(); else playDua(duaView, false);
  }

  function stepDua(dir) {
    var j = duaView + dir;
    if (j < 0 || j >= DUAS.length) { toast(dir > 0 ? 'Bu oxirgi duo' : 'Bu birinchi duo'); return; }
    showDuaInMushaf(j);
    playDua(j, false);
  }

  function updateDuaUi() {
    var playing = !duaAudio.paused;
    Array.prototype.forEach.call(document.querySelectorAll('.dua'), function (li) {
      var on = Number(li.dataset.i) === dua.i && playing;
      li.classList.toggle('playing', on);
      if (Number(li.dataset.i) !== dua.i) li.querySelector('.dua-bar').style.width = '0';
      li.querySelector('.dua-play').setAttribute('aria-label', on ? 'Toʻxtatish' : 'Duoni tinglash');
    });
    $('duaPlayAllText').textContent = dua.all && playing
      ? 'Toʻxtatish · ' + (dua.i + 1) + ' / ' + DUAS.length
      : dua.all && dua.i !== null ? 'Davom ettirish · ' + (dua.i + 1) + ' / ' + DUAS.length
        : 'Hammasini ketma-ket tinglash';
    $('duaRepeat').setAttribute('aria-pressed', dua.repeat ? 'true' : 'false');
    $('duaRepeatText').textContent = 'Takrorlash: ' + (dua.repeat ? 'yoqilgan' : 'oʻchiq');
  }

  duaAudio.addEventListener('play', function () { audio.pause(); mine.pause(); updateDuaUi(); setPlaying(!audio.paused); });
  duaAudio.addEventListener('playing', function () { dua.retries = 0; });
  duaAudio.addEventListener('pause', function () { updateDuaUi(); setPlaying(!audio.paused); });
  duaAudio.addEventListener('timeupdate', function () {
    var li = document.querySelector('.dua[data-i="' + dua.i + '"]');
    if (li && duaAudio.duration) {
      li.querySelector('.dua-bar').style.width = (duaAudio.currentTime / duaAudio.duration * 100) + '%';
    }
  });
  duaAudio.addEventListener('ended', function () {
    if (dua.repeat) { playDua(dua.i, dua.all); return; }
    if (dua.all && dua.i + 1 < DUAS.length) { playDua(dua.i + 1, true); return; }
    dua.all = false;
    updateDuaUi();
    setPlaying(!audio.paused);
  });
  duaAudio.addEventListener('error', function () {
    var code = duaAudio.error ? duaAudio.error.code : 0;
    if (!duaAudio.getAttribute('src') || code === 1 || dua.i === null) return;
    var d = DUAS[dua.i];
    if (dua.retries < 2 && duaAudio.src === duaRemote(d)) {
      dua.retries++;
      if (duaAudio.readyState === 0) switchHost();  // nothing came: try the other host
      var at = duaAudio.currentTime || 0;
      duaAudio.src = duaRemote(d);
      duaAudio.currentTime = at;
      var pr = duaAudio.play();
      if (pr && pr.catch) pr.catch(function () { /* reported by the error event */ });
      return;
    }
    dua.all = false;
    updateDuaUi();
    toast(navigator.onLine === false ? 'Internet yoʻq.' : 'Duo audiosi yuklanmadi. Yana bir bor bosing.');
  });

  // Android app: every dua in one go (about 22 MB), so they play without internet
  function updateDuaDownload() {
    var btn = $('duaDl');
    var left = DUAS.filter(function (d) { return !downloads.have[duaKey(d)]; });
    btn.classList.toggle('hidden', !isApp || !left.length);
    if (dua.queue) {
      $('duaDlText').textContent = 'Yuklanmoqda: ' + (DUAS.length - left.length) + ' / ' + DUAS.length + ' · toʻxtatish';
    } else {
      $('duaDlText').textContent = 'Duolarni yuklab olish · ' +
        megabytes(left.reduce(function (sum, d) { return sum + d.size; }, 0));
    }
  }

  function downloadDuas() {
    if (dua.queue) {
      dua.queue = false;
      Object.keys(downloads.busy).forEach(function (n) { if (n >= 1000) native.cancelDownload(Number(n)); });
      updateDuaDownload();
      return;
    }
    dua.queue = true;
    var queue = DUAS.filter(function (d) { return !downloads.have[duaKey(d)]; });
    var next = function () {
      var d = queue.shift();
      if (!d || !dua.queue) {
        if (dua.queue) toast('Duolar yuklab olindi');
        dua.queue = false;
        updateDuaDownload();
        return;
      }
      downloadSurah(duaKey(d)).then(function (ok) {
        if (ok) next();
        else { dua.queue = false; updateDuaDownload(); }
      });
    };
    updateDuaDownload();
    next();
  }

  // ---------- theme: automatic (follows the phone), dark or light

  var THEME_ORDER = ['auto', 'dark', 'light'];
  var THEME_TEXT = {
    auto: 'Mavzu: avtomatik (telefon sozlamasi boʻyicha)',
    dark: 'Mavzu: qorongʻi',
    light: 'Mavzu: yorugʻ'
  };
  var THEME_ICON = {
    auto: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z"/></svg>',
    dark: '<svg viewBox="0 0 24 24"><path d="M12.3 2a10 10 0 1 0 9.7 12.5A8 8 0 0 1 12.3 2z"/></svg>',
    light: '<svg viewBox="0 0 24 24"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM3.5 4.9l1.4-1.4L7 5.6 5.6 7zm13.4 13.5 1.4-1.4 2.1 2.1-1.4 1.4zM1 11h3v2H1zm19 0h3v2h-3zM3.5 19.1l2.1-2.1L7 18.4l-2.1 2.1zM17 5.6l2.1-2.1 1.4 1.4L18.4 7z"/></svg>'
  };
  var theme = store.get('theme', 'auto');
  if (THEME_ORDER.indexOf(theme) < 0) theme = 'auto';
  var systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme() {
    var dark = theme === 'dark';
    if (theme === 'auto') {
      dark = native && native.nightMode ? native.nightMode() : !!(systemDark && systemDark.matches);
    }
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0d4a31' : '#0b5d3b');
    if (native && native.setDark) native.setDark(dark);
    $('themeBtn').innerHTML = THEME_ICON[theme];
    $('themeBtn').setAttribute('aria-label', THEME_TEXT[theme] + '. Oʻzgartirish uchun bosing');
    $('themeBtn').title = THEME_TEXT[theme];
  }

  function nextTheme() {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    store.set('theme', theme);
    applyTheme();
    toast(THEME_TEXT[theme]);
  }

  if (systemDark) {
    var onSystem = function () { if (theme === 'auto') applyTheme(); };
    if (systemDark.addEventListener) systemDark.addEventListener('change', onSystem);
    else if (systemDark.addListener) systemDark.addListener(onSystem);
  }

  // ---------- tabs

  var TABS = { surahs: ['tabSurahs', 'surahsPane'], saved: ['tabSaved', 'savedPane'], duas: ['tabDuas', 'duasPane'] };
  var tab = 'surahs';

  function showTab(name) {
    if (!TABS[name]) name = 'surahs';
    tab = name;
    Object.keys(TABS).forEach(function (t) {
      $(TABS[t][0]).setAttribute('aria-selected', t === name ? 'true' : 'false');
      $(TABS[t][1]).classList.toggle('hidden', t !== name);
    });
    store.set('tab', name);
  }

  var practice = { on: false, s: null, a: null, lastA: null, recs: [] };
  var rec = { mr: null, stream: null, chunks: [], started: 0, timer: 0, ctx: null, raf: 0, s: null, a: null };
  var mine = new Audio();
  var mineUrl = null, mineId = null;

  function practiceLabel(s, a) {
    return bySurah[s].uz + ' surasi · ' + (a ? a + '-oyat' : 'butun sura');
  }

  function onScreen(s) {
    return visiblePages().some(function (p) { return surahsOnPage(p).indexOf(s) >= 0; });
  }

  function enterPractice() {
    exitDuaView();
    duaAudio.pause();
    var s = focus !== null && bySurah[focus] && bySurah[focus].t && onScreen(focus)
      ? focus : firstSurahOnScreen();
    var a = state.s === s && state.a > 0 && state.mode === 'ayah' ? state.a : null;
    audio.pause();
    practice.on = true;
    $('reader').classList.add('practice');
    $('practiceBtn').setAttribute('aria-pressed', 'true');
    setPracticeTarget(s, a);
    if (!practice.lastA && state.s === s && state.a > 0) {
      practice.lastA = state.a;  // offer the ayah just listened to
      updateScope();
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Bu brauzerda ovoz yozib boʻlmaydi');
    }
  }

  function exitPractice() {
    if (!practice.on) return;
    stopRecording();
    mine.pause();
    closeRecPanel();
    practice.on = false;
    $('reader').classList.remove('practice');
    $('practiceBtn').setAttribute('aria-pressed', 'false');
    highlight(state.s !== null ? key(state.s, state.a) : null);
  }

  // what the user is about to recite: one ayah, or the whole surah when `a` is null
  function setPracticeTarget(s, a) {
    var changed = s !== practice.s || a !== practice.a;
    if (s !== practice.s) practice.lastA = null;
    practice.s = s;
    practice.a = a || null;
    if (practice.a) practice.lastA = practice.a;
    $('pracLabel').textContent = practiceLabel(s, practice.a);
    updateScope();
    highlight(practice.a ? key(s, practice.a) : null);
    if (changed) audio.pause();
    loadRecordings();
  }

  function updateScope() {
    $('scopeAyah').textContent = practice.lastA ? practice.lastA + '-oyat' : 'Oyat';
    $('scopeAyah').disabled = !practice.lastA;
    $('scopeAyah').setAttribute('aria-pressed', practice.a ? 'true' : 'false');
    $('scopeSurah').setAttribute('aria-pressed', practice.a ? 'false' : 'true');
  }

  function loadRecordings() {
    var s = practice.s;
    return recStore.bySurah(s).then(function (rows) {
      if (s !== practice.s) return;
      practice.recs = rows.sort(function (x, y) { return y.at - x.at; });
      renderRecordings();
    });
  }

  function latestRecording() {
    for (var i = 0; i < practice.recs.length; i++) {
      if ((practice.recs[i].a || null) === practice.a) return practice.recs[i];
    }
    return null;
  }

  function renderRecordings() {
    var n = practice.recs.length;
    $('recCount').textContent = n;
    $('recCount').classList.toggle('hidden', !n);
    $('minePlay').disabled = !latestRecording();
    $('recPanelTitle').textContent = bySurah[practice.s].uz + ' surasi yozuvlari';
    $('recEmpty').classList.toggle('hidden', !!n);
    var ul = $('recList');
    ul.innerHTML = '';
    practice.recs.forEach(function (r) {
      var d = new Date(r.at);
      var when = d.getDate() + '-' + MONTHS[d.getMonth()] + ', ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2);
      var li = document.createElement('li');
      li.className = 'rec-item';
      li.innerHTML =
        '<button class="icon rec-play" aria-label="Tinglash">' +
        '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>' +
        '<span class="rec-meta"><b>' + (r.a ? r.a + '-oyat' : 'Butun sura') + '</b>' +
        '<small>' + when + ' · ' + clock(r.dur) + '</small></span>' +
        '<button class="icon rec-del" aria-label="Oʻchirish">' +
        '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>';
      li.querySelector('.rec-play').addEventListener('click', function () { playRecording(r); });
      var del = li.querySelector('.rec-del');
      del.addEventListener('click', function () {
        if (!del.classList.contains('armed')) {
          // a second tap confirms
          del.classList.add('armed');
          del.textContent = 'Oʻchirilsinmi?';
          setTimeout(function () { if (del.isConnected) renderRecordings(); }, 3000);
          return;
        }
        if (mineId === r.id) mine.pause();
        recStore.remove(r.id).then(function () { toast('Yozuv oʻchirildi'); loadRecordings(); });
      });
      li.dataset.id = r.id;
      ul.appendChild(li);
    });
    updateMineUi();
  }

  function playRecording(r) {
    if (mineId === r.id && mine.src && !mine.ended) {
      if (mine.paused) mine.play(); else mine.pause();
      return;
    }
    audio.pause();
    if (mineUrl) URL.revokeObjectURL(mineUrl);
    mineUrl = URL.createObjectURL(r.blob);
    mineId = r.id;
    mine.src = mineUrl;
    var pr = mine.play();
    if (pr && pr.catch) pr.catch(function () { toast('Yozuvni ochib boʻlmadi'); });
  }

  function updateMineUi() {
    var playingId = mine.paused ? null : mineId;
    var latest = latestRecording();
    $('minePlay').classList.toggle('playing', !!latest && playingId === latest.id);
    Array.prototype.forEach.call(document.querySelectorAll('.rec-item'), function (li) {
      var btn = li.querySelector('.rec-play');
      var on = String(playingId) === li.dataset.id;
      btn.classList.toggle('playing', on);
      btn.innerHTML = on
        ? '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    });
    keepAwake();
  }

  mine.addEventListener('play', function () { audio.pause(); duaAudio.pause(); updateMineUi(); });
  mine.addEventListener('pause', updateMineUi);
  mine.addEventListener('ended', updateMineUi);

  function pickMime() {
    var types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Bu brauzerda ovoz yozib boʻlmaydi');
      return;
    }
    audio.pause();
    mine.pause();
    closeRecPanel();
    rec.s = practice.s;
    rec.a = practice.a;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var mime = pickMime();
        var mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        rec.mr = mr;
        rec.stream = stream;
        rec.chunks = [];
        rec.started = Date.now();
        mr.ondataavailable = function (e) { if (e.data && e.data.size) rec.chunks.push(e.data); };
        mr.onstop = finishRecording;
        mr.start(1000);
        $('reader').classList.add('recording');
        $('recBtn').setAttribute('aria-label', 'Yozishni toʻxtatish');
        $('recTime').textContent = '0:00';
        rec.timer = setInterval(function () {
          var ms = Date.now() - rec.started;
          $('recTime').textContent = clock(ms / 1000);
          if (ms >= MAX_RECORDING_MS) stopRecording();
        }, 250);
        startMeter(stream);
        keepAwake();
      })
      .catch(function (err) {
        var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        toast(denied ? 'Mikrofonga ruxsat berilmadi. Sozlamalardan ruxsat bering.' : 'Mikrofonni ochib boʻlmadi');
      });
  }

  function stopRecording() {
    if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
  }

  function finishRecording() {
    var mr = rec.mr;
    var dur = (Date.now() - rec.started) / 1000;
    var type = mr.mimeType || (rec.chunks[0] && rec.chunks[0].type) || 'audio/webm';
    var blob = new Blob(rec.chunks, { type: type });
    rec.stream.getTracks().forEach(function (t) { t.stop(); });
    clearInterval(rec.timer);
    stopMeter();
    rec.mr = null;
    rec.stream = null;
    rec.chunks = [];
    $('reader').classList.remove('recording');
    $('recBtn').setAttribute('aria-label', 'Yozishni boshlash');
    keepAwake();
    if (dur < 1 || !blob.size) {
      toast('Yozuv juda qisqa, saqlanmadi');
      return;
    }
    var r = { s: rec.s, a: rec.a, at: Date.now(), dur: dur, type: type, blob: blob };
    recStore.add(r).then(function (saved) {
      return recStore.persistent().then(function (ok) {
        toast(ok ? 'Yozuv saqlandi. ▶ Men tugmasi bilan tinglang.' : 'Yozuv faqat shu oyna ochiq turguncha saqlanadi');
        if (practice.on && practice.s === saved.s) loadRecordings();
      });
    });
  }

  function startMeter(stream) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      rec.ctx = new Ctx();
      if (rec.ctx.resume) rec.ctx.resume();
      var an = rec.ctx.createAnalyser();
      an.fftSize = 512;
      rec.ctx.createMediaStreamSource(stream).connect(an);
      var buf = new Uint8Array(an.fftSize);
      var bar = $('recLevel');
      var tick = function () {
        an.getByteTimeDomainData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        bar.style.width = Math.min(100, Math.sqrt(sum / buf.length) * 400) + '%';
        rec.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { /* the level meter is optional */ }
  }

  function stopMeter() {
    cancelAnimationFrame(rec.raf);
    $('recLevel').style.width = '0';
    if (rec.ctx && rec.ctx.close) rec.ctx.close();
    rec.ctx = null;
  }

  function toggleRecording() {
    if (rec.mr) stopRecording(); else startRecording();
  }

  function toggleReference() {
    if (!audio.paused) { audio.pause(); return; }
    var s = practice.s, a = practice.a;
    if (a) play(s, a, 'ayah'); else play(s, firstIndex(s), 'surah');
  }

  function openRecPanel() { $('recPanel').classList.remove('hidden'); }
  function closeRecPanel() { $('recPanel').classList.add('hidden'); }

  // ---------- controls

  function setMode(m) {
    state.mode = m;
    store.set('mode', m);
    $('mode').textContent = MODES[m];
  }

  function paintRepeat(on) {
    $('repeat').classList.toggle('on', on);
    $('repeat').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setRepeat(on) {
    state.repeat = on;
    store.set('repeat', on);
    $('repeat').classList.toggle('on', on);
    $('repeat').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function togglePlay() {
    if (duaView !== null) { toggleViewedDua(); return; }
    if (!audio.paused) { audio.pause(); return; }
    if (state.s === null) { startSurah(firstSurahOnScreen()); return; }
    if (engine.end !== null) audio.play(); else play(state.s, state.a);
  }

  function stepAyah(dir) {
    if (duaView !== null) { stepDua(dir); return; }
    if (state.s === null) { startSurah(firstSurahOnScreen()); return; }
    var n = step(state.s, state.a, dir, true);
    if (n) play(n[0], n[1]); else toast(dir > 0 ? 'Bu oxirgi oyat' : 'Bu birinchi oyat');
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
      if (duaView !== null) {
        dua.repeat = !dua.repeat;
        store.set('duaRepeat', dua.repeat);
        paintRepeat(dua.repeat);
        updateDuaUi();
        toast(dua.repeat ? 'Duo takror-takror oʻqiladi' : 'Takrorlash oʻchirildi');
        return;
      }
      setRepeat(!state.repeat);
      toast(state.repeat ? 'Takrorlash yoqildi' : 'Takrorlash oʻchirildi');
    });
    $('back').addEventListener('click', closeReader);
    $('themeBtn').addEventListener('click', nextTheme);
    $('tabSurahs').addEventListener('click', function () { showTab('surahs'); });
    $('tabDuas').addEventListener('click', function () { showTab('duas'); });
    $('tabSaved').addEventListener('click', function () { showTab('saved'); });
    $('saveBtn').addEventListener('click', function () {
      var n = readerSurah();
      if (n) toggleSaved(n);
    });
    // pages run right to left: the next page is on the left
    $('turnNext').addEventListener('click', function () { turnPage(1); });
    $('turnPrev').addEventListener('click', function () { turnPage(-1); });

    $('practiceBtn').addEventListener('click', function () {
      if (practice.on) exitPractice(); else enterPractice();
    });
    $('recBtn').addEventListener('click', toggleRecording);
    $('refPlay').addEventListener('click', toggleReference);
    $('minePlay').addEventListener('click', function () {
      var r = latestRecording();
      if (r) playRecording(r);
    });
    $('scopeAyah').addEventListener('click', function () {
      if (!practice.a && practice.lastA) setPracticeTarget(practice.s, practice.lastA);
    });
    $('scopeSurah').addEventListener('click', function () { setPracticeTarget(practice.s, null); });
    $('recListBtn').addEventListener('click', function () {
      if ($('recPanel').classList.contains('hidden')) openRecPanel(); else closeRecPanel();
    });
    $('recPanelClose').addEventListener('click', closeRecPanel);

    document.addEventListener('keydown', function (e) {
      if (!readerOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { turnPage(1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { turnPage(-1); e.preventDefault(); }
      else if (e.key === 'ArrowDown' && !practice.on) { stepAyah(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && !practice.on) { stepAyah(-1); e.preventDefault(); }
      else if (e.key === ' ' && e.target.tagName !== 'BUTTON') {
        if (practice.on) toggleReference(); else togglePlay();
        e.preventDefault();
      }
      else if ((e.key === 'r' || e.key === 'R') && practice.on) toggleRecording();
      else if (e.key === 'Escape') {
        if (!$('recPanel').classList.contains('hidden')) closeRecPanel();
        else if (practice.on) exitPractice();
        else closeReader();
      }
    });
    window.addEventListener('resize', updateLayout);
  }

  // called by the Android back button; returns true when handled
  window.app = {
    onDownload: function (n, progress, status) { onDownload(n, progress, status); },
    onSystemTheme: function () { if (theme === 'auto') applyTheme(); },
    back: function () {
      if (!readerOpen()) {
        if (tab === 'surahs') return false;
        showTab('surahs');
        return true;
      }
      if (!$('recPanel').classList.contains('hidden')) closeRecPanel();
      else if (practice.on) exitPractice();
      else closeReader();
      return true;
    }
  };

  applyTheme();
  renderList();
  renderSaved();
  renderDuas();
  showTab(store.get('tab', 'surahs'));
  buildPages();
  bindControls();
  setMode(state.mode);
  setRepeat(state.repeat);
  if (isApp) loadDownloads();
})();
