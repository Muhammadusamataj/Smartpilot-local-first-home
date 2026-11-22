package com.example.tuyalocalkey.offline;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import com.chaquo.python.android.AndroidPlatform;
import com.chaquo.python.Python;
import com.chaquo.python.PyObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Owns the embedded Python server for the whole app lifetime.
 *
 * Funtouch OS is aggressive with process death once an Activity leaves the
 * screen, so the server lives here as a connected-device foreground service
 * instead of in the Activity. The notification is the user-visible reason the
 * app stays alive and is also where Vivo's notification gate applies.
 */
public class LocalControlService extends Service {
    private static final String TAG = "TuyaLocalService";
    private static final String CHANNEL_ID = "smart-pilot-local-control";
    private static final String EVENT_CHANNEL_ID = "smart-pilot-events";
    private static final int NOTIFICATION_ID = 1001;
    private static final int EVENT_NOTIFICATION_BASE = 2000;
    private static final int PORT = 8000;
    private static final int[] EVENT_IDS = {2000, 2001, 2002, 2003, 2004};

    private static volatile boolean running = false;
    private static volatile int lastEventId = -1;
    private static volatile String lastError = "";
    private static volatile String lastHint = "";
    private static volatile String appliedConfigKey = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private NotificationManager notificationManager;
    private SharedPreferences prefs;
    private ConnectivityManager.NetworkCallback networkCallback;
    private WifiManager.WifiLock wifiLock;
    private final Set<Integer> notifiedEvents = new HashSet<>();

    private final Runnable eventPoll = new Runnable() {
        @Override
        public void run() {
            new Thread(LocalControlService.this::fetchEvents, "smartpilot-events").start();
            main.postDelayed(this, 5000);
        }
    };

    public static boolean isRunning() {
        return running;
    }

    public static String getLastError() {
        return lastError;
    }

    public static String getNetworkHint() {
        return lastHint;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(OfflineActivity.PREFS, MODE_PRIVATE);
        notificationManager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        // A fresh service instance must always re-evaluate the server state.
        appliedConfigKey = "";
        createChannel();
        // startForeground() must happen before the five-second FGS deadline;
        // Python/Flask startup happens afterwards on its own thread.
        showNotification(getString(R.string.notification_starting));
        acquireWifiLock();
        registerNetworkCallback();
        running = true;
        main.postDelayed(eventPoll, 5000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Config config = readConfig();
        lastHint = config.hint;
        if (!config.key().equals(appliedConfigKey)) {
            appliedConfigKey = config.key();
            startOrReconfigure(config);
        } else {
            updateHintInPython(config.hint);
        }
        updateNetworkFactsInPython();
        // Recreate with the persisted settings if Funtouch OS restarts us.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        main.removeCallbacks(eventPoll);
        releaseWifiLock();
        unregisterNetworkCallback();
        stopPython();
        super.onDestroy();
    }

    private Config readConfig() {
        String user = prefs.getString(OfflineActivity.KEY_USER, "");
        String password = prefs.getString(OfflineActivity.KEY_PASSWORD, "");
        if (user == null || user.isEmpty()) user = "tuya";
        if (password == null || password.isEmpty()) {
            password = NetworkUtils.randomToken();
            prefs.edit().putString(OfflineActivity.KEY_PASSWORD, password).apply();
        }
        boolean remote = prefs.getBoolean(OfflineActivity.KEY_ENABLED, false);
        String host = remote ? "0.0.0.0" : "127.0.0.1";
        String tailscale = remote ? NetworkUtils.tailscaleIp() : "";
        return new Config(host, NetworkUtils.wifiSubnet(this), tailscale,
                remote ? user : "", remote ? password : "");
    }

    /** Each call gets its own thread because the Python entry points block. */
    private void startOrReconfigure(final Config config) {
        new Thread(() -> {
            try {
                if (!Python.isStarted()) {
                    Python.start(new AndroidPlatform(getApplicationContext()));
                }
                PyObject module = Python.getInstance().getModule("android_entry");
                boolean alreadyRunning = module.callAttr("is_running").toBoolean();
                if (alreadyRunning) {
                    module.callAttr("reconfigure", getFilesDir().getAbsolutePath(),
                            config.host, PORT, config.hint, config.tailscale,
                            config.user, config.password);
                } else {
                    module.callAttr("start", getFilesDir().getAbsolutePath(),
                            config.host, PORT, config.hint, config.tailscale,
                            config.user, config.password);
                }
                lastError = "";
                main.post(() -> showNotification(notificationText(config)));
            } catch (final Throwable e) {
                lastError = String.valueOf(e);
                Log.e(TAG, "Embedded local server failed", e);
                main.post(() -> showNotification(getString(R.string.notification_error)));
            }
        }, "tuya-local-server").start();
    }

    private void updateHintInPython(String hint) {
        if (!Python.isStarted()) return;
        new Thread(() -> {
            try {
                Python.getInstance().getModule("android_entry")
                        .callAttr("update_network_hint", hint);
            } catch (Throwable e) {
                Log.w(TAG, "Could not refresh Wi-Fi hint", e);
            }
        }, "tuya-network-hint").start();
    }

    private void updateNetworkFactsInPython() {
        if (!Python.isStarted()) return;
        final String facts = NetworkUtils.networkFacts(getApplicationContext());
        new Thread(() -> {
            try {
                Python.getInstance().getModule("android_entry")
                        .callAttr("update_network_facts", facts);
            } catch (Throwable e) {
                Log.w(TAG, "Could not refresh network facts", e);
            }
        }, "tuya-network-facts").start();
    }

    private void stopPython() {
        if (!Python.isStarted()) return;
        new Thread(() -> {
            try {
                Python.getInstance().getModule("android_entry").callAttr("stop");
            } catch (Throwable e) {
                Log.w(TAG, "Could not stop embedded server", e);
            }
        }, "tuya-local-stop").start();
    }

    private void registerNetworkCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        ConnectivityManager manager =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                refreshHint();
            }

