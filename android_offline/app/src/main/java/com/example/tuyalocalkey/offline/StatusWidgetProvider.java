package com.example.tuyalocalkey.offline;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Read-only home-screen status widget.
 *
 * It never sends a command and never reads or stores device keys. The only
 * network operation is a GET to the existing local read endpoint, using the
 * same verified flag the app already shows.
 */
public class StatusWidgetProvider extends AppWidgetProvider {
    private static final String API = "http://127.0.0.1:8000/api/local/devices";
    private static final int LIMIT = 256 * 1024;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id, "Checking local backend…");
        new Thread(() -> {
            String status = readStatus();
            for (int id : ids) render(context, manager, id, status);
        }, "smartpilot-widget-status").start();
    }

    private static void render(Context context, AppWidgetManager manager, int id, String status) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_status);
        views.setTextViewText(R.id.widget_status, status);
        manager.updateAppWidget(id, views);
    }

    private static String readStatus() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(API).openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            if (connection.getResponseCode() != 200) return "Local server unavailable";
            String body = new String(read(connection.getInputStream()), StandardCharsets.UTF_8);
            JSONObject data = new JSONObject(body);
            JSONArray devices = data.optJSONArray("devices");
            int total = devices == null ? 0 : devices.length();
            int verified = 0;
            if (devices != null) {
                for (int i = 0; i < total; i++) {
                    JSONObject device = devices.optJSONObject(i);
                    if (device != null && device.optBoolean("verified")) verified++;
                }
            }
            return verified + " of " + total + " devices verified";
        } catch (Exception error) {
            return "No verified local read";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static byte[] read(InputStream input) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (out.size() + count > LIMIT) throw new IllegalStateException("response_too_large");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }
}
