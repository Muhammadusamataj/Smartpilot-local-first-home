package com.example.tuyalocalkey.offline;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Wakes the local server and asks it to run due scenes on a phone alarm. */
public class ScheduleReceiver extends BroadcastReceiver {
    public static final String TICK = "com.example.tuyalocalkey.offline.SCHEDULE_TICK";

    @Override
    public void onReceive(final Context context, Intent intent) {
        Intent service = new Intent(context, LocalControlService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception ignored) {
            // Vivo may refuse a background start; the next user launch still ticks.
        }
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                for (int attempt = 0; attempt < 16; attempt++) {
                    if (portOpen() && postTick(context)) break;
                    Thread.sleep(500);
                }
            } catch (Exception ignored) {
            } finally {
                pending.finish();
            }
        }, "smartpilot-schedule-tick").start();
    }

    private static boolean portOpen() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 8000), 400);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean postTick(Context context) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URLWrapper("http://127.0.0.1:8000/api/local/scheduler/tick").open();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(2500);
            SharedPreferences prefs = context.getSharedPreferences(OfflineActivity.PREFS, Context.MODE_PRIVATE);
            if (prefs.getBoolean(OfflineActivity.KEY_ENABLED, false)) {
                String user = prefs.getString(OfflineActivity.KEY_USER, "tuya");
                String password = prefs.getString(OfflineActivity.KEY_PASSWORD, "");
                String token = Base64.encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
                connection.setRequestProperty("Authorization", "Basic " + token);
            }
            connection.setDoOutput(true);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(new byte[0]);
            }
            return connection.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** Tiny indirection so the URL construction stays in one place. */
    private static final class URLWrapper {
        private final java.net.URL url;

        URLWrapper(String value) throws Exception {
            url = new java.net.URL(value);
        }

        HttpURLConnection open() throws Exception {
            return (HttpURLConnection) url.openConnection();
        }
    }
}
