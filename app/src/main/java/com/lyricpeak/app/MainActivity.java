package com.lyricpeak.app;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.audiofx.Visualizer;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.media.browse.MediaBrowser;
import android.content.pm.ResolveInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lyric Peak: full-screen animated lyrics for whatever is playing.
 * The animation runs in a WebView (assets/index.html + app.js). This class feeds it:
 *  - the current song and playback position:
 *      standard edition -> Spotify's own "Device broadcast status" broadcasts (no special access needed)
 *      plus edition     -> Android media sessions (YT Music, Spotify, any player; needs notification access),
 *  - lyrics HTTP requests to lrclib.net,
 *  - live audio spectrum for beat reaction (android.media.audiofx.Visualizer).
 */
public class MainActivity extends Activity {

    private static final int REQ_MIC = 7;
    private static final int BANDS = 48;
    private static final String SPOTIFY = "com.spotify.music";
    private static final String YTMUSIC = "com.google.android.apps.youtube.music";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Object vizLock = new Object();

    private WebView web;
    private MediaSessionManager sessions;
    private ComponentName listener;
    private volatile boolean pageReady = false;
    private boolean resumed = false;
    private String lastKey = "";
    private boolean artSent = false;

    // Spotify "Device broadcast status" state (sticky broadcasts, so we get the latest on register)
    private boolean plus = false;
    private boolean spSeen = false;
    private String spTitle = "", spArtist = "", spAlbum = "";
    private long spLength = 0, spPos = 0, spPosAt = 0;
    private boolean spPlaying = false;