            @Override
            public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
                refreshHint();
            }

            @Override
            public void onLost(Network network) {
                refreshHint();
            }
        };
        try {
            manager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            Log.w(TAG, "Could not watch network changes", e);
            networkCallback = null;
        }
    }

    private void refreshHint() {
        String hint = NetworkUtils.wifiSubnet(getApplicationContext());
        lastHint = hint;
        updateHintInPython(hint);
        updateNetworkFactsInPython();
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) return;
        ConnectivityManager manager =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // Already unregistered during process teardown.
            }
        }
        networkCallback = null;
    }

    @SuppressWarnings("deprecation")
    private void acquireWifiLock() {
        WifiManager manager = (WifiManager) getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
        if (manager == null) return;
        int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL;
        try {
            wifiLock = manager.createWifiLock(mode, "SmartPilotLocalControl");
            wifiLock.acquire();
        } catch (Exception e) {
            Log.w(TAG, "Could not hold Wi-Fi lock", e);
            wifiLock = null;
        }
    }

    private void releaseWifiLock() {
        if (wifiLock == null) return;
        try {
            if (wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {
            // Release is best effort during teardown.
        }
        wifiLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notificationManager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_desc));
        channel.setSound(null, null);
        notificationManager.createNotificationChannel(channel);
        NotificationChannel alerts = new NotificationChannel(EVENT_CHANNEL_ID,
                "Smart Pilot activity", NotificationManager.IMPORTANCE_DEFAULT);
        alerts.setDescription("Scene, safety-rule and AC automation alerts");
        notificationManager.createNotificationChannel(alerts);
    }

    /** Poll the local event log; no device data leaves the phone. */
    private void fetchEvents() {
        HttpURLConnection connection = null;
        try {
            int since = Math.max(0, lastEventId);
            connection = (HttpURLConnection) new URL(
                    "http://127.0.0.1:8000/api/local/events?since=" + since).openConnection();
            connection.setConnectTimeout(1200);
            connection.setReadTimeout(2000);
            if (prefs.getBoolean(OfflineActivity.KEY_ENABLED, false)) {
                String user = prefs.getString(OfflineActivity.KEY_USER, "tuya");
                String password = prefs.getString(OfflineActivity.KEY_PASSWORD, "");
                String token = Base64.encodeToString(
                        (user + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                connection.setRequestProperty("Authorization", "Basic " + token);
            }
            if (connection.getResponseCode() != 200) return;
            JSONObject payload;
            try (InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int count;
                while ((count = in.read(chunk)) != -1 && buffer.size() < 256 * 1024) {
                    buffer.write(chunk, 0, count);
                }
                payload = new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
            }
            final JSONObject result = payload;
            main.post(() -> showEventNotifications(result));
        } catch (Exception ignored) {
            // The server may still be starting; the next poll will catch up.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void showEventNotifications(JSONObject payload) {
        int latest = payload.optInt("latest", 0);
        if (lastEventId < 0) {  // baseline on start: never replay old events
            lastEventId = latest;
            return;
        }
        JSONArray events = payload.optJSONArray("events");
        if (events != null) {
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.optJSONObject(i);
                if (event == null) continue;
                int id = event.optInt("id", 0);
                String kind = event.optString("kind", "");
                if (id <= lastEventId || notifiedEvents.contains(id)) continue;
                if (!kind.equals("scene") && !kind.equals("scene_error") &&
                        !kind.equals("rule") && !kind.equals("rule_error") &&
                        !kind.equals("ac_auto") && !kind.equals("backup")) continue;
                showEventNotification(id,
                        event.optString("title", "Smart Pilot"),
                        event.optString("body", ""));
                notifiedEvents.add(id);
                if (notifiedEvents.size() > 50) notifiedEvents.clear();
            }
        }
        lastEventId = Math.max(lastEventId, latest);
    }

    private void showEventNotification(int id, String title, String body) {
        if (notificationManager == null || !notificationManager.areNotificationsEnabled()) return;
        Intent open = new Intent(this, OfflineActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, EVENT_CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_local)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(pending)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setAutoCancel(true);
        int index = Math.min(EVENT_IDS.length - 1,
                Math.max(0, (id - EVENT_NOTIFICATION_BASE) % EVENT_IDS.length));
        notificationManager.notify(EVENT_IDS[index], builder.build());
    }

    private String notificationText(Config config) {
        if (!config.host.equals("127.0.0.1")) return getString(R.string.notification_direct);
        String hint = config.hint.isEmpty()
                ? getString(R.string.phone_wifi_none) : config.hint;
        return getString(R.string.notification_ready) + " · " + hint;
    }

    private void showNotification(String text) {
        if (notificationManager == null) return;
        Intent open = new Intent(this, OfflineActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_local)
                .setContentTitle(getString(R.string.notification_title))
                .setContentText(text)
                .setContentIntent(pending)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        notificationManager.notify(NOTIFICATION_ID, notification);
    }

    /** Immutable snapshot of the settings the server needs. */
    private static final class Config {
        final String host;
        final String hint;
        final String tailscale;
        final String user;
        final String password;

        Config(String host, String hint, String tailscale, String user, String password) {
            this.host = host;
            this.hint = hint;
            this.tailscale = tailscale;
            this.user = user;
            this.password = password;
        }

        String key() {
            return host + '|' + hint + '|' + tailscale + '|' + user + '|' + password;
        }
    }
}
