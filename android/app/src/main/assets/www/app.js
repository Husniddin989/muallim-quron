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
  var MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
  var MAX_RECORDING_MS = 20 * 60 * 1000;

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
    updateResume();
  }

  function surahRow(s) {
    var li = document.createElement('li');
    li.className = 'surah';
    li.innerHTML =
      '<span class="num">' + s.n + '</span>' +
      '<span class="meta"><b>' + s.uz + '</b><small>' + s.ayahs + ' oyat · ' + s.page + '-bet</small></span>' +
      '<span class="ar">' + s.ar + '</span>' +
      '<button class="listen" aria-label="' + s.uz + ' surasini tinglash">' +
      '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>';
    li.addEventListener('click', function (e) {
      focus = s.n;
      openReader(s.page);
      if (e.target.closest('.listen')) startSurah(s.n);
      else flash(key(s.n, -1));
    });
    return li;
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
  }

  function closeReader() {
    exitPractice();
    audio.pause();
    $('reader').classList.add('hidden');
    $('list').classList.remove('hidden');
    updateResume();
  }

  // ---------- playback

  function onRegionTap(s, a) {
    focus = s;
    if (!bySurah[s] || !bySurah[s].durations) {
      flash(key(s, a));
      toast('Bu sura audiosi hali qoʻshilmagan');
      return;
    }
    if (practice.on) {
      flash(key(s, a));
      setPracticeTarget(s, a > 0 ? a : null);
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

  function playAt(s, a) {
    focus = s;
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
    if (next) playAt(next[0], next[1]);
    else if (practice.on) setPracticeTarget(practice.s, practice.a);
  }

  function firstSurahOnScreen() {
    var vp = visiblePages();
    for (var i = 0; i < vp.length; i++) {
      var list = surahsOnPage(vp[i]);
      for (var j = 0; j < list.length; j++) if (bySurah[list[j]].durations) return list[j];
    }
    return playable[0].n;
  }

  function keepAwake() {
    var on = !audio.paused || !mine.paused || !!rec.mr;
    if (native && native.keepScreenOn) native.keepScreenOn(on);
  }

  function setPlaying(on) {
    $('reader').classList.toggle('playing', on);
    $('refPlay').classList.toggle('playing', on);
    keepAwake();
  }

  audio.addEventListener('play', function () { mine.pause(); setPlaying(true); });
  audio.addEventListener('pause', function () { setPlaying(false); });
  audio.addEventListener('ended', function () { setPlaying(false); afterAyah(); });
  audio.addEventListener('error', function () {
    setPlaying(false);
    if (audio.src) toast('Audio faylni ochib boʻlmadi');
  });

  // ---------- recordings (kept on this device)

  var recStore = (function () {
    var dbp = null, mem = [], memId = 1;
    function open() {
      if (!dbp) {
        dbp = new Promise(function (resolve) {
          try {
            var req = indexedDB.open('muallim', 1);
            req.onupgradeneeded = function () {
              req.result.createObjectStore('recs', { keyPath: 'id', autoIncrement: true }).createIndex('s', 's');
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
            req.onblocked = function () { resolve(null); };
          } catch (e) { resolve(null); }
        });
      }
      return dbp;
    }
    function done(req) {
      return new Promise(function (resolve, reject) {
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
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
    var s = focus !== null && bySurah[focus] && bySurah[focus].durations && onScreen(focus)
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

  mine.addEventListener('play', function () { audio.pause(); updateMineUi(); });
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

  function setRepeat(on) {
    state.repeat = on;
    store.set('repeat', on);
    $('repeat').classList.toggle('on', on);
    $('repeat').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function togglePlay() {
    if (!audio.paused) { audio.pause(); return; }
    if (state.s === null) { startSurah(firstSurahOnScreen()); return; }
    if (audio.src && !audio.ended) audio.play(); else play(state.s, state.a);
  }

  function stepAyah(dir) {
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
      setRepeat(!state.repeat);
      toast(state.repeat ? 'Takrorlash yoqildi' : 'Takrorlash oʻchirildi');
    });
    $('back').addEventListener('click', closeReader);
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
    back: function () {
      if (!readerOpen()) return false;
      if (!$('recPanel').classList.contains('hidden')) closeRecPanel();
      else if (practice.on) exitPractice();
      else closeReader();
      return true;
    }
  };

  renderList();
  buildPages();
  bindControls();
  setMode(state.mode);
  setRepeat(state.repeat);
})();
