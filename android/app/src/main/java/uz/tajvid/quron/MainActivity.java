package uz.tajvid.quron;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Hosts the mushaf UI (assets/www) in a WebView; audio plays and records inside the page. */
public class MainActivity extends Activity {

    private static final int REQUEST_MIC = 1;
    private static final String[] MIC = {PermissionRequest.RESOURCE_AUDIO_CAPTURE};
    // keep this much free space on the phone after a download
    private static final long SPARE_BYTES = 50L * 1024 * 1024;

    private WebView web;
    // the page's microphone request, waiting for the user's answer to the system dialog
    private PermissionRequest pendingMic;
    // surah recitations download one at a time, straight to files (some are 100+ MB)
    private final ExecutorService downloader = Executors.newSingleThreadExecutor();
    private final Set<Integer> cancelled = ConcurrentHashMap.newKeySet();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.cream));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // the next ayah starts from the "ended" event, not from a tap
        s.setMediaPlaybackRequiresUserGesture(false);
        // downloaded recitations play from the app's files directory
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith("file:///android_asset/");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> onPageWantsPermission(request));
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingMic == request) pendingMic = null;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");

        web.loadUrl("file:///android_asset/www/index.html");
    }

    private void onPageWantsPermission(PermissionRequest request) {
        if (!Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
            request.deny();
        } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(MIC);
        } else {
            if (pendingMic != null) pendingMic.deny();
            pendingMic = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_MIC || pendingMic == null) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(MIC);
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.app ? window.app.back() : false", handled -> {
            if (!"true".equals(handled)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        downloader.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    private File audioDir() {
        File dir = new File(getFilesDir(), "audio");
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    private File audioFile(int surah) {
        return new File(audioDir(), String.format(Locale.ROOT, "%03d.mp3", surah));
    }

    private void fetch(int surah, String url) {
        File part = new File(audioDir(), surah + ".part");
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong();
            if (total > 0 && total > audioDir().getUsableSpace() - SPARE_BYTES) {
                report(surah, 0, "nospace");
                return;
            }
            long got = 0, reported = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int r;
                while ((r = in.read(buf)) != -1) {
                    if (cancelled.contains(surah)) throw new InterruptedIOException("cancelled");
                    out.write(buf, 0, r);
                    got += r;
                    long now = SystemClock.uptimeMillis();
                    if (now - reported > 250 && total > 0) {
                        reported = now;
                        report(surah, (double) got / total, null);
                    }
                }
            }
            if (!part.renameTo(audioFile(surah))) throw new IOException("rename failed");
            report(surah, 1, "done");
        } catch (IOException e) {
            part.delete();
            report(surah, 0, cancelled.contains(surah) ? "cancelled" : "error");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void report(int surah, double progress, String status) {
        String js = "window.app && window.app.onDownload(" + surah + "," + progress + ","
                + (status == null ? "null" : "'" + status + "'") + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private class Bridge {
        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /** {"surah number": size in bytes} for every downloaded recitation. */
        @JavascriptInterface
        public String downloaded() {
            JSONObject o = new JSONObject();
            File[] files = audioDir().listFiles();
            if (files != null) {
                for (File f : files) {
                    String name = f.getName();
                    if (!name.matches("\\d{3}\\.mp3")) continue;
                    try {
                        o.put(String.valueOf(Integer.parseInt(name.substring(0, 3))), f.length());
                    } catch (JSONException ignored) {
                        // a number key cannot fail
                    }
                }
            }
            return o.toString();
        }

        @JavascriptInterface
        public String fileUrl(int surah) {
            return Uri.fromFile(audioFile(surah)).toString();
        }

        @JavascriptInterface
        public void download(int surah, String url) {
            cancelled.remove(surah);
            downloader.execute(() -> fetch(surah, url));
        }

        @JavascriptInterface
        public void cancelDownload(int surah) {
            cancelled.add(surah);
        }

        @JavascriptInterface
        public boolean removeDownload(int surah) {
            return audioFile(surah).delete();
        }
    }
}
