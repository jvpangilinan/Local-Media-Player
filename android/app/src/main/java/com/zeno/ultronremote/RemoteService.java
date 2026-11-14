package com.zeno.ultronremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.VolumeProvider;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import org.json.JSONObject;

/**
 * Keeps the PC's "now playing" on the phone outside the app: a media session (lock screen + notification controls) and
 * REMOTE volume, so the phone's volume buttons change the PC's volume, even with the screen off. Polls /state while it
 * runs. It keeps running while the app is open (also in the background or with the screen off) and stops when the app is
 * swiped away, when "Disconnect" is tapped, or when the PC has been unreachable for 10 minutes.
 *
 * Screen off: Android only hands the volume buttons to a media session that says it is playing, so while the screen is
 * off the session always says "playing" (frozen at the PC's position when the PC is paused). Screen on: the real state.
 */
public class RemoteService extends Service {
    static final String ACTION_CMD = "cmd", ACTION_LOCAL = "local", ACTION_VOL = "vol", ACTION_STOP = "stop";
    static volatile boolean connected = false;     // read by MainActivity to decide who gets the volume keys

    private static final String CH = "playback";
    private static final int NID = 7;

    private MediaSession session;
    private VolumeProvider volume;
    private HandlerThread thread;
    private Handler h;
    private NotificationManager nm;
    private JSONObject now = new JSONObject();
    private boolean local = false, foreground = false, reachable = false;
    private volatile boolean screenOff = false;
    private long lostSince = SystemClock.elapsedRealtime(), volTouched = 0, lastPoll = 0;
    private PowerManager.WakeLock wake;
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            screenOff = Intent.ACTION_SCREEN_OFF.equals(i.getAction());
            h.post(() -> { updateSession(now.optString("kind", "none")); h.removeCallbacks(pollR); h.postDelayed(pollR, 300); });
        }
    };
    private String artKey = "";
    private Bitmap art;
    private final Runnable pollR = this::poll;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, "Now playing on your PC", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        session = new MediaSession(this, "ULTRON");
        session.setCallback(new MediaSession.Callback() {
            // with the screen off the session always says "playing", so a pause from a headset / watch is a toggle
            @Override public void onPlay() { if (now.optBoolean("paused", true)) send("toggle", null); }
            @Override public void onPause() { if (screenOff || !now.optBoolean("paused", true)) send("toggle", null); }
            @Override public void onSkipToNext() { send("next", null); }
            @Override public void onSkipToPrevious() { send("prev", null); }
            @Override public void onSeekTo(long ms) { send("seek_abs", ms / 1000.0); }
            @Override public void onFastForward() { send("seek_rel", 10); }
            @Override public void onRewind() { send("seek_rel", -10); }
        });
        session.setSessionActivity(openApp());
        volume = new VolumeProvider(VolumeProvider.VOLUME_CONTROL_ABSOLUTE, 100, 50) {
            @Override public void onSetVolumeTo(int v) { setVol(v); }
            @Override public void onAdjustVolume(int dir) { adjust(dir); }
        };
        session.setPlaybackToRemote(volume);
        session.setActive(true);

        thread = new HandlerThread("ultron-remote");
        thread.start();
        h = new Handler(thread.getLooper());
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ultron:remote");
        wake.setReferenceCounted(false);
        screenOff = !getSystemService(PowerManager.class).isInteractive();
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        f.addAction(Intent.ACTION_SCREEN_ON);
        registerReceiver(screen, f);
        goForeground();
        h.post(pollR);
    }

    private void setVol(int v) {
        v = Math.max(0, Math.min(100, v));
        volume.setCurrentVolume(v);
        volTouched = SystemClock.elapsedRealtime();
        send("vol", v / 100.0);
    }

    /** A volume button: one step up / down from the PC's real volume (re-read first if the phone was asleep). */
    private void adjust(int dir) {
        awake();
        h.post(() -> {
            if (SystemClock.elapsedRealtime() - lastPoll > 3000 && SystemClock.elapsedRealtime() - volTouched > 1500) readState();
            int v = Math.max(0, Math.min(100, volume.getCurrentVolume() + dir * 5));
            volume.setCurrentVolume(v);
            volTouched = SystemClock.elapsedRealtime();
            post("vol", v / 100.0);
        });
    }

    /** Keep the phone awake long enough to deliver a command (the screen may be off). */
    private void awake() { try { wake.acquire(10_000); } catch (Exception ignored) {} }

    private void post(String cmd, Object arg) {
        try {
            JSONObject j = new JSONObject();
            j.put("cmd", cmd);
            j.put("arg", arg == null ? JSONObject.NULL : arg);
            String base = Net.base(this);
            if (base != null) Net.post(base + "/cmd", Net.cookie(this), j.toString());
        } catch (Exception ignored) {}
        h.removeCallbacks(pollR);
        h.postDelayed(pollR, 250);
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        goForeground();
        if (i != null && i.getAction() != null) {
            switch (i.getAction()) {
                case ACTION_CMD: send(i.getStringExtra("cmd"), null); break;
                case ACTION_VOL: adjust(i.getIntExtra("d", 0)); break;
                case ACTION_LOCAL:
                    local = i.getBooleanExtra("on", false);
                    if (local) session.setPlaybackToLocal(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA).build());   // phone is playing: its own volume
                    else session.setPlaybackToRemote(volume);
                    break;
                case ACTION_STOP: connected = false; stopSelf(); break;
            }
        }
        return START_NOT_STICKY;
    }

    private void goForeground() {
        if (foreground) return;
        Notification n = build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NID, n);
        foreground = true;
    }

    private void send(String cmd, Object arg) {
        if (cmd == null) return;
        awake();
        h.post(() -> post(cmd, arg));
    }

    /** Read the PC's state; returns the base URL used (null if the PC was not reachable). */
    private String readState() {
        String base = Net.base(this);
        String body = base == null ? null : Net.get(base + "/state", Net.cookie(this), 4000);
        lastPoll = SystemClock.elapsedRealtime();
        reachable = body != null;
        try {
            JSONObject d = body == null ? null : new JSONObject(body);
            now = d != null && d.optJSONObject("now") != null ? d.getJSONObject("now") : new JSONObject();
        } catch (Exception e) {
            now = new JSONObject();
            reachable = false;
        }
        if (SystemClock.elapsedRealtime() - volTouched > 1500 && now.has("vol"))
            volume.setCurrentVolume((int) Math.round(now.optDouble("vol", .5) * (now.optBoolean("muted") ? 0 : 100)));
        return reachable ? base : null;
    }

    private void poll() {
        h.removeCallbacks(pollR);                    // only the scheduled poll: queued commands still go out
        String base = readState();
        String kind = now.optString("kind", "none");
        boolean playing = !"none".equals(kind) && !now.optBoolean("paused", true);
        connected = reachable;
        long t = SystemClock.elapsedRealtime();
        if (reachable) lostSince = t;
        else if (!MainActivity.visible && t - lostSince > 600_000) { stopSelf(); return; }   // PC gone for 10 min

        if (base != null) updateArt(base);
        updateSession(kind);
        nm.notify(NID, build());
        // screen off: slow polling (a volume button re-reads the PC first anyway), no wake lock held between polls
        h.postDelayed(pollR, screenOff ? 15000 : MainActivity.visible ? 1000 : (playing ? 2000 : 5000));
    }

    private void updateArt(String base) {
        String vid = now.optString("vid", ""), tid = now.optString("tid", "");
        String key = !vid.isEmpty() && !"null".equals(vid) ? "/x/poster/" + vid : !tid.isEmpty() && !"null".equals(tid) ? "/x/cover/" + tid : "";
        if (key.equals(artKey)) return;
        artKey = key;
        art = key.isEmpty() || base == null ? null : Net.bitmap(base + key, Net.cookie(this));
    }

    private void updateSession(String kind) {
        boolean none = "none".equals(kind);
        MediaMetadata.Builder m = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, none ? "Nothing playing" : now.optString("title", ""))
                .putString(MediaMetadata.METADATA_KEY_ARTIST, none ? "ULTRON" : now.optString("sub", ""))
                .putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (now.optDouble("dur", 0) * 1000));
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
        session.setMetadata(m.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO
                | PlaybackState.ACTION_FAST_FORWARD | PlaybackState.ACTION_REWIND;
        boolean paused = none || now.optBoolean("paused", true);
        int st = none ? PlaybackState.STATE_STOPPED : paused ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_PLAYING;
        float speed = paused ? 0f : (float) now.optDouble("speed", 1);
        if (screenOff && !local && reachable) st = PlaybackState.STATE_PLAYING;   // keep the volume buttons (see top)
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
                .setState(st, (long) (now.optDouble("pos", 0) * 1000), speed).build());
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action action(int icon, String label, String cmd, int req) {
        Intent i = new Intent(this, RemoteService.class).setAction(ACTION_CMD).putExtra("cmd", cmd);
        PendingIntent pi = PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), label, pi).build();
    }

    private Notification build() {
        String kind = now.optString("kind", "none");
        boolean none = "none".equals(kind), paused = now.optBoolean("paused", true);
        Notification.Builder b = new Notification.Builder(this, CH)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(none ? "ULTRON Remote" : now.optString("title", ""))
                .setContentText(none ? "Connected · nothing playing on your PC" : now.optString("sub", ""))
                .setContentIntent(openApp())
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        if (!reachable) b.setContentTitle("ULTRON Remote").setContentText("Looking for your PC…");
        if (art != null) b.setLargeIcon(art);
        Intent stop = new Intent(this, RemoteService.class).setAction(ACTION_STOP);
        Notification.Action off = new Notification.Action.Builder(Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel),
                "Disconnect", PendingIntent.getService(this, 9, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
        if (none || !reachable) b.addAction(off);
        if (!none && reachable) {
            b.addAction(action(android.R.drawable.ic_media_previous, "Previous", "prev", 1));
            b.addAction(action(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause, paused ? "Play" : "Pause", "toggle", 2));
            b.addAction(action(android.R.drawable.ic_media_next, "Next", "next", 3));
            b.addAction(off);
            b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        }
        return b.build();
    }

    /** The app was swiped away from recent apps: the remote stops with it. */
    @Override public void onTaskRemoved(Intent root) {
        connected = false;
        stopSelf();
        super.onTaskRemoved(root);
    }

    @Override public void onDestroy() {
        connected = false;
        try { unregisterReceiver(screen); } catch (Exception ignored) {}
        try { if (wake.isHeld()) wake.release(); } catch (Exception ignored) {}
        h.removeCallbacksAndMessages(null);
        thread.quitSafely();
        session.setActive(false);
        session.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
