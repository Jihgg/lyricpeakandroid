package com.lyricpeak.app;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
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
 * Lyric Peak: full-screen animated lyrics for whatever is playing (made for Spotify).
 * The animation runs in a WebView (assets/index.html + app.js). This class feeds it:
 *  - the current song and playback position (from Android media sessions),
 *  - lyrics HTTP requests to lrclib.net,
 *  - live audio spectrum for beat reaction (android.media.audiofx.Visualizer).
 */
public class MainActivity extends Activity {

    private static final int REQ_MIC = 7;
    private static final int BANDS = 48;
    private static final String SPOTIFY = "com.spotify.music";

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

    private Visualizer viz;
    private byte[] fftBuf;
    private boolean beatWanted = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
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
        setContentView(web);
        hideSystemBars();
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

    @Override
    protected void onDestroy() {
        stopViz();
        io.shutdownNow();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
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
        String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(getPackageName());
    }

    private MediaController pickController() {
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

    private void pushState() {
        if (!pageReady || web == null) return;
        try {
            JSONObject o = new JSONObject();
            boolean access = hasAccess();
            o.put("access", access);
            MediaController c = access ? pickController() : null;
            if (c != null) {
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
            js("window.onPlayer && onPlayer(" + o.toString() + ")");
        } catch (Exception e) {
            // keep ticking; one bad read shouldn't stop the app
        }
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
        public void openPlayer() {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    MediaController c = pickController();
                    String pkg = c != null ? c.getPackageName() : SPOTIFY;
                    Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
                    if (i == null) i = getPackageManager().getLaunchIntentForPackage(SPOTIFY);
                    if (i != null) {
                        try {
                            startActivity(i);
                        } catch (Exception ignored) {
                        }
                    }
                }
            });
        }

        @JavascriptInterface
        public void control(final String action) {
            ui.post(new Runnable() {
                @Override
                public void run() {
                    MediaController c = pickController();
                    if (c == null) return;
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
