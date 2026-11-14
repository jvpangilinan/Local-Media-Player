package com.zeno.ultronremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
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
import android.os.SystemClock;

import org.json.JSONObject;

/**
 * Keeps the PC's "now playing" on the phone outside the app: a media session (lock screen + notification controls) and
 * REMOTE volume, so the phone's volume buttons change the PC's volume, even with the screen off. Polls /state while it
 * runs; stops itself when nothing has played for a while and the app is not open.
 */
public class RemoteService extends Service {
    static final String ACTION_CMD = "cmd", ACTION_LOCAL = "local", ACTION_VOL = "vol", ACTION_STOP = "stop";
    static volatile boolean pcPlaying = false;     // read by MainActivity to decide who gets the volume keys

    private static final String CH = "playback";
    private static final int NID = 7;

    private MediaSession session;
    private VolumeProvider volume;
    private HandlerThread thread;
    private Handler h;
    private NotificationManager nm;
    private JSONObject now = new JSONObject();
    private boolean local = false, foreground = false;
    private long idleSince = SystemClock.elapsedRealtime(), volTouched = 0;
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
            @Override public void onPlay() { if (now.optBoolean("paused", true)) send("toggle", null); }
            @Override public void onPause() { if (!now.optBoolean("paused", true)) send("toggle", null); }
            @Override public void onSkipToNext() { send("next", null); }
            @Override public void onSkipToPrevious() { send("prev", null); }
            @Override public void onSeekTo(long ms) { send("seek_abs", ms / 1000.0); }
            @Override public void onFastForward() { send("seek_rel", 10); }
            @Override public void onRewind() { send("seek_rel", -10); }
        });
        session.setSessionActivity(openApp());
        volume = new VolumeProvider(VolumeProvider.VOLUME_CONTROL_ABSOLUTE, 100, 50) {
            @Override public void onSetVolumeTo(int v) { setVol(v); }
            @Override public void onAdjustVolume(int dir) { setVol(getCurrentVolume() + dir * 5); }
        };
        session.setPlaybackToRemote(volume);
        session.setActive(true);

        thread = new HandlerThread("ultron-remote");
        thread.start();
        h = new Handler(thread.getLooper());
        goForeground();
        h.post(pollR);
    }

    private void setVol(int v) {
        v = Math.max(0, Math.min(100, v));
        volume.setCurrentVolume(v);
        volTouched = SystemClock.elapsedRealtime();
        send("vol", v / 100.0);
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        goForeground();
        if (i != null && i.getAction() != null) {
            switch (i.getAction()) {
                case ACTION_CMD: send(i.getStringExtra("cmd"), null); break;
                case ACTION_VOL: setVol(volume.getCurrentVolume() + i.getIntExtra("d", 0) * 5); break;
                case ACTION_LOCAL:
                    local = i.getBooleanExtra("on", false);
                    if (local) session.setPlaybackToLocal(new android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_MEDIA).build());   // phone is playing: its own volume
                    else session.setPlaybackToRemote(volume);
                    break;
                case ACTION_STOP: stopSelf(); break;
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
        h.post(() -> {
            try {
                JSONObject j = new JSONObject();
                j.put("cmd", cmd);
                j.put("arg", arg == null ? JSONObject.NULL : arg);
                String base = Net.base(this);
                if (base != null) Net.post(base + "/cmd", Net.cookie(this), j.toString());
            } catch (Exception ignored) {}
            h.removeCallbacks(pollR);
            h.postDelayed(pollR, 250);
        });
    }

    private void poll() {
        h.removeCallbacks(pollR);                    // only the scheduled poll: queued commands still go out
        String base = Net.base(this);
        String body = base == null ? null : Net.get(base + "/state", Net.cookie(this), 4000);
        try {
            JSONObject d = body == null ? null : new JSONObject(body);
            now = d != null && d.optJSONObject("now") != null ? d.getJSONObject("now") : new JSONObject();
        } catch (Exception e) {
            now = new JSONObject();
        }
        String kind = now.optString("kind", "none");
        boolean playing = !"none".equals(kind) && !now.optBoolean("paused", true);
        pcPlaying = !"none".equals(kind);
        long t = SystemClock.elapsedRealtime();
        if (pcPlaying) idleSince = t;
        else if (!MainActivity.visible && t - idleSince > 120_000) { stopSelf(); return; }   // nothing for 2 min, app closed

        if (SystemClock.elapsedRealtime() - volTouched > 1500 && now.has("vol"))
            volume.setCurrentVolume((int) Math.round(now.optDouble("vol", .5) * (now.optBoolean("muted") ? 0 : 100)));
        updateArt(base);
        updateSession(kind);
        nm.notify(NID, build());
        h.postDelayed(pollR, MainActivity.visible ? 1000 : (playing ? 2000 : 5000));
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
        int st = none ? PlaybackState.STATE_STOPPED : now.optBoolean("paused", true) ? PlaybackState.STATE_PAUSED : PlaybackState.STATE_PLAYING;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
                .setState(st, (long) (now.optDouble("pos", 0) * 1000), (float) now.optDouble("speed", 1)).build());
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
        if (art != null) b.setLargeIcon(art);
        if (!none) {
            b.addAction(action(android.R.drawable.ic_media_previous, "Previous", "prev", 1));
            b.addAction(action(paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause, paused ? "Play" : "Pause", "toggle", 2));
            b.addAction(action(android.R.drawable.ic_media_next, "Next", "next", 3));
            b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        }
        return b.build();
    }

    @Override public void onDestroy() {
        pcPlaying = false;
        h.removeCallbacksAndMessages(null);
        thread.quitSafely();
        session.setActive(false);
        session.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
}
