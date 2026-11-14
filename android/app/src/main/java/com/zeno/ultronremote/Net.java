package com.zeno.ultronremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Tiny HTTP helpers for talking to the PC. The pairing cookie is copied from the WebView (see MainActivity). */
final class Net {
    static final String PREFS = "ultron";

    private Net() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static String base(Context c) { return prefs(c).getString("base", null); }

    static String cookie(Context c) { return prefs(c).getString("cookie", null); }

    private static HttpURLConnection open(String url, String cookie, int timeoutMs) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        h.setConnectTimeout(timeoutMs);
        h.setReadTimeout(timeoutMs);
        h.setUseCaches(false);
        if (cookie != null && !cookie.isEmpty()) h.setRequestProperty("Cookie", cookie);
        return h;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /** GET as text; null on any failure or a non-200 answer. */
    static String get(String url, String cookie, int timeoutMs) {
        HttpURLConnection h = null;
        try {
            h = open(url, cookie, timeoutMs);
            if (h.getResponseCode() != 200) return null;
            try (InputStream in = h.getInputStream()) { return new String(readAll(in), StandardCharsets.UTF_8); }
        } catch (Exception e) {
            return null;
        } finally {
            if (h != null) h.disconnect();
        }
    }

    /** POST JSON with the remote's header; returns the status code (0 = no answer). */
    static int post(String url, String cookie, String json) {
        HttpURLConnection h = null;
        try {
            h = open(url, cookie, 4000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            h.setRequestProperty("X-Remote", "1");
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            try (OutputStream o = h.getOutputStream()) { o.write(body); }
            return h.getResponseCode();
        } catch (Exception e) {
            return 0;
        } finally {
            if (h != null) h.disconnect();
        }
    }

    static Bitmap bitmap(String url, String cookie) {
        HttpURLConnection h = null;
        try {
            h = open(url, cookie, 6000);
            if (h.getResponseCode() != 200) return null;
            String type = h.getContentType();
            if (type != null && type.contains("svg")) return null;       // placeholder art
            try (InputStream in = h.getInputStream()) {
                byte[] b = readAll(in);
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(b, 0, b.length, o);
                int s = 1;
                while (Math.max(o.outWidth, o.outHeight) / s > 512) s *= 2;  // the notification only needs a small picture
                o = new BitmapFactory.Options();
                o.inSampleSize = s;
                return BitmapFactory.decodeByteArray(b, 0, b.length, o);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (h != null) h.disconnect();
        }
    }
}
