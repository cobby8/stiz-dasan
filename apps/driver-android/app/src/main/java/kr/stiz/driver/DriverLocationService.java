package kr.stiz.driver;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import org.json.JSONObject;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.*;

/** One native sender survives Activity destruction; it never relies on a WebView timer. */
public final class DriverLocationService extends Service implements LocationListener {
    static volatile DriverLocationService instance;
    static final String START = "START", STOP = "STOP", EVENT = "kr.stiz.driver.GPS_STATE";
    private static final int NOTIFICATION = 701;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private SessionStore store;
    private JSONObject session = new JSONObject();
    private LocationManager locations;
    private volatile Location latest;
    private volatile boolean localRunning;
    private volatile boolean stopRequested;
    boolean isRunning() { return localRunning; }
    private boolean starting, stopped, subscribed;
    private long lastSample, stopSince;
    private long lastAttempt;
    private JSONObject call(String action, JSONObject body) throws Exception {
        PowerManager.WakeLock lock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "stiz:driver-network");
        lock.acquire(30000);
        try { return DriverApi.call(session, action, body); }
        finally { if (lock.isHeld()) lock.release(); }
    }
    private String currentState = "idle", currentTransmission = "idle", currentError;
    void snapshot() { worker.execute(() -> emit(currentState, currentTransmission, currentError)); }

    @Override public void onCreate() {
        super.onCreate(); instance = this; store = new SessionStore(this); locations = (LocationManager) getSystemService(LOCATION_SERVICE);
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("driver-location", "운행 위치 공유", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        // A notification stop never requests coordinates or restarts tracking.
        if (STOP.equals(action)) {
            stopRequested = true; localRunning = false; latest = null; locations.removeUpdates(this); subscribed = false;
            worker.execute(this::stopRun); return START_NOT_STICKY;
        }
        if (!START.equals(action) || starting || localRunning) return START_NOT_STICKY;
        stopRequested = false;
        starting = true;
        final String token = intent.getStringExtra("token");
        try { startForeground(NOTIFICATION, notification("서버 연결 확인 중")); }
        catch (RuntimeException failure) {
            starting = false; localRunning = false;
            try { session = new JSONObject().put("token", token); } catch (Exception ignored) { }
            emit("error", "error", "위치 공유 알림 서비스를 시작하지 못했습니다. 알림·위치 권한을 확인한 뒤 다시 시도해 주세요.");
            stopSelf(); return START_NOT_STICKY;
        }
        worker.execute(() -> startRun(token));
        return START_NOT_STICKY;
    }
    private void persist() throws Exception { store.write(session); }
    private void startRun(String token) {
        try {
            session = store.read();
            if (session.optBoolean("stopPending")) {
                stopRun(); return;
            }
            if (!token.equals(session.optString("token")) || session.optBoolean("stopped", true)) {
                byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
                StringBuilder secret = new StringBuilder(); for (byte b : bytes) secret.append(String.format("%02x", b & 255));
                String device = session.optString("deviceId", UUID.randomUUID().toString());
                session = new JSONObject().put("token", token).put("sessionId", UUID.randomUUID().toString())
                    .put("secret", secret.toString()).put("deviceId", device).put("sequence", 0).put("stopped", false);
                persist(); // Persist before start: a lost HTTP response retries the same credential.
            }
            emit("requesting", "idle", null);
            JSONObject response = call("start", new JSONObject());
            session.put("expiresAt", response.getString("expiresAt")).put("sequence", Math.max(session.optLong("sequence"), response.optLong("lastSequence")));
            if (stopRequested) { starting = false; persist(); stopRun(); return; }
            persist(); localRunning = true; starting = false; stopped = false;
            main.post(this::subscribe);
            emit("requesting", "idle", null);
            worker.scheduleWithFixedDelay(this::tick, 1, 10, TimeUnit.SECONDS);
        } catch (Exception failure) {
            starting = false; localRunning = false;
            try { if (!session.has("token")) session.put("token", token); } catch (Exception ignored) { }
            if (failure instanceof DriverApi.ApiFailure) {
                if (((DriverApi.ApiFailure) failure).terminal()) {
                    try { session.put("stopped", true); persist(); } catch (Exception ignored) { }
                }
            }
            emit("error", "failed", friendly(failure));
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        }
    }
    private void subscribe() {
        if (!localRunning || stopRequested || subscribed) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            worker.execute(() -> { emit("denied", "failed", "정확한 위치 권한을 허용해 주세요."); stopRun(); }); return;
        }
        try {
            if (locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0, this, Looper.getMainLooper());
            if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 0, this, Looper.getMainLooper());
            subscribed = true;
        } catch (RuntimeException failure) { worker.execute(() -> { emit("error", "failed", "위치 서비스를 확인해 주세요."); stopRun(); }); }
    }
    @Override public void onLocationChanged(Location location) {
        if (!localRunning || stopRequested) return;
        latest = new Location(location);
        worker.execute(this::tick);
    }
    @Override public void onProviderDisabled(String provider) { worker.execute(() -> emit("sharing", "failed", "휴대폰 위치 설정을 확인해 주세요.")); }
    @Override public void onProviderEnabled(String provider) { main.post(() -> { subscribed = false; locations.removeUpdates(this); subscribe(); }); }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    private void tick() {
        if (stopped) return;
        if (session.optBoolean("stopPending")) { stopRun(); return; }
        if (!localRunning || stopRequested) return;
        if (SystemClock.elapsedRealtime() - lastAttempt < 10000) return;
        try {
            if (Instant.now().isAfter(Instant.parse(session.getString("expiresAt")))) { stopRun(); return; }
            Location sample = latest;
            long now = SystemClock.elapsedRealtimeNanos();
            // Never replay cached or queued coordinates after network recovery.
            if (sample == null || now - sample.getElapsedRealtimeNanos() > TimeUnit.SECONDS.toNanos(25) || sample.getElapsedRealtimeNanos() <= lastSample) {
                emit(sample == null && !session.has("lastSentAt") ? "requesting" : "error", "error", "새 위치를 기다리는 중입니다. 마지막 서버 접수 시각을 확인해 주세요."); return;
            }
            lastSample = sample.getElapsedRealtimeNanos();
            lastAttempt = SystemClock.elapsedRealtime();
            long sequence = session.optLong("sequence") + 1;
            session.put("sequence", sequence); persist();
            String captured = Instant.ofEpochMilli(sample.getTime()).toString();
            JSONObject body = new JSONObject().put("sequence", sequence).put("capturedAt", captured)
                .put("lat", sample.getLatitude()).put("lng", sample.getLongitude()).put("accuracy", sample.getAccuracy());
            if (sample.hasSpeed()) body.put("speed", sample.getSpeed());
            if (sample.hasBearing()) body.put("heading", sample.getBearing());
            emit("sharing", "sending", null);
            JSONObject result = call("location", body);
            if (!localRunning) return;
            String receivedAt = result.getString("lastSentAt");
            Instant.parse(receivedAt);
            if (result.getLong("sequence") != sequence) throw new java.io.IOException("Sequence acknowledgement mismatch");
            session.put("lastSentAt", receivedAt).put("lastLocationAt", captured).put("accuracy", sample.getAccuracy()); persist();
            emit("sharing", "sent", null);
        } catch (Exception failure) {
            if (failure instanceof DriverApi.ApiFailure && ((DriverApi.ApiFailure) failure).terminal()) {
                localRunning = false; main.post(() -> locations.removeUpdates(this));
                try { session.put("stopped", true); persist(); } catch (Exception ignored) { }
                emit("error", "failed", "서버 운행 상태가 변경되었습니다. 다시 확인해 주세요.");
                stopped = true; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
            } else {
                if (failure instanceof DriverApi.ApiFailure && "LOCATION_OUT_OF_ORDER".equals(((DriverApi.ApiFailure) failure).code)) {
                    try { JSONObject status = call("status", new JSONObject()); session.put("sequence", Math.max(session.optLong("sequence"), status.optLong("lastSequence"))); persist(); } catch (Exception ignored) { }
                }
                emit("sharing", "failed", friendly(failure));
            }
        }
    }
    private void stopRun() {
        stopRequested = true; localRunning = false; latest = null; main.post(() -> { locations.removeUpdates(this); subscribed = false; });
        try {
            if (session.length() == 0) session = store.read();
            if (!session.has("sessionId")) { stopped = true; stopSelf(); return; }
            session.put("stopPending", true); persist();
            if (stopSince == 0) stopSince = SystemClock.elapsedRealtime();
            emit("stopping", "sending", null);
            JSONObject result = call("stop", new JSONObject());
            if (!"STOPPED".equals(result.optString("state")) && !"EXPIRED".equals(result.optString("state"))) throw new java.io.IOException("Stop not confirmed");
            session.put("stopPending", false).put("stopped", true).put("serverStopConfirmed", true); persist();
            stopped = true; emit("stopped", "idle", null);
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        } catch (Exception failure) {
            emit("stop-unknown", "failed", "휴대폰 위치 수집은 중단했습니다. 서버 종료 확인을 다시 시도해 주세요.");
            if (SystemClock.elapsedRealtime() - stopSince < 120000) worker.schedule(this::stopRun, 10, TimeUnit.SECONDS);
            else { stopped = true; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
        }
    }
    static String friendly(Exception failure) {
        if (failure instanceof DriverApi.ApiFailure) {
            int code = ((DriverApi.ApiFailure) failure).status;
            String reason = ((DriverApi.ApiFailure) failure).code;
            if (code == 503) return "기사님 앱 위치 공유가 아직 운영 서버에서 활성화되지 않았습니다.";
            if ("RUN_ALREADY_ACTIVE".equals(reason)) return "다른 휴대폰의 운행이 진행 중입니다. 기존 운행을 종료해 주세요.";
            if ("LOCATION_OUT_OF_ORDER".equals(reason)) return "위치 전송 순서를 확인하고 있습니다. 새 위치를 기다려 주세요.";
            if ("LOCATION_NOT_FRESH".equals(reason)) return "새 위치를 기다리고 있습니다. 휴대폰 날짜와 시간을 확인해 주세요.";
            if (code == 401 || code == 410) return "운행 인증이 만료되었습니다. 새 운행 링크를 확인해 주세요.";
        }
        return "서버 연결을 확인해 주세요. 접수되지 않은 위치를 현재 위치로 재전송하지 않습니다.";
    }
    private void emit(String state, String transmission, String error) {
        if (state.equals("sharing")) state = "active";
        if (state.equals("idle") || state.equals("stopped") || state.equals("stopping") || state.equals("stop-unknown")) {
            if (state.equals("stopped")) transmission = "stopped";
            else if (state.equals("stopping")) transmission = "stopping";
            else if (state.equals("stop-unknown")) transmission = "stop-unknown";
            state = "off";
        }
        if (transmission.equals("failed")) transmission = "error";
        currentState = state; currentTransmission = transmission; currentError = error;
        try {
            JSONObject detail = new JSONObject().put("token", session.optString("token")).put("state", state).put("transmission", transmission)
                .put("running", localRunning)
                .put("lastSentAt", session.opt("lastSentAt") == null ? JSONObject.NULL : session.opt("lastSentAt"))
                .put("lastLocationAt", session.opt("lastLocationAt") == null ? JSONObject.NULL : session.opt("lastLocationAt"))
                .put("accuracy", session.opt("accuracy") == null ? JSONObject.NULL : session.opt("accuracy"));
            if (error != null) detail.put("error", error);
            sendBroadcast(new Intent(EVENT).setPackage(getPackageName()).putExtra("detail", detail.toString()));
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(error != null ? error : (localRunning ? "운행 중 · 위치 공유" : "운행 종료 확인 중")));
        } catch (Exception ignored) { }
    }
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, DriverLocationService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, "driver-location").setSmallIcon(android.R.drawable.ic_menu_mylocation).setContentTitle("STIZ 기사님 위치 공유")
            .setContentText(text).setContentIntent(open).setOngoing(localRunning).addAction(new Notification.Action.Builder(null, "운행 종료", stop).build()).build();
    }
    @Override public void onDestroy() { instance = null; localRunning = false; locations.removeUpdates(this); worker.shutdownNow(); super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