    private final BroadcastReceiver spotifyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            Bundle x = intent.getExtras();
            if (action == null || x == null) return;
            long sent = num(x, "timeSent");
            if (sent <= 0) sent = System.currentTimeMillis();
            if (action.endsWith("metadatachanged")) {
                String track = x.getString("track");
                if (track == null || track.isEmpty()) return;
                boolean newSong = !track.equals(spTitle);
                spTitle = track;
                spArtist = nz(x.getString("artist"));
                spAlbum = nz(x.getString("album"));
                spLength = num(x, "length");
                if (x.containsKey("playing")) spPlaying = x.getBoolean("playing");
                if (x.containsKey("playbackPosition")) {
                    spPos = num(x, "playbackPosition");
                    spPosAt = sent;
                } else if (newSong) {
                    spPos = 0;
                    spPosAt = sent;
                }
                spSeen = true;
            } else if (action.endsWith("playbackstatechanged")) {
                spPlaying = x.getBoolean("playing", false);
                if (x.containsKey("playbackPosition")) {
                    spPos = num(x, "playbackPosition");
                    spPosAt = sent;
                }
                spSeen = true;
            }
            if (resumed) pushState();
        }
    };

    @SuppressWarnings("deprecation")
    private static long num(Bundle b, String key) {
        Object o = b.get(key);
        return o instanceof Number ? ((Number) o).longValue() : 0;
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    // YT Music, way 1: connect to the YT Music app's media browser (no special access). Works only if YT Music allows it.
    private MediaBrowser ytBrowser;
    private MediaController ytController;
    private String ytAppState = "idle"; // idle | connecting | connected | refused | missing

    // YT Music, way 2: YT Music website playing inside Lyric Peak, so we can read the song directly.
    private FrameLayout root;
    private WebView ytWeb;
    private TextView ytBack;
    private boolean ytVisible = false;
    private String ywTitle = "", ywArtist = "", ywAlbum = "", ywArt = "";
    private double ywPos = 0, ywDur = 0;
    private boolean ywPlaying = false;
    private long ywAt = 0;

    // which source the lyrics are following right now: "session", "yt", "spotify", "web" or ""
    private String source = "";
    private MediaController sourceController;

    private static final String YT_POLL =
            "(function(){try{var m=navigator.mediaSession&&navigator.mediaSession.metadata;"
            + "var v=document.querySelector('video')||document.querySelector('audio');"
            + "var t=(m&&m.title)||'',a=(m&&m.artist)||'',al=(m&&m.album)||'',art='';"
            + "if(m&&m.artwork&&m.artwork.length){art=m.artwork[m.artwork.length-1].src;}"
            + "return JSON.stringify({t:t,a:a,al:al,art:art,pos:v?v.currentTime:0,"
            + "dur:(v&&isFinite(v.duration))?v.duration:0,play:!!(v&&!v.paused&&!v.ended)});"
            + "}catch(e){return '{}';}})()";

    private Visualizer viz;
    private byte[] fftBuf;
    private boolean beatWanted = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            pollYtWeb();
            pushState();
            if (resumed) ui.postDelayed(this, 300);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window win = getWindow();
        win.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = win.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            win.setAttributes(lp);
        }

        sessions = (MediaSessionManager) getSystemService(Context.MEDIA_SESSION_SERVICE);
        listener = new ComponentName(this, MediaListener.class);
        plus = getPackageName().endsWith(".plus");
        registerSpotify();

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("file:///android_asset/index.html");
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        hideSystemBars();
        connectYtApp();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        hideSystemBars();
        ui.removeCallbacks(tick);
        ui.post(tick);
        if (beatWanted) startViz();
        js("window.onAppResume && onAppResume()");
    }

    @Override
    protected void onPause() {
        resumed = false;
        ui.removeCallbacks(tick);
        stopViz();
        super.onPause();
    }

    private void registerSpotify() {
        IntentFilter f = new IntentFilter();
        f.addAction("com.spotify.music.metadatachanged");
        f.addAction("com.spotify.music.playbackstatechanged");
        try {
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(spotifyReceiver, f, Context.RECEIVER_EXPORTED);
            else registerReceiver(spotifyReceiver, f);
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onDestroy() {
        try {
            unregisterReceiver(spotifyReceiver);
        } catch (Exception ignored) {
        }
        stopViz();
        io.shutdownNow();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (ytVisible && ytWeb != null) {
            if (ytWeb.canGoBack()) ytWeb.goBack();
            else showLyrics();
            return;
        }
        super.onBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC) return;
        boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) {
            beatWanted = true;
            ok = startViz();
        }
        js("window.onMicResult && onMicResult(" + ok + ")");
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window win = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            win.setDecorFitsSystemWindows(false);
            WindowInsetsController c = win.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            win.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private void js(final String code) {
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    // ---------------------------------------------------------------- media sessions

    private boolean hasAccess() {
        if (!plus) return false;
        String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(getPackageName() + "/");
    }

    private MediaController pickController() {
        if (!plus) return null;
        List<MediaController> list;
        try {
            list = sessions.getActiveSessions(listener);
        } catch (SecurityException e) {
            return null;
        }
        if (list == null || list.isEmpty()) return null;
        MediaController best = null;
        int bestScore = -1;
        for (MediaController c : list) {
            int score = 0;
            PlaybackState st = c.getPlaybackState();
            if (st != null && st.getState() == PlaybackState.STATE_PLAYING) score += 10;
            if (SPOTIFY.equals(c.getPackageName())) score += 5;
            if (c.getMetadata() != null) score += 1;
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        return best;
    }

    private static String str(MediaMetadata md, String key) {
        String v = md.getString(key);
        return v == null ? "" : v;
    }

    private static boolean isPlaying(MediaController c) {
        PlaybackState st = c != null ? c.getPlaybackState() : null;
        return st != null && st.getState() == PlaybackState.STATE_PLAYING;
    }

    private void pushState() {
        if (!pageReady || web == null) return;
        try {
            JSONObject o = new JSONObject();
            boolean access = hasAccess();
            o.put("edition", plus ? "plus" : "standard");
            o.put("access", access);
            o.put("spotifySeen", spSeen);
            o.put("ytApp", ytAppState);
            o.put("ytWeb", ytWeb != null);

            MediaController c = access ? pickController() : null;
            if (c != null && c.getMetadata() == null) c = null;
            MediaController yt = ytController != null && ytController.getMetadata() != null ? ytController : null;
            boolean webHas = ytWeb != null && !ywTitle.isEmpty();
            boolean spHas = spSeen && !spTitle.isEmpty();
            boolean spLive = spHas && spPlaying && !(spLength > 0 && spPos + (System.currentTimeMillis() - spPosAt) > spLength + 5000);

            String pick;
            if (webHas && ywPlaying) pick = "web";
            else if (isPlaying(c)) pick = "session";
            else if (isPlaying(yt)) pick = "yt";
            else if (spLive) pick = "spotify";
            else if (webHas && ytVisible) pick = "web";
            else if (c != null) pick = "session";
            else if (yt != null) pick = "yt";
            else if (spHas) pick = "spotify";
            else if (webHas) pick = "web";
            else pick = "";

            source = pick;
            sourceController = "session".equals(pick) ? c : "yt".equals(pick) ? yt : null;
            if ("spotify".equals(pick)) putSpotify(o);
            else if ("web".equals(pick)) putWeb(o);
            else if (sourceController != null) putSession(o, sourceController);
            js("window.onPlayer && onPlayer(" + o.toString() + ")");
        } catch (Exception e) {
            // keep ticking; one bad read shouldn't stop the app
        }
    }

    private void putSpotify(JSONObject o) throws Exception {
        o.put("pkg", SPOTIFY);
        o.put("title", spTitle);
        o.put("artist", spArtist);
        o.put("album", spAlbum);
        o.put("duration", spLength);
        String key = SPOTIFY + "|" + spTitle + "|" + spArtist;
        if (!key.equals(lastKey)) {
            o.put("art", "");
            lastKey = key;
            artSent = true;
        }
        long pos = spPos;
        boolean playing = spPlaying;
        if (playing) pos += System.currentTimeMillis() - spPosAt;
        if (spLength > 0 && pos > spLength + 5000) playing = false;
        if (spLength > 0) pos = Math.min(pos, spLength);
        o.put("position", Math.max(0, pos));
        o.put("playing", playing);
        o.put("speed", 1);
    }

    private void putWeb(JSONObject o) throws Exception {
        o.put("pkg", "ytweb");
        o.put("title", ywTitle);
        o.put("artist", ywArtist);
        o.put("album", ywAlbum);
        o.put("duration", (long) (ywDur * 1000));
        String key = "ytweb|" + ywTitle + "|" + ywArtist;
        if (!key.equals(lastKey)) {
            o.put("art", ywArt);
            lastKey = key;
            artSent = !ywArt.isEmpty();
        } else if (!artSent && !ywArt.isEmpty()) {
            o.put("art", ywArt);
            artSent = true;
        }
        double pos = ywPos;
        if (ywPlaying) pos += (SystemClock.elapsedRealtime() - ywAt) / 1000.0;
        o.put("position", (long) (Math.max(0, pos) * 1000));
        o.put("playing", ywPlaying);
        o.put("speed", 1);
    }

    private void putSession(JSONObject o, MediaController c) throws Exception {
        o.put("pkg", c.getPackageName());
        MediaMetadata md = c.getMetadata();
        if (md != null) {
            String title = str(md, MediaMetadata.METADATA_KEY_TITLE);
            if (title.isEmpty()) title = str(md, MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
            String artist = str(md, MediaMetadata.METADATA_KEY_ARTIST);
            if (artist.isEmpty()) artist = str(md, MediaMetadata.METADATA_KEY_ALBUM_ARTIST);
            o.put("title", title);
            o.put("artist", artist);
            o.put("album", str(md, MediaMetadata.METADATA_KEY_ALBUM));
            o.put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION));
            String key = c.getPackageName() + "|" + title + "|" + artist;
            boolean changed = !key.equals(lastKey);
            if (changed || !artSent) {
                String art = encodeArt(md);
                if (changed || !art.isEmpty()) o.put("art", art);
                artSent = !art.isEmpty();
                lastKey = key;
            }
        }
        PlaybackState st = c.getPlaybackState();
        if (st != null) {
            boolean playing = st.getState() == PlaybackState.STATE_PLAYING;
            long pos = st.getPosition();
            float speed = st.getPlaybackSpeed();
            long upd = st.getLastPositionUpdateTime();
            if (playing && upd > 0) pos += (long) ((SystemClock.elapsedRealtime() - upd) * speed);
            o.put("position", Math.max(0, pos));
            o.put("playing", playing);
            o.put("speed", playing && speed > 0 ? speed : 1);
        }
    }

    // ---------------------------------------------------------------- YT Music

    /** Way 1: ask the YT Music app for its media session. Needs no permission; YT Music may say no. */
    private void connectYtApp() {
        try {
            if (ytBrowser != null) return;
            Intent q = new Intent("android.media.browse.MediaBrowserService");
            q.setPackage(YTMUSIC);
            List<ResolveInfo> found = getPackageManager().queryIntentServices(q, 0);
            if (found == null || found.isEmpty()) {
                ytAppState = "missing";
                return;
            }
            ComponentName svc = new ComponentName(found.get(0).serviceInfo.packageName, found.get(0).serviceInfo.name);
            ytAppState = "connecting";
            ytBrowser = new MediaBrowser(this, svc, new MediaBrowser.ConnectionCallback() {
                @Override
                public void onConnected() {
                    try {
                        ytController = new MediaController(MainActivity.this, ytBrowser.getSessionToken());
                        ytAppState = "connected";
                    } catch (Exception e) {
                        ytAppState = "refused";
                    }
                }

                @Override
                public void onConnectionFailed() {
                    ytAppState = "refused";
                    ytBrowser = null;
                }

                @Override
                public void onConnectionSuspended() {
                    ytController = null;
                    ytAppState = "refused";
                    ytBrowser = null;
                }
            }, null);
            ytBrowser.connect();
        } catch (Exception e) {
            ytAppState = "refused";
            ytBrowser = null;
        }
    }

    /** Way 2: YT Music website inside the app. It sits under the lyrics, so it keeps playing while you watch them. */
    private void showYtPlayer() {
        if (ytWeb == null) {
            ytWeb = new WebView(this);
            ytWeb.setBackgroundColor(Color.BLACK);
            WebSettings s = ytWeb.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(ytWeb, true);
            ytWeb.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String scheme = request.getUrl().getScheme();
                    // stay inside the app: ignore "open in YT Music app" links
                    return !("http".equals(scheme) || "https".equals(scheme));
                }
            });
            ytWeb.setWebChromeClient(new WebChromeClient());
            ytWeb.loadUrl("https://music.youtube.com/");
            root.addView(ytWeb, 0, new FrameLayout.LayoutParams(-1, -1));

            ytBack = new TextView(this);
            ytBack.setText("\u2726  Lyrics");
            ytBack.setTextColor(Color.BLACK);
            ytBack.setTextSize(16);
            ytBack.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            int pad = dp(14);
            ytBack.setPadding(pad + dp(4), pad, pad + dp(4), pad);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xFFFF4A2B);
            bg.setCornerRadius(dp(28));
            ytBack.setBackground(bg);
            ytBack.setElevation(dp(8));
            ytBack.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    showLyrics();
                }
            });
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
            lp.setMargins(dp(16), dp(16), dp(16), dp(96));
            root.addView(ytBack, lp);
        }
        ytVisible = true;
        web.setVisibility(View.INVISIBLE);
        ytBack.setVisibility(View.VISIBLE);
        ytBack.bringToFront();
    }

    private void showLyrics() {
        ytVisible = false;
        web.setVisibility(View.VISIBLE);
        if (ytBack != null) ytBack.setVisibility(View.GONE);
        hideSystemBars();
        pushState();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void pollYtWeb() {
        if (ytWeb == null) return;
        ytWeb.evaluateJavascript(YT_POLL, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                try {
                    if (value == null || "null".equals(value)) return;
                    String json = new JSONArray("[" + value + "]").getString(0);
                    JSONObject r = new JSONObject(json);
                    ywTitle = r.optString("t", "");
                    ywArtist = r.optString("a", "");
                    ywAlbum = r.optString("al", "");
                    ywArt = r.optString("art", "");
                    ywPos = r.optDouble("pos", 0);
                    ywDur = r.optDouble("dur", 0);
                    ywPlaying = r.optBoolean("play", false);
                    ywAt = SystemClock.elapsedRealtime();
                } catch (Exception ignored) {
                }
            }
        });
    }

    private void webControl(String action) {
        if (ytWeb == null) return;
        String js;
        if ("next".equals(action)) js = "(document.querySelector('.next-button,[aria-label=\"Next\"],[aria-label=\"Next song\"]')||{click:function(){}}).click()";
        else if ("prev".equals(action)) js = "(document.querySelector('.previous-button,[aria-label=\"Previous\"],[aria-label=\"Previous song\"]')||{click:function(){}}).click()";
        else js = "(function(){var v=document.querySelector('video');if(v){if(v.paused)v.play();else v.pause();}})()";
        ytWeb.evaluateJavascript(js, null);
    }

    private String encodeArt(MediaMetadata md) {
        Bitmap bm = md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
        if (bm == null) bm = md.getBitmap(MediaMetadata.METADATA_KEY_ART);
        if (bm == null) bm = md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
        if (bm == null) return "";
        try {
            Bitmap small = Bitmap.createScaledBitmap(bm, 160, 160, true);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 85, out);
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    /** Standard edition has no session access, so play/pause/skip go out as normal media buttons. */
    private void sendMediaKey(String action) {
        int code;
        if ("next".equals(action)) code = android.view.KeyEvent.KEYCODE_MEDIA_NEXT;
        else if ("prev".equals(action)) code = android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS;
        else code = android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
        try {
            android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
            am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, code));
            am.dispatchMediaKeyEvent(new android.view.KeyEvent(android.view.KeyEvent.ACTION_UP, code));
        } catch (Exception ignored) {
        }
    }

    // ---------------------------------------------------------------- beat (Visualizer)

    private boolean startViz() {
        synchronized (vizLock) {
            if (viz != null) return true;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
            try {
                Visualizer v = new Visualizer(0); // 0 = everything the phone is playing
                int[] range = Visualizer.getCaptureSizeRange();
                v.setCaptureSize(Math.min(1024, range[1]));
                v.setScalingMode(Visualizer.SCALING_MODE_NORMALIZED);
                v.setEnabled(true);
                fftBuf = new byte[v.getCaptureSize()];
                viz = v;
                return true;
            } catch (Throwable t) {
                viz = null;
                return false;
            }
        }
    }

    private void stopViz() {
        synchronized (vizLock) {
            if (viz == null) return;
            try {
                viz.setEnabled(false);
                viz.release();
            } catch (Throwable ignored) {
            }
            viz = null;
        }
    }

    private String readBands() {
        synchronized (vizLock) {
            if (viz == null) return "";
            try {
                if (viz.getFft(fftBuf) != Visualizer.SUCCESS) return "";
                int n = fftBuf.length / 2;
                double hz = (viz.getSamplingRate() / 1000.0) / fftBuf.length;
                if (hz <= 0) return "";
                StringBuilder sb = new StringBuilder(BANDS * 4);
                for (int k = 0; k < BANDS; k++) {
                    double lo = 40 * Math.pow(350, k / (double) BANDS);
                    double hi = 40 * Math.pow(350, (k + 1) / (double) BANDS);
                    int a = Math.max(1, (int) Math.floor(lo / hz));
                    int b = Math.min(n - 1, Math.max(a, (int) Math.ceil(hi / hz)));
                    double sum = 0;
                    for (int i = a; i <= b; i++) sum += Math.hypot(fftBuf[2 * i], fftBuf[2 * i + 1]);
                    double mag = sum / (b - a + 1);
                    double db = 20 * Math.log10(mag + 1);
                    double v = Math.max(0, Math.min(1, (db - 10) / 34.0));
                    if (k > 0) sb.append(',');
                    sb.append((int) Math.round(v * 1000));
                }
                return sb.toString();
            } catch (Throwable t) {
                return "";
            }
        }
    }

    // ---------------------------------------------------------------- lyrics HTTP

    private static String readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int r;
        while ((r = in.read(buf)) != -1) out.write(buf, 0, r);
        in.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private void httpGet(final String url, final int id) {
        io.execute(new Runnable() {
            @Override
            public void run() {
                int code = 0;
                String body = "";
                if (url != null && url.startsWith("https://lrclib.net/")) {
                    HttpURLConnection con = null;
                    try {
                        con = (HttpURLConnection) new URL(url).openConnection();
                        con.setConnectTimeout(10000);
                        con.setReadTimeout(15000);
                        con.setRequestProperty("User-Agent", "LyricPeak Android 1.0 (personal app)");
                        con.setRequestProperty("Accept", "application/json");
                        code = con.getResponseCode();
                        InputStream in = code >= 400 ? con.getErrorStream() : con.getInputStream();
                        body = in == null ? "" : readAll(in);
                    } catch (Exception e) {
                        code = 0;
                    } finally {
                        if (con != null) con.disconnect();
                    }
                }
                js("window.onHttp && onHttp(" + id + "," + code + "," + JSONObject.quote(body) + ")");
            }
        });
    }

    // ---------------------------------------------------------------- JS bridge

    public class Bridge {
        @JavascriptInterface
        public void ready() {
            pageReady = true;
        }

        @JavascriptInterface
        public boolean hasAccess() {
            return MainActivity.this.hasAccess();
        }

        @JavascriptInterface
        public void openAccessSettings() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (Build.VERSION.SDK_INT >= 30) {
                            Intent i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
                            i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listener.flattenToString());
                            startActivity(i);
                            return;
                        }
                    } catch (Exception ignored) {
                    }
                    try {
                        startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_SETTINGS));
                    }
                }
            });
        }

        @JavascriptInterface
        public void openAppInfo() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.fromParts("package", getPackageName(), null));
                        startActivity(i);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public String edition() {
            return plus ? "plus" : "standard";
        }

        @JavascriptInterface
        public boolean hasApp(String which) {
            try {
                getPackageManager().getPackageInfo("ytmusic".equals(which) ? YTMUSIC : SPOTIFY, 0);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /** which: "spotify", "ytmusic", or "" for whatever is playing. */
        @JavascriptInterface
        public void openApp(final String which) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    String pkg;
                    if ("ytmusic".equals(which)) pkg = YTMUSIC;
                    else if ("spotify".equals(which)) pkg = SPOTIFY;
                    else {
                        MediaController c = pickController();
                        pkg = c != null ? c.getPackageName() : SPOTIFY;
                    }
                    Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                    if (i == null) {
                        i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
                    }
                    try {
                        startActivity(i);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void openPlayer() {
            openApp("");
        }

        /** YT Music button: follow the YT Music app if it lets us, otherwise open YT Music inside Lyric Peak. */
        @JavascriptInterface
        public void ytMusic() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if ("connected".equals(ytAppState) || hasAccess()) openApp("ytmusic");
                    else showYtPlayer();
                }
            });
        }

        /** Always opens the YT Music website inside the app. */
        @JavascriptInterface
        public void ytPlayer() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    showYtPlayer();
                }
            });
        }

        @JavascriptInterface
        public void control(final String action) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    if ("web".equals(source)) {
                        webControl(action);
                        ui.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                pollYtWeb();
                            }
                        }, 200);
                        return;
                    }
                    MediaController c = sourceController;
                    if (c == null) {
                        sendMediaKey(action);
                        return;
                    }
                    MediaController.TransportControls t = c.getTransportControls();
                    PlaybackState st = c.getPlaybackState();
                    boolean playing = st != null && st.getState() == PlaybackState.STATE_PLAYING;
                    if ("toggle".equals(action)) {
                        if (playing) t.pause();
                        else t.play();
                    } else if ("next".equals(action)) {
                        t.skipToNext();
                    } else if ("prev".equals(action)) {
                        t.skipToPrevious();
                    }
                    ui.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            pushState();
                        }
                    }, 250);
                }
            });
        }

        @JavascriptInterface
        public boolean hasMic() {
            return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestMic() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                }
            });
        }

        @JavascriptInterface
        public boolean startBeat() {
            beatWanted = true;
            return startViz();
        }

        @JavascriptInterface
        public void stopBeat() {
            beatWanted = false;
            stopViz();
        }

        @JavascriptInterface
        public String fft() {
            return readBands();
        }

        @JavascriptInterface
        public void httpGet(String url, int id) {
            MainActivity.this.httpGet(url, id);
        }
    }
}
