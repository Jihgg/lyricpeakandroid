// Lyric Peak (web) — the player layer for iPhone / any browser.
// It plays the same role as MainActivity.java on Android: it feeds window.onPlayer() with what is playing
// and answers the few "native" calls that app.js makes (httpGet, control, beat/FFT, openApp).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked */ } },
  };
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };

  const W = {};            // exposed as window.LPWeb; app.js calls these through its `call()` helper
  window.LPWeb = W;
  W.alt = null;            // swapped "title - artist" guess for lyric lookup

  let mode = '';           // '' | 'yt' | 'sp'
  const push = (o) => window.onPlayer && window.onPlayer(Object.assign({ access: true, edition: 'web', spotifySeen: true }, o));

  /* ---------- small UI helpers (the sheet element lives in index.html) ---------- */
  function showSheet(...nodes) {
    $('sheetCard').replaceChildren(...nodes.flat().filter(Boolean));
    $('sheet').dataset.kind = 'web';
    $('sheet').classList.add('on');
  }
  function hideSheet() { $('sheet').classList.remove('on'); $('sheet').dataset.kind = ''; }
  let toastT = 0;
  function say(text) {
    const t = $('toast');
    t.textContent = text; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400);
  }
  const btn = (cls, text, fn) => el('button', { class: cls, type: 'button', on: { click: fn } }, text);

  /* ---------- keep the screen awake while lyrics play ---------- */
  let wake = null;
  async function keepAwake() {
    try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (mode) keepAwake(); if (mode === 'sp') spPoll(true); }
  });

  /* ---------- native-call shim ---------- */
  W.edition = () => 'web';
  W.ready = () => { setTimeout(boot, 0); };
  W.httpGet = (url, id) => {
    if (!/^https:\/\/lrclib\.net\//.test(url)) { window.onHttp(id, 0, ''); return; }
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(async (r) => window.onHttp(id, r.status, await r.text()))
      .catch(() => window.onHttp(id, 0, ''));
  };
  W.openApp = (which) => { if (which === 'spotify') spotifyEntry(); else youtubeSheet(); };
  W.control = (cmd) => {
    if (mode === 'yt' && yt.p && yt.ready) {
      if (cmd === 'toggle') { yt.p.getPlayerState() === 1 ? yt.p.pauseVideo() : yt.p.playVideo(); }
      else if (cmd === 'prev') yt.p.seekTo(0, true);
      else if (cmd === 'next') say('Paste another link to change song');
    } else if (mode === 'sp') {
      const ep = { toggle: sp.playing ? ['PUT', 'pause'] : ['PUT', 'play'], prev: ['POST', 'previous'], next: ['POST', 'next'] }[cmd];
      if (ep) spApi(ep[0], '/me/player/' + ep[1]).then((r) => { if (r && r.status === 403) say('Spotify only lets Premium accounts control playback from here'); setTimeout(() => spPoll(true), 600); });
    }
  };

  /* ---------- beat from the microphone (optional) ---------- */
  const mic = { stream: null, ctx: null, an: null, buf: null };
  W.hasMic = () => !!mic.stream;
  W.startBeat = () => !!mic.stream;
  W.stopBeat = () => {
    if (mic.stream) { mic.stream.getTracks().forEach((t) => t.stop()); }
    if (mic.ctx) { try { mic.ctx.close(); } catch (e) { /* ignore */ } }
    mic.stream = mic.ctx = mic.an = mic.buf = null;
  };
  W.requestMic = async () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const an = ctx.createAnalyser();
      an.fftSize = 2048; an.smoothingTimeConstant = 0.45;
      ctx.createMediaStreamSource(stream).connect(an);
      Object.assign(mic, { stream, ctx, an, buf: new Uint8Array(an.frequencyBinCount) });
      window.onMicResult(true);
    } catch (e) { window.onMicResult(false); }
  };
  const BANDS = 48;
  W.fft = () => {
    if (!mic.an) return '';
    mic.an.getByteFrequencyData(mic.buf);
    const nyq = mic.ctx.sampleRate / 2, n = mic.buf.length, out = new Array(BANDS);
    const lo = 40, hi = Math.min(12000, nyq - 100);
    for (let k = 0; k < BANDS; k++) {
      const f0 = lo * Math.pow(hi / lo, k / BANDS), f1 = lo * Math.pow(hi / lo, (k + 1) / BANDS);
      const b0 = Math.max(0, Math.floor((f0 / nyq) * n)), b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * n));
      let m = 0;
      for (let b = b0; b < b1 && b < n; b++) if (mic.buf[b] > m) m = mic.buf[b];
      out[k] = Math.round((m / 255) * 1000);
    }
    return out.join(',');
  };

  /* =================================================================
     YouTube (play inside the page)
     ================================================================= */
  const yt = { p: null, ready: false, id: '', meta: null, art: '', timer: 0, apiLoading: false, queued: '' };

  function videoId(input) {
    const s = String(input || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return ''; }
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0].slice(0, 11);
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
    return '';
  }

  function parseMeta(title, author) {
    const t = String(title || '').replace(/\s*\|.*$/, '').trim();
    const a = String(author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*(official|music)\s*$/i, '').trim();
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim(), alt: { artist: m[2].trim(), title: m[1].trim() } };
    return { artist: a, title: t, alt: null };
  }

  function loadYtApi() {
    return new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
      if (!yt.apiLoading) {
        yt.apiLoading = true;
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { yt.apiLoading = false; say("Couldn't reach YouTube"); };
        document.head.append(s);
      }
    });
  }

  async function playYoutube(input) {
    const id = videoId(input);
    if (!id) { say('That does not look like a YouTube link'); return false; }
    stopSpotify();
    mode = 'yt';
    keepAwake();
    yt.id = id; yt.meta = null; W.alt = null;
    $('ytbox').classList.add('on');
    hideSheet();
    say('Loading…');
    // title / artist from YouTube's own oEmbed (works from the browser)
    fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('oembed ' + r.status))))
      .then((j) => {
        if (yt.id !== id) return;
        const m = parseMeta(j.title, j.author_name);
        yt.meta = Object.assign(m, { thumb: j.thumbnail_url || 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' });
        W.alt = m.alt;
      })
      .catch(() => { say("Couldn't read that video. Is it private or blocked?"); });
    await loadYtApi();
    if (yt.id !== id) return true;
    if (!yt.p) {
      yt.p = new window.YT.Player('ytp', {
        width: '200', height: '113', videoId: id,
        playerVars: { playsinline: 1, autoplay: 1, controls: 1, rel: 0, modestbranding: 1, fs: 0, origin: location.origin },
        events: {
          onReady: () => { yt.ready = true; try { if (yt.id !== id) yt.p.loadVideoById(yt.id); else yt.p.playVideo(); } catch (e) { /* needs a tap */ } },
          onError: () => say('YouTube would not play that one (embedding is off for it)'),
        },
      });
    } else if (yt.ready) {
      yt.p.loadVideoById(id);
    }
    clearInterval(yt.timer);
    yt.timer = setInterval(ytTick, 250);
    setTimeout(() => { if (mode === 'yt' && yt.id === id && yt.ready && yt.p.getPlayerState() !== 1 && yt.p.getPlayerState() !== 3) say('Tap the small video once to start'); }, 3500);
    return true;
  }

  function ytTick() {
    if (mode !== 'yt' || !yt.ready || !yt.meta || !yt.p.getDuration) return;
    const vd = yt.p.getVideoData && yt.p.getVideoData();
    if (vd && vd.video_id && vd.video_id !== yt.id) return;
    const dur = yt.p.getDuration();
    if (!(dur > 0)) return;
    const st = yt.p.getPlayerState();
    const o = {
      title: yt.meta.title, artist: yt.meta.artist, album: '',
      duration: dur * 1000, position: yt.p.getCurrentTime() * 1000,
      playing: st === 1, speed: yt.p.getPlaybackRate ? yt.p.getPlaybackRate() : 1, pkg: 'ytweb',
    };
    if (yt.art !== yt.meta.thumb) { yt.art = yt.meta.thumb; o.art = yt.art; }
    push(o);
  }

  function youtubeSheet(errText) {
    const inp = el('input', { type: 'url', placeholder: 'Paste a YouTube or YT Music link', 'aria-label': 'YouTube link', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
    const go = () => { if (!inp.value.trim()) return; document.activeElement && document.activeElement.blur(); playYoutube(inp.value); };
    const pasteGo = async () => {
      try { const t = await navigator.clipboard.readText(); if (t) { inp.value = t; go(); return; } } catch (e) { /* denied */ }
      inp.focus();
    };
    showSheet(
      el('h2', {}, 'Play any song'),
      el('p', {}, 'In YouTube Music or YouTube open the song, tap Share → Copy link, then come back here.'),
      errText ? el('p', { class: 'err' }, errText) : null,
      el('form', { on: { submit: (e) => { e.preventDefault(); go(); } }, class: 'stack' },
        inp,
        el('button', { class: 'go', type: 'submit' }, 'Play'),
        btn('ghost', 'Paste from clipboard and play', pasteGo)),
      el('p', { class: 'small' }, 'The song plays right here, so ads may show unless your YouTube is ad-free.'),
      btn('ghost', 'Close', hideSheet));
    setTimeout(() => inp.focus(), 50);
  }

  /* =================================================================
     Spotify (follow what the Spotify app is playing)
     ================================================================= */
  const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
  const sp = { client: ls.get('spClient', ''), tok: ls.get('spTok', null), timer: 0, playing: false, last: '', backoff: 0, art: '', fail: 0 };
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function spLogin() {
    const arr = crypto.getRandomValues(new Uint8Array(48));
    const verifier = b64url(arr);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    ls.set('spVer', verifier);
    const q = new URLSearchParams({ response_type: 'code', client_id: sp.client, scope: SCOPES, redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge });
    location.href = 'https://accounts.spotify.com/authorize?' + q;
  }
  async function spToken(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.assign({ client_id: sp.client }, params)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'Spotify login failed');
    sp.tok = { access: j.access_token, refresh: j.refresh_token || (sp.tok && sp.tok.refresh) || '', exp: Date.now() + (j.expires_in - 60) * 1000 };
    ls.set('spTok', sp.tok);
  }
  async function spAccess() {
    if (!sp.tok) return '';
    if (Date.now() > sp.tok.exp) {
      if (!sp.tok.refresh) { sp.tok = null; ls.del('spTok'); return ''; }
      try { await spToken({ grant_type: 'refresh_token', refresh_token: sp.tok.refresh }); } catch (e) { sp.tok = null; ls.del('spTok'); return ''; }
    }
    return sp.tok.access;
  }
  async function spApi(method, path) {
    const t = await spAccess();
    if (!t) return null;
    try { return await fetch('https://api.spotify.com/v1' + path, { method, headers: { Authorization: 'Bearer ' + t } }); } catch (e) { return null; }
  }

  async function spPoll(now) {
    clearTimeout(sp.timer);
    if (mode !== 'sp') return;
    let delay = sp.playing ? 3000 : 5000;
    const t0 = performance.now();
    const r = await spApi('GET', '/me/player/currently-playing?additional_types=episode');
    if (mode !== 'sp') return;
    if (!r) {
      if (!sp.tok) { stopSpotify(); spotifySheet('Spotify signed you out. Connect again.'); return; }
      sp.fail++; delay = 6000;
      if (sp.fail === 3) say('No connection to Spotify');
    } else if (r.status === 204) {
      sp.fail = 0; sp.playing = false;
    } else if (r.status === 200) {
      sp.fail = 0;
      const rtt = performance.now() - t0;
      const j = await r.json().catch(() => null);
      const it = j && j.item;
      if (it) {
        sp.playing = !!j.is_playing;
        const o = {
          title: it.name, artist: (it.artists || []).map((a) => a.name).join(', ') || (it.show && it.show.publisher) || '',
          album: (it.album && it.album.name) || '', duration: it.duration_ms, position: (j.progress_ms || 0) + (j.is_playing ? rtt / 2 : 0),
          playing: !!j.is_playing, speed: 1, pkg: 'com.spotify.music',
        };
        const imgs = (it.album && it.album.images) || (it.images) || [];
        const art = (imgs[1] || imgs[0] || {}).url || '';
        if (art !== sp.art) { sp.art = art; o.art = art; }
        W.alt = null;
        push(o);
      } else sp.playing = false;
    } else if (r.status === 401) {
      sp.tok.exp = 0; delay = 500;
    } else if (r.status === 403) {
      stopSpotify();
      spotifySheet("Spotify says this account isn't allowed. Add your Spotify email to the app's User management list (and the app owner needs Premium).");
      return;
    } else if (r.status === 429) {
      delay = (parseInt(r.headers.get('Retry-After'), 10) || 10) * 1000 + 500;
    } else { delay = 8000; }
    sp.timer = setTimeout(() => spPoll(), now ? Math.min(delay, 3000) : delay);
  }

  function startSpotify() {
    if (mode === 'yt') stopYoutube();
    mode = 'sp';
    keepAwake();
    sp.last = ''; sp.art = '';
    spPoll(true);
  }
  function stopSpotify() { clearTimeout(sp.timer); if (mode === 'sp') mode = ''; }
  function stopYoutube() {
    clearInterval(yt.timer);
    try { if (yt.ready) yt.p.pauseVideo(); } catch (e) { /* ignore */ }
    $('ytbox').classList.remove('on');
    if (mode === 'yt') mode = '';
  }

  function spotifyEntry() {
    if (sp.tok) { hideSheet(); startSpotify(); say('Following Spotify'); }
    else spotifySheet();
  }

  function spotifySheet(errText) {
    if (sp.client && !errText) {
      showSheet(
        el('h2', {}, 'Connect Spotify'),
        el('p', {}, 'Log in once, then play music in the Spotify app. Lyric Peak follows it from here. Keep this page open on screen.'),
        btn('go', 'Connect Spotify', spLogin),
        btn('ghost', 'Use a different Client ID', () => { sp.client = ''; ls.del('spClient'); spotifySheet(); }),
        btn('ghost', 'Close', hideSheet));
      return;
    }
    const uri = redirectUri();
    const inp = el('input', { type: 'text', placeholder: 'Paste your Client ID', 'aria-label': 'Spotify Client ID', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: sp.client || '' });
    const save = () => {
      const v = inp.value.trim();
      if (!/^[0-9a-f]{32}$/i.test(v)) { say('A Client ID is 32 letters and numbers'); return; }
      sp.client = v; ls.set('spClient', v); spLogin();
    };
    showSheet(
      el('h2', {}, 'Follow Spotify'),
      errText ? el('p', { class: 'err' }, errText) : null,
      el('p', {}, 'Spotify only lets an app read what you are playing if it has its own free login app. It takes a minute to make one:'),
      el('ol', {},
        el('li', {}, 'Open ', el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'developer.spotify.com/dashboard'), ' and tap Create app (Spotify requires Premium on the account that creates it).'),
        el('li', {}, 'Redirect URI, copy this exactly:', el('span', { class: 'code' }, uri), btn('ghost', 'Copy link', () => { try { navigator.clipboard.writeText(uri); say('Copied'); } catch (e) { say('Press and hold the link to copy'); } })),
        el('li', {}, 'Tick “Web API”, save, then open Settings → User management and add your Spotify email.'),
        el('li', {}, 'Copy the Client ID and paste it below.')),
      el('form', { class: 'stack', on: { submit: (e) => { e.preventDefault(); save(); } } }, inp, el('button', { class: 'go', type: 'submit' }, 'Connect Spotify')),
      el('p', { class: 'small' }, 'No Premium? Use “Play any song” instead, it needs no login.'),
      btn('ghost', 'Close', hideSheet));
  }

  /* ---------- the first screen ---------- */
  W.home = (elFn) => {
    const note = sp.tok ? 'Spotify is connected. Play a song in the Spotify app, then come back to this page.' : '';
    return elFn('div', { class: 'stack' },
      elFn('button', { class: 'go', on: { click: () => youtubeSheet() } }, 'Play any song here (YouTube link)'),
      elFn('button', { class: 'ghost', on: { click: spotifyEntry } }, sp.tok ? 'Follow Spotify' : 'Follow the Spotify app'),
      note ? elFn('p', { class: 'small' }, note) : null,
      elFn('p', { class: 'small' }, 'Tip: in Safari tap Share → Add to Home Screen to open this full screen.'));
  };

  /* ---------- start ---------- */
  async function boot() {
    const q = new URLSearchParams(location.search);
    let msg = '';
    if (q.get('code') && ls.get('spVer', '')) {
      try {
        await spToken({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: ls.get('spVer', '') });
        ls.set('spLast', 1);
      } catch (e) { msg = String((e && e.message) || e); }
      ls.del('spVer');
    } else if (q.get('error')) msg = 'Spotify login was cancelled';
    if (q.has('code') || q.has('error') || q.has('state')) history.replaceState(null, '', location.pathname);
    push({});
    if (msg) { spotifySheet(msg); return; }
    if (sp.tok && ls.get('spLast', 0)) { startSpotify(); }
    const link = q.get('play');
    if (link) playYoutube(link);
  }
})();
