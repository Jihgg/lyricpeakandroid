// Lyric Peak for Android — animation + lyrics logic.
// The native side (MainActivity.java) calls window.onPlayer / onHttp / onMicResult / onAppResume.
(() => {
  'use strict';

  /* ================= bridge ================= */
  const AND = window.Android || null;
  const call = (fn, ...args) => { try { return AND && typeof AND[fn] === 'function' ? AND[fn](...args) : undefined; } catch (e) { return undefined; } };

  /* ================= utils ================= */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ease = {
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  };
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
  const WHITE = [255, 255, 255];
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  /* ================= settings ================= */
  const PALS = [
    { name: 'Ember', a: '#ff4a2b', b: '#ffb38a' },
    { name: 'Rose', a: '#ff2f7d', b: '#ffc4dc' },
    { name: 'Ice', a: '#1fb8ff', b: '#c8f1ff' },
    { name: 'Acid', a: '#a6ff2e', b: '#ecffc9' },
    { name: 'Gold', a: '#ffb800', b: '#fff0b8' },
    { name: 'Mono', a: '#d9d9e3', b: '#ffffff' },
  ].map((p) => ({ ...p, A: hexRgb(p.a), B: hexRgb(p.b) }));
  const MODES = { peak: 'Peak', flow: 'Flow', stars: 'Constellation' };
  const MODE_KEYS = Object.keys(MODES);
  const S = Object.assign({ mode: 'peak', pal: 0, react: true }, ls.get('settings', {}));
  if (!MODES[S.mode]) S.mode = 'peak';
  if (!PALS[S.pal]) S.pal = 0;
  const save = () => ls.set('settings', S);
  const FONT_PEAK = '"LP Anton", Impact, "Arial Narrow", sans-serif';
  const FONT_UI = '"LP Inter", system-ui, sans-serif';
  const CAP = 0.86;

  /* ================= player state (from Android) ================= */
  const PL = { access: null, edition: (call('edition') || 'standard'), spotifySeen: false, pkg: '', title: '', artist: '', album: '', art: '', duration: 0, pos: 0, at: 0, playing: false, speed: 1 };
  const APP_NAMES = { 'com.spotify.music': 'Spotify', 'com.google.android.apps.youtube.music': 'YT Music', ytweb: 'YT Music' };
  const isYt = (pkg) => pkg === 'ytweb' || pkg === 'com.google.android.apps.youtube.music';
  let trackKey = '', model = null, lyrState = 'idle', lyrInfo = '', reqId = 0, offset = 0, offTimer = 0, fetchTimer = 0;

  const curTime = () => PL.pos + (PL.playing ? ((performance.now() - PL.at) / 1000) * PL.speed : 0);

  window.onPlayer = (o) => {
    o = o || {};
    const hadAccess = PL.access, hadSeen = PL.spotifySeen;
    PL.access = !!o.access;
    if (o.edition) PL.edition = o.edition;
    PL.spotifySeen = !!o.spotifySeen;
    if (o.ytApp && o.ytApp !== PL.ytApp) { PL.ytApp = o.ytApp; if (lyrState === 'nomedia') renderMsg(); }
    if (PL.access !== hadAccess) renderSheet();
    if (PL.spotifySeen !== hadSeen && lyrState === 'nomedia') renderMsg();
    if ('art' in o) { PL.art = o.art || ''; setArt(PL.art); updateHud(); }
    if (!o.title) {
      if ((PL.access || PL.edition === 'standard' || ls.get('skipAccess', false)) && lyrState !== 'nomedia' && !model) setState('nomedia');
      PL.playing = false;
      return;
    }
    if (typeof o.position === 'number') {
      const pos = o.position / 1000;
      const playing = !!o.playing;
      const pred = curTime();
      const changed = playing !== PL.playing || !ui.play.dataset.set;
      if (changed || !playing || Math.abs(pred - pos) > 0.3) { PL.pos = pos; PL.at = performance.now(); }
      PL.playing = playing;
      PL.speed = o.speed > 0 ? o.speed : 1;
      if (changed) { ui.play.dataset.set = '1'; ui.play.replaceChildren(icon(playing ? 'M6.5 5h4v14h-4zM13.5 5h4v14h-4z' : 'M7 4.5v15L19.5 12z')); }
    }
    PL.duration = (o.duration || 0) / 1000;
    if ((o.pkg || '') !== PL.pkg) { PL.pkg = o.pkg || ''; updateHud(); applySettingsUI(); }
    const key = ((o.artist || '') + '|' + o.title).toLowerCase();
    if (key !== trackKey) {
      trackKey = key;
      PL.title = o.title; PL.artist = o.artist || ''; PL.album = o.album || '';
      model = null; clearLayouts();
      reqId++;
      offset = ls.get('off:' + key, 0);
      updateSync(); updateHud();
      setState('loading');
      clearTimeout(fetchTimer);
      // Spotify sometimes sends the title a moment before the length; give it a beat.
      fetchTimer = setTimeout(() => fetchLyrics(), PL.duration > 0 ? 250 : 1200);
    }
  };

  /* ================= LRCLIB lookup ================= */
  const httpWait = new Map();
  let httpId = 0;
  window.onHttp = (id, status, body) => { const f = httpWait.get(id); if (f) { httpWait.delete(id); f({ status, body }); } };
  function httpGet(url) {
    return new Promise((resolve) => {
      const id = ++httpId;
      httpWait.set(id, resolve);
      if (!AND) { httpWait.delete(id); resolve({ status: 0, body: '' }); return; }
      call('httpGet', url, id);
      setTimeout(() => { if (httpWait.has(id)) { httpWait.delete(id); resolve({ status: 0, body: '' }); } }, 25000);
    });
  }
  async function api(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) qs.set(k, v);
    const url = `https://lrclib.net/api${path}?${qs}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await httpGet(url);
      if (r.status === 404) return null;
      if (r.status === 429 && attempt === 0) { await sleep(3000 + Math.random() * 500); continue; }
      if (r.status === 0) throw new Error('No internet connection');
      if (r.status < 200 || r.status >= 300) throw new Error('Lyrics service answered ' + r.status);
      try { return JSON.parse(r.body); } catch (e) { throw new Error('Unexpected answer from the lyrics service'); }
    }
    throw new Error('Lyrics service is busy, try again in a moment');
  }
  function cleanTitle(t) {
    return String(t || '')
      .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|visuali[sz]er|remaster(ed)?|live|version|mono|stereo|explicit|clean|hd|4k|m\/?v)\b[^)\]]*[)\]]/gi, '')
      .replace(/\s*[([]\s*(feat|ft|with|prod)\.?\s[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|radio edit|single version|mono|stereo|acoustic version|sped up|slowed).*$/i, '')
      .replace(/\s+(feat|ft)\.?\s.+$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  const primaryArtist = (a) => String(a || '').split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|•|\/)\s*/i)[0].trim();
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  function score(rec, title, artist, duration) {
    const rt = norm(cleanTitle(rec.trackName || rec.name)), qt = norm(title);
    const ra = norm(rec.artistName), qa = norm(artist);
    let s = 0;
    if (rt !== qt) s += rt.includes(qt) || qt.includes(rt) ? 4 : 40;
    if (!(ra && qa && (ra.includes(qa) || qa.includes(ra)))) s += 25;
    if (duration && rec.duration) s += Math.min(30, Math.abs(rec.duration - duration));
    return s;
  }
  function pickBest(list, title, artist, duration) {
    let best = null, bestS = Infinity, plain = null, plainS = Infinity, inst = null;
    for (const rec of list || []) {
      const s = score(rec, title, artist, duration);
      if (rec.instrumental && s < 20 && !inst) inst = rec;
      if (rec.syncedLyrics && s < bestS) { best = rec; bestS = s; }
      if (rec.plainLyrics && s < plainS) { plain = rec; plainS = s; }
    }
    if (best && bestS < 32) return { rec: best, approx: !!(duration && best.duration && Math.abs(best.duration - duration) > 3) };
    if (inst) return { rec: inst };
    if (plain && plainS < 32) return { rec: plain };
    return null;
  }
  function toResult(rec, approx) {
    if (rec.syncedLyrics) return { kind: 'synced', synced: rec.syncedLyrics, approx: !!approx };
    if (rec.instrumental) return { kind: 'instrumental' };
    if (rec.plainLyrics) return { kind: 'plain' };
    return { kind: 'none' };
  }
  function cacheGet(key) {
    const r = ls.get(key, null);
    if (!r || !r.res) return null;
    const ttl = (r.res.kind === 'none' ? 1 : 30) * 86400000;
    return Date.now() - r.at < ttl ? r.res : null;
  }
  function cachePut(key, res) {
    const idx = ls.get('cacheIndex', []).filter((k) => k !== key);
    idx.push(key);
    while (idx.length > 150) ls.del(idx.shift());
    ls.set(key, { at: Date.now(), res });
    ls.set('cacheIndex', idx);
  }
  async function findLyrics(track, override) {
    const duration = Math.round(track.duration || 0);
    const key = 'lyr:' + norm(track.artist) + '|' + norm(track.title) + '|' + Math.round(duration / 5);
    if (!override) { const hit = cacheGet(key); if (hit) return hit; }
    const rawTitle = (override && override.title) || track.title || '';
    const rawArtist = (override && override.artist) || track.artist || '';
    const title = cleanTitle(rawTitle) || rawTitle;
    const artist = primaryArtist(rawArtist) || rawArtist;
    if (!title) return { kind: 'none' };
    let res = null;
    if (duration && !override) {
      const rec = await api('/get', { track_name: rawTitle, artist_name: rawArtist, album_name: track.album || '', duration });
      if (rec && (rec.syncedLyrics || rec.instrumental)) res = toResult(rec);
    }
    if (!res) {
      const list = await api('/search', { track_name: title, artist_name: artist });
      const pick = pickBest(list, title, artist, duration);
      if (pick) res = toResult(pick.rec, pick.approx);
    }
    if (!res || res.kind === 'plain') {
      await sleep(250);
      const list = await api('/search', { q: `${artist} ${title}` });
      const pick = pickBest(list, title, artist, duration);
      if (pick && pick.rec.syncedLyrics) res = toResult(pick.rec, pick.approx);
      else if (!res && pick) res = toResult(pick.rec);
    }
    res = res || { kind: 'none' };
    cachePut(key, res);
    return res;
  }

  /* ================= lyric model ================= */
  function parseLRC(text) {
    const out = [];
    const stamp = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
    const wtag = /<(\d{1,3}:\d{1,2}(?:\.\d{1,3})?)>/;
    for (const raw of String(text || '').split(/\r?\n/)) {
      let rest = raw, m;
      const times = [];
      while ((m = stamp.exec(rest))) { times.push(+m[1] * 60 + parseFloat(m[2].replace(':', '.'))); rest = rest.slice(m[0].length); }
      if (!times.length) continue;
      let wt = null;
      if (wtag.test(rest)) {
        wt = [];
        let cur = null;
        rest.split(/<(\d{1,3}:\d{1,2}(?:\.\d{1,3})?)>/).forEach((p, i) => {
          if (i % 2) { const [mm, ss] = p.split(':'); cur = +mm * 60 + parseFloat(ss); }
          else for (const w of p.split(/\s+/).filter(Boolean)) wt.push({ w, t: cur });
        });
      }
      const clean = rest.replace(/<\d{1,3}:\d{1,2}(?:\.\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
      for (const t of times) out.push({ t, text: clean, wt });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function buildModel(lines) {
    const M = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i], nx = lines[i + 1];
      const gap = nx ? Math.max(0.3, nx.t - ln.t) : 6;
      const text = ln.text;
      if (!text || /^[\s♪♫*.…-]*$/.test(text)) { M.push({ t: ln.t, next: ln.t + gap, dur: 0, empty: true, words: [] }); continue; }
      const words = text.split(/\s+/).filter(Boolean).map((w) => ({ w, t: 0, e: 0 }));
      let dur;
      if (ln.wt && ln.wt.length === words.length) {
        words.forEach((o, k) => { o.t = ln.wt[k].t == null ? ln.t : ln.wt[k].t; });
        dur = Math.min(gap * 0.95, words[words.length - 1].t - ln.t + 0.6);
      } else {
        const wts = words.map((o) => o.w.replace(/[^\p{L}\p{N}]/gu, '').length + 2);
        const total = wts.reduce((a, b) => a + b, 0);
        const est = 0.28 * words.length + 0.03 * text.length + 0.35;
        dur = Math.min(gap * 0.9, Math.max(est, Math.min(gap * 0.6, est * 1.8)));
        let acc = 0;
        words.forEach((o, k) => { o.t = ln.t + (dur * acc) / total; acc += wts[k]; });
      }
      words.forEach((o, k) => { o.e = k + 1 < words.length ? words[k + 1].t : ln.t + dur; });
      M.push({ t: ln.t, next: ln.t + gap, dur, text, words, empty: false });
    }
    return M;
  }
  function lineInfo(t) {
    const out = { idx: -1, line: null, visible: false, wordIdx: -1, next: null };
    if (!model || !model.length) return out;
    let lo = 0, hi = model.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (model[mid].t <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    out.idx = idx;
    out.next = model[idx + 1] || null;
    if (idx < 0) return out;
    const L = model[idx];
    out.line = L;
    if (!L.empty) {
      out.visible = t < Math.min(L.next, L.t + L.dur + 2.4);
      for (let k = 0; k < L.words.length; k++) if (L.words[k].t <= t) out.wordIdx = k;
    }
    return out;
  }
  async function fetchLyrics(override) {
    const id = ++reqId;
    setState('loading');
    let res;
    try {
      res = await findLyrics({ title: PL.title, artist: PL.artist, album: PL.album, duration: PL.duration }, override || null);
    } catch (e) {
      res = { kind: 'error', error: String((e && e.message) || e) };
    }
    if (id !== reqId) return;
    if (res.kind === 'synced') {
      const lines = parseLRC(res.synced);
      if (lines.length) {
        model = buildModel(lines);
        clearLayouts();
        setState('synced', res.approx ? 'Matched a different version — use − / + if it drifts' : '');
        if (!ls.get('hinted', false)) { ls.set('hinted', true); setTimeout(() => toast('Tap for controls · swipe for styles'), 800); }
        return;
      }
    }
    model = null;
    clearLayouts();
    if (res.kind === 'instrumental') return setState('instrumental');
    if (res.kind === 'plain') return setState('plain');
    if (res.kind === 'error') return setState('error', res.error);
    setState('none');
  }

  /* ================= beat (Android Visualizer) ================= */
  const A = { on: false, live: false, silent: 0, ref: 0.4, bass: 0, mid: 0, high: 0, level: 0, avg: 0, kick: 0, wkick: 0, lastBeat: 0, spec: new Float32Array(48) };
  function initBeat() {
    if (S.react && call('hasMic')) A.on = !!call('startBeat');
    else A.on = false;
    applySettingsUI();
  }
  window.onMicResult = (ok) => {
    hideSheet();
    if (ok) { S.react = true; save(); A.on = true; toast('Beat reaction on'); }
    else { A.on = false; toast('Beat reaction needs that permission'); }
    applySettingsUI();
  };
  function toggleReact() {
    if (S.react && A.on) { S.react = false; A.on = false; call('stopBeat'); toast('Beat reaction off'); }
    else if (call('hasMic')) {
      S.react = true;
      A.on = !!call('startBeat');
      toast(A.on ? 'Beat reaction on' : "Your phone blocked beat reaction — words still pulse");
    } else { showBeatSheet(); }
    save(); applySettingsUI();
  }
  function analyse(dt, now, playing) {
    const N = A.spec.length;
    let raw = null;
    if (S.react && A.on) { const s = call('fft'); if (s) raw = s.split(','); }
    if (raw && raw.length >= N) {
      const v = new Float32Array(N);
      let mx = 0, sum = 0;
      for (let k = 0; k < N; k++) { v[k] = (+raw[k] || 0) / 1000; sum += v[k]; if (v[k] > mx) mx = v[k]; }
      if (sum > 0.02) A.silent = 0; else if (playing) A.silent += dt;
      A.ref = Math.max(mx, A.ref * Math.exp(-dt * 0.35), 0.25); // auto-gain so quiet and loud phones look alike
      let bass = 0, mid = 0, high = 0;
      for (let k = 0; k < N; k++) {
        const x = Math.min(1, (v[k] / A.ref) * 0.9);
        A.spec[k] += (x - A.spec[k]) * (x > A.spec[k] ? 0.55 : 0.15);
        if (k < 10) bass += x; else if (k < 31) mid += x; else high += x;
      }
      bass /= 10; mid /= 21; high /= N - 31;
      A.bass = bass; A.mid += (mid - A.mid) * 0.3; A.high += (high - A.high) * 0.3;
      A.level += (bass * 0.55 + mid * 0.35 + high * 0.1 - A.level) * 0.2;
      A.avg += (bass - A.avg) * clamp(dt * 1.8, 0, 1);
      if (bass > A.avg * 1.12 + 0.03 && bass > 0.3 && now - A.lastBeat > 0.23) {
        A.kick = clamp(A.kick + 0.6 + (bass - A.avg) * 3, 0, 1);
        A.lastBeat = now;
      }
      A.live = A.silent < 2;
    } else A.live = false;
    if (!A.live) {
      const s = playing ? 1 : 0.35;
      for (let k = 0; k < N; k++) {
        const v = s * (0.2 + 0.14 * Math.sin(now * 1.3 + k * 0.45) * Math.sin(now * 0.7 + k * 0.13) + A.wkick * 0.12) * (1 - (k / N) * 0.55);
        A.spec[k] += (v - A.spec[k]) * 0.08;
      }
      A.level += ((playing ? 0.22 : 0.06) + A.wkick * 0.2 - A.level) * 0.1;
      A.high += (0.2 - A.high) * 0.05;
    }
    A.kick *= Math.exp(-dt * 7);
    A.wkick *= Math.exp(-dt * 6);
  }
  const pulse = () => (A.live ? Math.max(A.kick, A.wkick * 0.45) : A.wkick * 0.8);

  /* ================= UI ================= */
  const ui = {
    wrap: $('wrap'), cvs: $('cv'), art: $('art'), title: $('title'), artist: $('artist'), status: $('status'), msg: $('msg'),
    panel: $('panel'), toast: $('toast'), sheet: $('sheet'), card: $('sheetCard'), play: $('play'), beat: $('beat'), sync: $('sync'),
    modes: [...document.querySelectorAll('#modes button')],
    sources: [...document.querySelectorAll('#sources button')],
  };
  const g = ui.cvs.getContext('2d');
  let w = 0, h = 0, dpr = 1, lastNow = 0, panelTimer = 0, toastTimer = 0;

  function icon(d) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('on'), 1600);
  }
  function showPanel(on) {
    ui.panel.classList.toggle('off', !on);
    ui.wrap.classList.toggle('calm', !on);
    clearTimeout(panelTimer);
    if (on) panelTimer = setTimeout(() => showPanel(false), 5000);
  }
  function applySettingsUI() {
    const pal = PALS[S.pal] || PALS[0];
    document.documentElement.style.setProperty('--acc', pal.a);
    ui.modes.forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    ui.beat.classList.toggle('on', S.react && A.on);
    ui.sources.forEach((b) => b.classList.toggle('on', b.dataset.src === 'ytmusic' ? isYt(PL.pkg) : PL.pkg === 'com.spotify.music'));
  }
  function updateHud() {
    ui.title.textContent = PL.title || (PL.access ? 'Nothing playing' : '');
    ui.artist.textContent = PL.artist || '';
    if (PL.art) ui.art.src = PL.art; else ui.art.removeAttribute('src');
    ui.status.textContent = lyrState === 'loading' ? 'Finding lyrics…' : lyrInfo || (APP_NAMES[PL.pkg] ? 'Following ' + APP_NAMES[PL.pkg] : '');
  }
  function updateSync() {
    ui.sync.textContent = 'Sync ' + (offset > 0 ? '+' : offset < 0 ? '−' : '') + Math.abs(offset).toFixed(1) + 's';
  }
  function setState(s, info) {
    lyrState = s; lyrInfo = info || '';
    updateHud(); renderMsg();
  }
  const msgShown = () => lyrState === 'none' || lyrState === 'plain' || lyrState === 'error' || lyrState === 'nomedia';
  function renderMsg() {
    ui.msg.replaceChildren();
    const form = (label) => {
      const ti = el('input', { type: 'text', placeholder: 'Song title', 'aria-label': 'Song title', enterkeyhint: 'search' });
      const ar = el('input', { type: 'text', placeholder: 'Artist', 'aria-label': 'Artist', enterkeyhint: 'search' });
      ti.value = PL.title || ''; ar.value = PL.artist || '';
      return el('form', { on: { submit: (e) => { e.preventDefault(); document.activeElement && document.activeElement.blur(); if (ti.value.trim()) fetchLyrics({ title: ti.value.trim(), artist: ar.value.trim() }); } } },
        ti, ar, el('button', { class: 'go', type: 'submit' }, label));
    };
    const show = (title, text, extra) => ui.msg.append(el('h2', { text: title }), el('p', { text }), extra || null);
    const openBtn = (which, label, cls) => el('button', { class: cls || 'go', on: { click: () => call('openApp', which) } }, label);
    if (lyrState === 'nomedia') {
      const spSteps = el('details', {},
        el('summary', { text: 'Spotify: turn on one setting first' }),
        el('ol', {},
          el('li', { text: 'Open Spotify and tap your profile picture (top left).' }),
          el('li', { text: 'Go to Settings and privacy → Playback.' }),
          el('li', { text: 'Turn on “Device broadcast status”.' }),
          el('li', { text: 'Play any song, then come back here.' })));
      show('Play a song', 'Pick where your music is playing:',
        el('div', { class: 'stack' },
          el('button', { class: 'go', on: { click: () => call('ytMusic') } }, 'YT Music'),
          openBtn('spotify', 'Spotify', 'ghost'),
          PL.edition === 'standard' && !PL.spotifySeen ? spSteps : null,
          PL.ytApp !== 'connected' && PL.edition === 'standard' ? el('p', { class: 'small', text: 'YT Music opens inside Lyric Peak. Tap “✦ Lyrics” to come back to the lyrics while it keeps playing.' }) : null));
    }
    else if (lyrState === 'none') show('No synced lyrics for this one', `Couldn't find time-synced lyrics for “${PL.title}”. Try a different spelling:`, form('Search again'));
    else if (lyrState === 'plain') show('Lyrics found, but not time-synced', "This song only has plain lyrics in the database, so they can't follow the music. Try another version:", form('Search again'));
    else if (lyrState === 'error') show("Couldn't reach the lyrics service", lyrInfo || 'Check your internet and try again.', form('Try again'));
  }

  function hideSheet() { ui.sheet.classList.remove('on'); ui.sheet.dataset.kind = ''; }
  function renderSheet() {
    if (PL.access === false && PL.edition === 'plus' && !ls.get('skipAccess', false)) {
      ui.card.replaceChildren(
        el('h1', { class: 'logo', text: 'LYRIC PEAK+' }),
        el('p', { text: "Animated lyrics for whatever's playing in YT Music, Spotify or any player, moving to the beat." }),
        el('p', { class: 'small', text: "To see the song in YT Music, Android requires notification access. Lyric Peak doesn't read or keep your notifications." }),
        el('button', { class: 'go', on: { click: () => call('openAccessSettings') } }, 'Allow access'),
        el('button', { class: 'ghost', on: { click: () => { ls.set('skipAccess', true); hideSheet(); setState(model ? lyrState : 'nomedia'); } } }, 'Skip, I only use Spotify'),
        el('details', {},
          el('summary', { text: 'Switch greyed out, or it says “Restricted setting”?' }),
          el('ol', {},
            el('li', { text: 'Tap “Allow access” once and try the switch, so Android registers the attempt.' }),
            el('li', { text: 'Tap “Open app info” below, then ⋮ (top right) → “Allow restricted settings”.' }),
            el('li', { text: 'Come back here and tap “Allow access” again.' })),
          el('button', { class: 'ghost', on: { click: () => call('openAppInfo') } }, 'Open app info')));
      ui.sheet.dataset.kind = 'access';
      ui.sheet.classList.add('on');
    } else if (ui.sheet.dataset.kind === 'access' && (PL.access || ls.get('skipAccess', false))) {
      hideSheet();
      initBeat();
    }
  }
  function showBeatSheet() {
    ui.card.replaceChildren(
      el('h2', { text: 'Make it move with the beat?' }),
      el('p', { text: "Lyric Peak can listen to the music your phone is playing so the words punch, shake and glow on every beat." }),
      el('p', { class: 'small', text: 'Android lists this under the microphone permission. Nothing is recorded or saved, and the mic itself is not used.' }),
      el('button', { class: 'go', on: { click: () => call('requestMic') } }, 'Allow'),
      el('button', { class: 'ghost', on: { click: hideSheet } }, 'Not now'));
    ui.sheet.dataset.kind = 'beat';
    ui.sheet.classList.add('on');
  }

  function setMode(m, announce) { S.mode = m; save(); applySettingsUI(); clearLayouts(); if (announce) toast(MODES[m]); }
  function cyclePal() { S.pal = (S.pal + 1) % PALS.length; save(); applySettingsUI(); toast(PALS[S.pal].name); }
  function nudge(d) {
    offset = Math.round((offset + d) * 10) / 10;
    updateSync();
    clearTimeout(offTimer);
    const key = trackKey;
    offTimer = setTimeout(() => ls.set('off:' + key, offset), 600);
  }

  // controls
  const keepPanel = () => showPanel(true);
  ui.modes.forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); keepPanel(); }));
  ui.sources.forEach((b) => b.addEventListener('click', () => { if (b.dataset.src === 'ytmusic') call('ytMusic'); else call('openApp', 'spotify'); }));
  $('pal').addEventListener('click', () => { cyclePal(); keepPanel(); });
  ui.beat.addEventListener('click', () => { toggleReact(); keepPanel(); });
  $('later').addEventListener('click', () => { nudge(-0.1); keepPanel(); });
  $('sooner').addEventListener('click', () => { nudge(0.1); keepPanel(); });
  $('prev').addEventListener('click', () => { call('control', 'prev'); keepPanel(); });
  $('next').addEventListener('click', () => { call('control', 'next'); keepPanel(); });
  ui.play.addEventListener('click', () => { call('control', 'toggle'); keepPanel(); });

  // tap = show/hide controls, swipe left/right = change style
  let touch = null;
  ui.cvs.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  ui.cvs.addEventListener('pointerup', (e) => {
    if (!touch) return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      const i = MODE_KEYS.indexOf(S.mode);
      setMode(MODE_KEYS[(i + (dx < 0 ? 1 : MODE_KEYS.length - 1)) % MODE_KEYS.length], true);
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      showPanel(ui.panel.classList.contains('off'));
    }
  });

  window.onAppResume = () => { initBeat(); };

  function resize() {
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    w = window.innerWidth; h = window.innerHeight;
    ui.cvs.width = Math.max(1, Math.round(w * dpr));
    ui.cvs.height = Math.max(1, Math.round(h * dpr));
    clearLayouts();
  }
  window.addEventListener('resize', resize);

  /* ================= drawing helpers ================= */
  const peakCache = new Map(), starsCache = new Map();
  let flow = null, bgStars = null;
  function clearLayouts() { peakCache.clear(); starsCache.clear(); flow = null; bgStars = null; }
  const portrait = () => h > w * 1.15;

  let artFx = null;
  function setArt(src) {
    artFx = null;
    if (!src) return;
    const im = new Image();
    im.onload = () => {
      try {
        const s = document.createElement('canvas'); s.width = s.height = 32;
        s.getContext('2d').drawImage(im, 0, 0, 32, 32);
        const b = document.createElement('canvas'); b.width = b.height = 160;
        const bx = b.getContext('2d');
        bx.filter = 'blur(14px) saturate(1.4)';
        bx.drawImage(s, -20, -20, 200, 200);
        artFx = b;
      } catch (e) { artFx = null; }
    };
    im.src = src;
  }

  function edgeGlow(pal, k) {
    k = clamp(k, 0, 1.4);
    const s = Math.min(w, h) * 0.2;
    g.save();
    g.globalCompositeOperation = 'lighter';
    const sides = [[0, 0, 0, s, 0, 0, w, s], [0, h, 0, h - s, 0, h - s, w, s], [0, 0, s, 0, 0, 0, s, h], [w, 0, w - s, 0, w - s, 0, s, h]];
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, rgba(pal.A, 0.42 * k));
      gr.addColorStop(0.35, rgba(pal.A, 0.11 * k));
      gr.addColorStop(1, rgba(pal.A, 0));
      g.fillStyle = gr;
      g.fillRect(rx, ry, rw, rh);
    }
    g.restore();
  }

  function mountains(pal, alpha, invert, scaleH) {
    const N = A.spec.length, M = 100, H = Math.min(h * 0.26, w * 0.55) * scaleH;
    const pts = [];
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      let d = Math.abs(u - 0.5) * 2;
      if (invert) d = 1 - d;
      const f = d * (N - 1), k0 = Math.floor(f), fr = f - k0;
      const v = lerp(A.spec[k0], A.spec[Math.min(N - 1, k0 + 1)], fr);
      const taper = 1 - Math.pow(Math.abs(u - 0.5) * 2, 3) * 0.55;
      pts.push([u * w, h - (0.02 + Math.pow(v, 1.5) * 1.2 * taper) * H]);
    }
    const ridge = () => {
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < M; i++) g.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      g.lineTo(pts[M][0], pts[M][1]);
    };
    g.save();
    g.beginPath(); g.moveTo(0, h); g.lineTo(pts[0][0], pts[0][1]); ridge(); g.lineTo(w, h); g.closePath();
    const gr = g.createLinearGradient(0, h - H * 1.3, 0, h);
    gr.addColorStop(0, rgba(pal.A, 0.34 * alpha));
    gr.addColorStop(1, rgba(pal.A, 0.02 * alpha));
    g.fillStyle = gr; g.fill();
    g.beginPath(); ridge();
    g.strokeStyle = rgba(pal.B, 0.8 * alpha); g.lineWidth = 1.5;
    g.shadowColor = pal.a; g.shadowBlur = 14;
    g.stroke();
    g.restore();
  }

  function dots(cx, cy, now, P, prog, align) {
    const r = clamp(Math.min(w, h) * 0.014, 5, 10), gap = r * 3.4;
    const start = align === 'left' ? cx : cx - gap;
    for (let k = 0; k < 3; k++) {
      const ph = Math.sin(now * 3.2 - k * 0.8) * 0.5 + 0.5;
      const lit = clamp(prog * 3 - k, 0, 1);
      g.fillStyle = rgba(WHITE, 0.28 + 0.62 * lit);
      g.beginPath();
      g.arc(start + k * gap, cy, r * (1 + ph * 0.25 + P * 0.45 + lit * 0.2), 0, Math.PI * 2);
      g.fill();
    }
  }
  function gapProgress(t, info) {
    if (!model || !info.next) return -1;
    const prev = info.line;
    const from = prev ? (prev.empty ? prev.t : Math.min(prev.next, prev.t + prev.dur + 2.4)) : 0;
    const len = info.next.t - from;
    if (len < 2.5) return -1;
    return clamp((t - from) / len, 0, 1);
  }
  function titleCard(pal, P, alpha) {
    if (!PL.title || alpha <= 0) return;
    const maxW = Math.min(w * 0.84, 1100);
    let size = clamp(Math.min(w * (portrait() ? 0.16 : 0.1), h * 0.17), 36, 160);
    const txt = PL.title.toUpperCase();
    g.font = `400 ${size}px ${FONT_PEAK}`;
    const tw = g.measureText(txt).width;
    if (tw > maxW) { size *= maxW / tw; g.font = `400 ${size}px ${FONT_PEAK}`; }
    const sub = clamp(size * 0.22, 15, 26);
    const s = 1 + P * 0.035;
    g.save();
    g.globalAlpha = alpha;
    g.translate(w / 2, h * 0.45); g.scale(s, s);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.shadowColor = pal.a; g.shadowBlur = 30 + P * 30;
    g.fillStyle = '#fff';
    g.fillText(txt, 0, size * CAP * 0.5);
    g.shadowBlur = 0;
    g.font = `600 ${sub}px ${FONT_UI}`;
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText(PL.artist || '', 0, size * CAP * 0.5 + sub * 2);
    g.restore();
  }
  function idleVisual(t, now, pal, info, P, cx, cy, align) {
    if (msgShown()) return;
    if (!model) { titleCard(pal, P, 1); return; }
    if (info.idx < 0 && info.next && info.next.t - t > 3) { titleCard(pal, P, clamp((info.next.t - t - 3) / 1.5, 0, 1)); return; }
    const gp = gapProgress(t, info);
    if (gp >= 0) dots(cx, cy, now, P, gp, align);
  }

  /* ================= style 1: PEAK ================= */
  const SMALL = new Set('A AN THE TO OF IN ON AT BY FOR AND OR BUT SO AS IF I IT IS ITS IM MY ME WE US BE DO UP OH UH YA NO'.split(' '));
  function layoutPeak(L) {
    let lay = peakCache.get(L);
    if (lay) return lay;
    const tall = portrait();
    const maxW = Math.min(w * (tall ? 0.86 : 0.84), 1280);
    const base = clamp(Math.min(w * (tall ? 0.1 : 0.085), h * 0.12), 30, 132);
    const gapK = 0.24;
    const items = L.words.map((o, i) => {
      const txt = o.w.toUpperCase();
      const k = SMALL.has(txt.replace(/[^A-Z]/g, '')) ? 0.62 : 1;
      g.font = `400 ${base * k}px ${FONT_PEAK}`;
      return { i, txt, k, nat: g.measureText(txt).width };
    });
    const rows = [];
    let row = [], rw = 0;
    for (const it of items) {
      const add = (row.length ? base * gapK : 0) + it.nat;
      const bigs = row.filter((r) => r.k === 1).length;
      if (row.length && (rw + add > maxW * 0.9 || (bigs >= 2 && it.k === 1))) { rows.push({ items: row, nat: rw }); row = []; rw = 0; }
      rw += (row.length ? base * gapK : 0) + it.nat;
      row.push(it);
    }
    if (row.length) rows.push({ items: row, nat: rw });
    for (let r = rows.length - 1; r > 0; r--) {
      if (rows[r].items.every((it) => it.k < 1)) { rows[r - 1].nat += base * gapK + rows[r].nat; rows[r - 1].items.push(...rows[r].items); rows.splice(r, 1); }
    }
    const blockW = clamp(Math.max(...rows.map((r) => r.nat)), maxW * (w < 760 ? 0.92 : 0.55), maxW);
    const lead = base * 0.16;
    const sized = rows.map((r) => {
      const s = clamp(blockW / r.nat, 0.6, tall ? 2.8 : 2.3);
      return { ...r, s, hgt: base * Math.max(...r.items.map((it) => it.k)) * s * CAP };
    });
    const total = sized.reduce((a, r) => a + r.hgt, 0) + lead * (sized.length - 1);
    const widest = Math.max(...sized.map((r) => r.nat * r.s));
    const fit = Math.min(1, (h * (tall ? 0.5 : 0.6)) / total, (w * 0.92) / widest);
    const cy = h * 0.46;
    let y = cy - (total * fit) / 2;
    const words = [];
    for (const r of sized) {
      const s = r.s * fit, rowH = r.hgt * fit;
      let x = (w - r.nat * s) / 2;
      for (const it of r.items) {
        const size = base * it.k * s, wdt = it.nat * s;
        words[it.i] = { txt: it.txt, x, y: y + rowH, size, wdt, cx: x + wdt / 2, cy: y + rowH - (size * CAP) / 2 };
        x += wdt + base * gapK * s;
      }
      y += rowH + lead * fit;
    }
    lay = { words, cy };
    peakCache.set(L, lay);
    return lay;
  }
  function peakXf(style, e, size) {
    if (style === 0) return { sc: lerp(1.55, 1, e), dy: 0 };
    if (style === 1) return { sc: 1, dy: lerp(size * 0.5, 0, e) };
    return { sc: lerp(0.8, 1, e), dy: lerp(-size * 0.5, 0, e) };
  }
  function peakWord(W, p, i, newest, pal, P) {
    const style = i % 3;
    const a = clamp(p / 0.3, 0, 1);
    const put = (xf, alpha, ox, fill) => {
      g.save();
      g.globalAlpha *= alpha;
      g.translate(W.cx + ox, W.cy + xf.dy);
      g.scale(xf.sc, xf.sc);
      g.translate(-W.cx, -W.cy);
      g.fillStyle = fill;
      g.fillText(W.txt, W.x, W.y);
      g.restore();
    };
    g.font = `400 ${W.size}px ${FONT_PEAK}`;
    if (p < 1) for (let k = 3; k >= 1; k--) put(peakXf(style, ease.outBack(clamp(p - k * 0.06, 0, 1)), W.size), 0.14 * a, 0, '#ffffff');
    const xf = peakXf(style, ease.outBack(p), W.size);
    if (newest) {
      const split = 1.5 + P * 9;
      if (P > 0.08) {
        put(xf, 0.75 * clamp(P * 1.6, 0, 1) * a, -split, 'rgb(255,40,70)');
        put(xf, 0.75 * clamp(P * 1.6, 0, 1) * a, split, 'rgb(40,230,255)');
      }
      g.save();
      g.shadowColor = pal.a; g.shadowBlur = 22 + P * 34;
      put(xf, a, 0, '#ffffff');
      g.restore();
    } else {
      put(xf, a * 0.62, 0, '#ffffff');
    }
  }
  function peakLine(L, t, pal, P, ex, wi) {
    const lay = layoutPeak(L);
    const exiting = ex > 0;
    if (exiting) wi = L.words.length - 1;
    g.save();
    if (exiting) {
      const e = ease.outCubic(ex);
      g.globalAlpha = 1 - e;
      g.translate(w / 2, lay.cy - e * h * 0.06);
      g.scale(1 + 0.2 * e, 1 + 0.2 * e);
      g.translate(-w / 2, -lay.cy);
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    for (let i = 0; i < lay.words.length; i++) {
      const W = lay.words[i];
      if (i > wi) {
        g.font = `400 ${W.size}px ${FONT_PEAK}`;
        g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.1)';
        g.strokeText(W.txt, W.x, W.y);
        continue;
      }
      const p = exiting ? 1 : clamp((t - L.words[i].t) / 0.34, 0, 1);
      peakWord(W, p, i, !exiting && i === wi, pal, P);
    }
    g.restore();
  }
  let peakShown = null, peakExit = [];
  function drawPeak(t, dt, now, pal, info, P) {
    mountains(pal, 0.45, true, 0.7);
    mountains(pal, 1, false, 1);
    edgeGlow(pal, 0.3 + A.level * 0.9 + P * 0.35);
    const cur = info.visible ? info.line : null;
    if (cur !== peakShown) { if (peakShown) peakExit.push({ L: peakShown, at: now }); peakShown = cur; }
    peakExit = peakExit.filter((e) => now - e.at < 0.5);
    const shake = P * 6;
    const sx = (Math.sin(now * 91.7) + Math.sin(now * 53.3)) * 0.5 * shake;
    const sy = (Math.cos(now * 77.1) + Math.sin(now * 41.9)) * 0.5 * shake;
    const zoom = 1 + P * 0.04;
    g.save();
    g.translate(w / 2 + sx, h * 0.46 + sy); g.scale(zoom, zoom); g.translate(-w / 2, -h * 0.46);
    for (const e of peakExit) peakLine(e.L, t, pal, P, (now - e.at) / 0.5, 0);
    if (cur) peakLine(cur, t, pal, P, 0, info.wordIdx);
    g.restore();
    if (!cur) idleVisual(t, now, pal, info, P, w / 2, h * 0.46, 'center');
  }

  /* ================= style 2: FLOW ================= */
  let flowScroll = null;
  function layoutFlow() {
    if (flow) return flow;
    const tall = portrait();
    const size = clamp(Math.min(w * (tall ? 0.078 : 0.045), h * 0.075), 24, 60);
    const maxW = Math.min(w * (tall ? 0.86 : 0.8), 1100);
    const lh = size * 1.2, gapL = size * 0.8;
    g.font = `700 ${size}px ${FONT_UI}`;
    const space = g.measureText(' ').width;
    let top = 0;
    const lines = model.map((L) => {
      if (L.empty) {
        const show = L.next - L.t > 4;
        const o = { L, top, hgt: show ? size : 0, words: [], dots: show };
        top += show ? size + gapL : 0;
        return o;
      }
      const words = [];
      let x = 0, row = 0;
      L.words.forEach((wd, i) => {
        const ww = g.measureText(wd.w).width;
        if (x > 0 && x + ww > maxW) { x = 0; row++; }
        words.push({ i, txt: wd.w, x, row, wdt: ww });
        x += ww + space;
      });
      const o = { L, top, hgt: (row + 1) * lh, words };
      top += o.hgt + gapL;
      return o;
    });
    flow = { size, lh, x0: (w - maxW) / 2, lines };
    return flow;
  }
  function drawFlowBg(pal, now, P) {
    if (artFx) {
      const s = Math.max(w, h) * (1.35 + P * 0.04 + Math.sin(now * 0.12) * 0.04);
      g.save();
      g.globalAlpha = 0.6;
      g.translate(w / 2, h / 2); g.rotate(now * 0.025);
      g.drawImage(artFx, -s / 2, -s / 2, s, s);
      g.restore();
      g.fillStyle = 'rgba(5,5,7,0.5)';
      g.fillRect(0, 0, w, h);
    } else {
      const R = Math.max(w, h) * 0.6;
      [[pal.A, 0.3, 0.3, 0.0], [pal.B, 0.75, 0.65, 2.1], [pal.A, 0.6, 0.15, 4.2]].forEach(([c, fx, fy, ph]) => {
        const x = w * (fx + Math.sin(now * 0.15 + ph) * 0.12), y = h * (fy + Math.cos(now * 0.11 + ph) * 0.12);
        const gr = g.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, rgba(c, 0.22 + A.level * 0.15)); gr.addColorStop(1, rgba(c, 0));
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      });
    }
  }
  function drawFlow(t, dt, now, pal, info, P) {
    drawFlowBg(pal, now, P);
    edgeGlow(pal, 0.2 + A.level * 0.6 + P * 0.25);
    if (!model) { if (!msgShown()) titleCard(pal, P, 1); return; }
    const F = layoutFlow();
    const ci = Math.max(0, info.idx);
    const FL0 = F.lines[ci];
    const target = info.idx < 0 ? F.lines[0].top - F.size * 2 : FL0.top + FL0.hgt / 2;
    if (flowScroll == null || Math.abs(target - flowScroll) > h * 4) flowScroll = target;
    flowScroll += (target - flowScroll) * (1 - Math.exp(-dt * 5));
    const anchor = h * 0.44;
    g.textBaseline = 'top'; g.textAlign = 'left';
    for (let li = 0; li < F.lines.length; li++) {
      const FL = F.lines[li];
      const y0 = anchor + FL.top - flowScroll;
      if (y0 > h + 60 || y0 + FL.hgt < -60) continue;
      if (FL.L.empty) {
        if (FL.dots) dots(F.x0 + F.size * 0.25, y0 + FL.hgt / 2, now, li === info.idx ? P : 0, li === info.idx ? clamp((t - FL.L.t) / (FL.L.next - FL.L.t), 0, 1) : 0, 'left');
        continue;
      }
      const isCur = li === info.idx && info.visible;
      const dist = Math.abs(li - info.idx);
      const dim = li < info.idx ? clamp(0.32 - (dist - 1) * 0.06, 0.08, 0.32) : clamp(0.4 - (dist - 1) * 0.07, 0.1, 0.4);
      const sc = isCur ? 1 : 0.93;
      g.save();
      g.translate(F.x0, y0); g.scale(sc, sc);
      g.font = `700 ${F.size}px ${FONT_UI}`;
      for (const W of FL.words) {
        const wy = W.row * F.lh;
        if (!isCur) { g.fillStyle = rgba(WHITE, li === info.idx ? 0.5 : dim); g.fillText(W.txt, W.x, wy); continue; }
        const wd = FL.L.words[W.i];
        const prog = clamp((t - wd.t) / Math.max(0.08, wd.e - wd.t), 0, 1);
        const lift = -Math.min(1, prog * 2) * F.size * 0.06;
        if (prog <= 0) { g.fillStyle = 'rgba(255,255,255,0.34)'; g.fillText(W.txt, W.x, wy); continue; }
        let fill = '#ffffff';
        if (prog < 1) {
          fill = g.createLinearGradient(W.x, 0, W.x + W.wdt, 0);
          fill.addColorStop(0, '#ffffff');
          fill.addColorStop(clamp(prog - 0.06, 0, 1), '#ffffff');
          fill.addColorStop(clamp(prog + 0.06, 0, 1), 'rgba(255,255,255,0.34)');
          fill.addColorStop(1, 'rgba(255,255,255,0.34)');
        }
        g.save();
        if (W.i === info.wordIdx) { g.shadowColor = rgba(pal.A, 0.9 * prog); g.shadowBlur = 14 + P * 26; }
        g.fillStyle = fill;
        g.fillText(W.txt, W.x, wy + lift);
        g.restore();
      }
      g.restore();
    }
  }

  /* ================= style 3: CONSTELLATION ================= */
  function layoutStars(L) {
    let lay = starsCache.get(L);
    if (lay) return lay;
    const R = rng(((L.t * 1000) | 0) + 17);
    const n = L.words.length, m = Math.min(w, h), pts = [];
    const tall = portrait();
    // along the long side of the screen, scattered across the short side
    const a0 = tall ? h * 0.2 : w * 0.12, a1 = tall ? h * 0.72 : w * 0.8;
    const b0 = tall ? w * 0.14 : h * 0.24, b1 = tall ? w * 0.86 : h * 0.72;
    for (let i = 0; i < n; i++) {
      let best = null, bestS = -1;
      for (let k = 0; k < 24; k++) {
        const u = n === 1 ? 0.4 : i / (n - 1);
        const along = clamp(lerp(a0, a1, u) + (R() - 0.5) * (a1 - a0) * 0.22, a0, a1);
        const across = lerp(b0, b1, R());
        const x = tall ? across : along, y = tall ? along : across;
        let dmin = m;
        for (const p of pts) dmin = Math.min(dmin, Math.hypot(p.x - x, p.y - y));
        const prev = pts[i - 1];
        const far = prev && Math.hypot(prev.x - x, prev.y - y) > m * 0.16 ? m * 0.1 : 0;
        const s = Math.min(dmin, m * 0.3) + far;
        if (s > bestS) { bestS = s; best = { x, y }; }
      }
      pts.push(best);
    }
    lay = { pts };
    starsCache.set(L, lay);
    return lay;
  }
  function sparkle(x, y, r) {
    const k = r * 0.22;
    g.beginPath();
    g.moveTo(x, y - r);
    g.quadraticCurveTo(x + k, y - k, x + r, y);
    g.quadraticCurveTo(x + k, y + k, x, y + r);
    g.quadraticCurveTo(x - k, y + k, x - r, y);
    g.quadraticCurveTo(x - k, y - k, x, y - r);
    g.closePath();
    g.fill();
  }
  function starfield(now) {
    if (!bgStars) { const R = rng(99); bgStars = Array.from({ length: 170 }, () => ({ x: R(), y: R(), r: 0.5 + R() * 1.2, ph: R() * 6.28, sp: 0.6 + R() * 2 })); }
    for (const s of bgStars) {
      g.fillStyle = rgba(WHITE, (0.1 + 0.3 * (0.5 + 0.5 * Math.sin(now * s.sp + s.ph))) * (0.6 + A.high * 1.6));
      g.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
  }
  function constellation(L, t, pal, P, ex, wi) {
    const lay = layoutStars(L), m = Math.min(w, h);
    const exiting = ex > 0;
    if (exiting) wi = L.words.length - 1;
    g.save();
    if (exiting) { const e = ease.outCubic(ex); g.globalAlpha = 1 - e; g.translate(w / 2, h / 2); g.scale(1 + e * 0.08, 1 + e * 0.08); g.translate(-w / 2, -h / 2); }
    g.lineWidth = 1; g.strokeStyle = 'rgba(235,235,245,0.5)';
    for (let i = 1; i <= wi; i++) {
      const a = lay.pts[i - 1], b = lay.pts[i];
      const p = exiting ? 1 : ease.outCubic(clamp((t - L.words[i].t) / 0.35, 0, 1));
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(lerp(a.x, b.x, p), lerp(a.y, b.y, p)); g.stroke();
    }
    const bigSize = clamp(m * 0.1, 30, 84);
    g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    for (let i = 0; i <= wi; i++) {
      const pt = lay.pts[i], wd = L.words[i];
      const age = exiting ? 9 : t - wd.t;
      const appear = exiting ? 1 : clamp(age / 0.2, 0, 1);
      let big;
      if (!exiting && i === wi) big = ease.outBack(appear);
      else big = 1 - ease.outCubic(clamp((t - (L.words[i + 1] ? L.words[i + 1].t : wd.e)) / 0.3, 0, 1));
      if (exiting) big = 0;
      const bc = clamp(big, 0, 1);
      const r = lerp(4.5, 11 + P * 6, clamp(big, 0, 1.1)) * (0.4 + 0.6 * appear);
      g.save();
      if (bc > 0.05) { g.shadowColor = pal.a; g.shadowBlur = 24 * bc + P * 20; }
      g.fillStyle = bc > 0.05 ? rgba(pal.B, 0.95) : 'rgba(225,225,238,0.9)';
      sparkle(pt.x, pt.y, r);
      g.restore();
      const txt = wd.w.toLowerCase();
      const size = lerp(13, bigSize, bc);
      g.font = `${bc > 0.5 ? 700 : 600} ${size}px ${FONT_UI}`;
      const tw = g.measureText(txt).width;
      const smallX = pt.x - tw / 2, smallY = pt.y + 22;
      let bigX = pt.x < w * 0.58 ? pt.x + 18 : pt.x - 18 - tw;
      bigX = clamp(bigX, 12, w - 12 - tw);
      const bigY = pt.y + size * 0.95;
      g.fillStyle = rgba(WHITE, lerp(0.62, 0.96, bc) * appear);
      g.fillText(txt, lerp(smallX, bigX, bc), lerp(smallY, bigY, bc));
    }
    g.restore();
  }
  let starsShown = null, starsExit = [];
  function drawStars(t, dt, now, pal, info, P) {
    starfield(now);
    edgeGlow(pal, 0.45 + A.level * 0.9 + P * 0.3);
    const cur = info.visible ? info.line : null;
    if (cur !== starsShown) { if (starsShown) starsExit.push({ L: starsShown, at: now }); starsShown = cur; }
    starsExit = starsExit.filter((e) => now - e.at < 0.7);
    for (const e of starsExit) constellation(e.L, t, pal, P, (now - e.at) / 0.7, 0);
    if (cur) constellation(cur, t, pal, P, 0, info.wordIdx);
    else idleVisual(t, now, pal, info, P, w / 2, h / 2, 'center');
  }

  /* ================= frame loop ================= */
  let lastWordKey = '', warned = false;
  function frame(ms) {
    requestAnimationFrame(frame);
    const now = ms / 1000;
    const dt = lastNow ? clamp(now - lastNow, 0, 0.1) : 0.016;
    lastNow = now;
    const t = curTime() + offset;
    analyse(dt, now, PL.playing);
    const info = lineInfo(t);
    const wk = info.visible && info.wordIdx >= 0 ? info.idx + ':' + info.wordIdx : '';
    if (wk && wk !== lastWordKey) A.wkick = 1;
    lastWordKey = wk;
    const pal = PALS[S.pal] || PALS[0];
    const P = pulse();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.shadowBlur = 0;
    g.fillStyle = '#050507';
    g.fillRect(0, 0, w, h);
    try {
      if (S.mode === 'flow') drawFlow(t, dt, now, pal, info, P);
      else if (S.mode === 'stars') drawStars(t, dt, now, pal, info, P);
      else drawPeak(t, dt, now, pal, info, P);
    } catch (e) {
      if (!warned) { warned = true; console.warn('[Lyric Peak] draw error', e); }
    }
  }

  /* ================= start ================= */
  resize();
  applySettingsUI();
  updateSync();
  updateHud();
  Promise.all(['400 40px "LP Anton"', '700 40px "LP Inter"', '600 40px "LP Inter"'].map((f) => document.fonts.load(f).catch(() => null)))
    .then(() => clearLayouts());
  if (!AND) { PL.access = true; PL.edition = 'plus'; setState('nomedia'); }
  call('ready');
  initBeat();
  requestAnimationFrame(frame);
})();
