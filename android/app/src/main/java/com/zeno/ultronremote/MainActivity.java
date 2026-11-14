package com.zeno.ultronremote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.Inet4Address;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The phone app: the same phone page the PC serves (assets/remote.html), in a full-screen WebView, plus what a web page
 * cannot do: find the PC on the Wi-Fi by itself, hand the volume buttons and lock screen to RemoteService, keep the
 * screen on while a video plays on the phone, and a proper back button.
 */
public class MainActivity extends Activity {
    static volatile boolean visible = false;
    private static final int BG = Color.rgb(11, 10, 13), INK = Color.rgb(239, 236, 230), MUTE = Color.rgb(143, 139, 149);

    private FrameLayout root;
    private WebView web;
    private View custom;                       // a fullscreen element (WebChromeClient custom view)
    private boolean local = false, immersive = false, onSetup = false;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ExecutorService scan;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v, ins) -> {             // keep the page out from under the status / navigation bars
            android.graphics.Insets s = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            android.graphics.Insets cut = ins.getInsets(WindowInsets.Type.displayCutout());
            if (immersive) v.setPadding(cut.left, cut.top, cut.right, cut.bottom);   // full-screen video: bars hidden, but stay clear of the camera
            else v.setPadding(s.left, s.top, s.right, s.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        if (!handle(getIntent())) {
            String base = Net.base(this);
            if (base != null) openPage(base + "/");
            else showSetup(null);
        }
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i);
    }

    /** An http://<pc>:47400/#pin=... link (the QR code): remember that PC and open it (the page pairs itself). */
    private boolean handle(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u == null || u.getHost() == null || u.getPort() < 47400 || u.getPort() > 47403) return false;
        String base = "http://" + u.getHost() + ":" + u.getPort();
        Net.prefs(this).edit().putString("base", base).apply();
        String frag = u.getEncodedFragment();
        // a fresh query string, so an already open page really reloads (same URL + new #pin would only change the hash)
        openPage(base + "/?p=" + System.currentTimeMillis() + (frag != null ? "#" + frag : ""));
        return true;
    }

    // ---------------------------------------------------------------- the page
    private void openPage(String url) {
        onSetup = false;
        stopScan();
        if (web == null) {
            web = new WebView(this);
            web.setBackgroundColor(BG);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setUserAgentString(s.getUserAgentString() + " UltronApp/1");
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);   // keep the page (and the phone's sound sync) alive with the screen off
            CookieManager.getInstance().setAcceptCookie(true);
            web.addJavascriptInterface(new Bridge(), "UltronApp");
            web.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView v, String u) { saveCookie(); }
                @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                    if (r.isForMainFrame()) showSetup("Could not reach your PC. Is ULTRON open and Phone remote switched on?");
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override public void onShowCustomView(View v, CustomViewCallback cb) {
                    custom = v;
                    root.addView(v, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    fullBleed(true);
                }
                @Override public void onHideCustomView() {
                    if (custom != null) root.removeView(custom);
                    custom = null;
                    fullBleed(false);
                }
            });
        }
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(url);
        startService(new Intent(this, RemoteService.class));
    }

    private void saveCookie() {
        String base = Net.base(this);
        if (base == null) return;
        String c = CookieManager.getInstance().getCookie(base);
        if (c != null) Net.prefs(this).edit().putString("cookie", c).apply();
        CookieManager.getInstance().flush();
    }

    private void fullBleed(boolean on) {
        immersive = on;
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else c.show(WindowInsets.Type.systemBars());
        }
        setRequestedOrientation(on ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        root.requestApplyInsets();
    }

    /** Called by the page (window.UltronApp). */
    final class Bridge {
        @JavascriptInterface public void local(boolean on) {          // a video is playing on the phone itself
            ui.post(() -> {
                local = on;
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                startService(new Intent(MainActivity.this, RemoteService.class).setAction(RemoteService.ACTION_LOCAL).putExtra("on", on));
            });
        }
        @JavascriptInterface public void localAudio(boolean on) {     // the PC's sound plays on the phone (earphones)
            ui.post(() -> {
                local = on;
                startService(new Intent(MainActivity.this, RemoteService.class).setAction(RemoteService.ACTION_LOCAL).putExtra("on", on));
            });
        }
        @JavascriptInterface public void immersive(boolean on) { ui.post(() -> fullBleed(on)); }
        @JavascriptInterface public void changePc() { ui.post(() -> showSetup(null)); }
        @JavascriptInterface public String version() { return "1.0"; }
    }

    // ---------------------------------------------------------------- back + volume
    private void back() {
        if (onSetup || web == null) { finish(); return; }
        if (custom != null) { web.getWebChromeClient().onHideCustomView(); return; }
        web.evaluateJavascript("(window.ultronBack && window.ultronBack()) ? 1 : 0", v -> {
            if (!"1".equals(v)) moveTaskToBack(true);                // nothing left to close: leave, keep the remote running
        });
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() { back(); }               // Android 12 and older

    @Override public boolean onKeyDown(int code, KeyEvent e) {
        if ((code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN) && !local && !onSetup && RemoteService.connected) {
            startService(new Intent(this, RemoteService.class).setAction(RemoteService.ACTION_VOL).putExtra("d", code == KeyEvent.KEYCODE_VOLUME_UP ? 1 : -1));
            return true;                                              // the PC's volume, not the phone's
        }
        return super.onKeyDown(code, e);
    }

    @Override protected void onStart() {
        super.onStart();
        visible = true;
        if (!onSetup && Net.base(this) != null) startService(new Intent(this, RemoteService.class));
    }

    @Override protected void onStop() {
        visible = false;
        saveCookie();
        super.onStop();
    }

    @Override protected void onDestroy() {
        stopScan();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- finding the PC
    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private GradientDrawable pill(int color, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(16));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void showSetup(String error) {
        onSetup = true;
        fullBleed(false);
        ScrollView sv = new ScrollView(this);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(24), dp(48), dp(24), dp(24));
        sv.addView(col);
        TextView title = text("ULTRON Remote", 28, INK, true);
        col.addView(title);
        TextView sub = text(error != null ? error : "Looking for your PC on this Wi-Fi…", 15, error != null ? Color.rgb(255, 95, 143) : MUTE, false);
        sub.setPadding(0, dp(8), 0, dp(18));
        col.addView(sub);
        ProgressBar pb = new ProgressBar(this);
        col.addView(pb, new LinearLayout.LayoutParams(dp(36), dp(36)));
        LinearLayout found = new LinearLayout(this);
        found.setOrientation(LinearLayout.VERTICAL);
        found.setPadding(0, dp(12), 0, dp(12));
        col.addView(found);

        col.addView(text("Or type the address shown in Settings › Phone remote on the PC", 13, MUTE, false));
        EditText addr = new EditText(this);
        addr.setHint("192.168.1.150:47400");
        addr.setHintTextColor(Color.rgb(90, 86, 98));
        addr.setTextColor(INK);
        addr.setSingleLine(true);
        addr.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        String saved = Net.base(this);
        if (saved != null) addr.setText(saved.replace("http://", ""));
        addr.setBackground(pill(Color.rgb(22, 20, 27), Color.argb(40, 255, 255, 255)));
        addr.setPadding(dp(16), dp(14), dp(16), dp(14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(10);
        col.addView(addr, lp);
        Button go = new Button(this);
        go.setText("Connect");
        go.setAllCaps(false);
        go.setTextColor(Color.rgb(22, 17, 12));
        go.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable grad = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{Color.rgb(255, 195, 113), Color.rgb(255, 95, 143), Color.rgb(139, 107, 255)});
        grad.setCornerRadius(dp(28));
        go.setBackground(grad);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        gp.topMargin = dp(12);
        col.addView(go, gp);
        go.setOnClickListener(v -> connect(addr.getText().toString()));
        TextView tip = text("Tip: you can also scan the QR code in Settings › Phone remote with your camera and choose “Open with ULTRON Remote”.", 13, MUTE, false);
        tip.setPadding(0, dp(18), 0, 0);
        col.addView(tip);

        root.removeAllViews();
        root.addView(sv);
        scanForPcs(found, pb, sub, error);
    }

    private void connect(String a) {
        a = a.trim().replace("http://", "").replaceAll("/+$", "");
        if (a.isEmpty()) return;
        if (!a.contains(":")) a = a + ":47400";
        Net.prefs(this).edit().putString("base", "http://" + a).apply();
        openPage("http://" + a + "/");
    }

    private void stopScan() {
        if (scan != null) scan.shutdownNow();
        scan = null;
    }

    /** Ask every address of this Wi-Fi's /24 for the remote's manifest (about a second on a home network). */
    private void scanForPcs(LinearLayout found, ProgressBar pb, TextView sub, String error) {
        stopScan();
        final ExecutorService ex = Executors.newFixedThreadPool(48);
        scan = ex;
        final Set<String> hits = new LinkedHashSet<>();
        String prefix = subnet();
        if (prefix == null) {
            pb.setVisibility(View.GONE);
            sub.setText("Connect the phone to the same Wi-Fi as your PC.");
            return;
        }
        List<Runnable> jobs = new ArrayList<>();
        for (int port = 47400; port <= 47403; port++) {
            for (int i = 1; i < 255; i++) {
                final String base = "http://" + prefix + i + ":" + port;
                final int p = port;
                jobs.add(() -> {
                    if (p > 47400 && !hits.isEmpty()) return;          // the usual port answered: skip the spare ones
                    String m = Net.get(base + "/manifest.webmanifest", null, 600);
                    if (m != null && m.contains("ULTRON Remote")) {
                        synchronized (hits) { if (!hits.add(base)) return; }
                        ui.post(() -> addFound(found, base, sub, error));
                    }
                });
            }
        }
        new Thread(() -> {
            for (Runnable r : jobs) { if (ex.isShutdown()) return; ex.execute(r); }
            ex.shutdown();
            try { ex.awaitTermination(20, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
            ui.post(() -> {
                pb.setVisibility(View.GONE);
                if (hits.isEmpty() && onSetup) sub.setText(error != null ? error :
                        "No PC found. On the PC: open ULTRON, Settings › Phone remote, switch it on. Then reopen this app, or type the address below.");
            });
        }).start();
    }

    private void addFound(LinearLayout found, String base, TextView sub, String error) {
        if (!onSetup) return;
        if (error == null) sub.setText("Found your PC. Tap it to connect.");
        Button b = new Button(this);
        b.setAllCaps(false);
        b.setText("ULTRON  ·  " + base.replace("http://", ""));
        b.setTextColor(INK);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        b.setPadding(dp(18), 0, dp(18), 0);
        b.setBackground(pill(Color.rgb(22, 20, 27), Color.rgb(255, 195, 113)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        lp.bottomMargin = dp(8);
        found.addView(b, lp);
        b.setOnClickListener(v -> { Net.prefs(this).edit().putString("base", base).apply(); openPage(base + "/"); });
    }

    /** "192.168.1." for the Wi-Fi this phone is on, or null. */
    private String subnet() {
        try {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            Network n = cm.getActiveNetwork();
            LinkProperties lp = n == null ? null : cm.getLinkProperties(n);
            if (lp == null) return null;
            for (LinkAddress la : lp.getLinkAddresses()) {
                if (la.getAddress() instanceof Inet4Address && !la.getAddress().isLoopbackAddress()) {
                    String ip = la.getAddress().getHostAddress();
                    return ip.substring(0, ip.lastIndexOf('.') + 1);
                }
            }
        } catch (Exception ignored) {}
        return null;
    }
}
