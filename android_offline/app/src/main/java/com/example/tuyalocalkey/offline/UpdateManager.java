package com.example.tuyalocalkey.offline;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** GitHub Releases update + rollback helper. No silent installs are attempted. */
public final class UpdateManager {
    private static final String TAG = "SmartPilotUpdate";
    private static final String RELEASE_API =
            "https://api.github.com/repos/Muhammadusamataj/Smartpilot-local-first-home/releases/latest";
    private static final String PREFS = "smartpilot_updates";
    private static final String KEY_VERSION = "latest_version";
    private static final String KEY_URL = "latest_apk";
    private static final String KEY_ERROR = "last_error";
    private static final long MAX_APK = 80L * 1024 * 1024;
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean BUSY = new AtomicBoolean(false);

    public interface Callback {
        void done(JSONObject result);
    }

    private UpdateManager() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static File folder(Context context) {
        File dir = new File(context.getFilesDir(), ApkProvider.FOLDER);
        if (!dir.isDirectory()) dir.mkdirs();
        return dir;
    }

    private static String currentVersion(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    private static int[] parts(String version) {
        if (version == null) return new int[]{0, 0, 0};
        String clean = version.replaceFirst("^[vV]", "").trim();
        String[] raw = clean.split("\\.");
        int[] result = new int[3];
        for (int i = 0; i < 3; i++) {
            try {
                result[i] = i < raw.length ? Integer.parseInt(raw[i].replaceAll("[^0-9]", "")) : 0;
            } catch (Exception e) {
                result[i] = 0;
            }
        }
        return result;
    }

    private static boolean newer(String latest, String current) {
        int[] a = parts(latest), b = parts(current);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) return a[i] > b[i];
        }
        return false;
    }

    private static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || context.getPackageManager().canRequestPackageInstalls();
    }

    /** Synchronous, tiny state read used by the Settings UI. */
    public static String state(Context context) {
        JSONObject out = new JSONObject();
        try {
            SharedPreferences saved = prefs(context);
            String latest = saved.getString(KEY_VERSION, null);
            String current = currentVersion(context);
            out.put("platform", "android");
            out.put("current", current);
            out.put("latest", latest);
            out.put("available", latest != null && newer(latest, current));
            out.put("canInstall", canInstall(context));
            out.put("hasBackup", new File(folder(context), "previous.apk").isFile());
            out.put("busy", BUSY.get());
            String error = saved.getString(KEY_ERROR, null);
            if (error != null) out.put("error", error);
        } catch (Exception e) {
            try { out.put("error", "state_failed"); } catch (Exception ignored) { }
        }
        return out.toString();
    }

    public static void openInstallPermission(Context context) {
        try {
            Intent intent;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
            } else {
                intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "Could not open install permission settings", e);
        }
    }

    public static void check(final Context context, final Callback callback) {
        if (!BUSY.compareAndSet(false, true)) {
            finish(callback, staleState(context, "busy"));
            return;
        }
        POOL.execute(() -> {
            JSONObject result;
            try {
                JSONObject release = fetchRelease();
                SharedPreferences saved = prefs(context);
                saved.edit().putString(KEY_VERSION, release.optString("version"))
                        .putString(KEY_URL, release.optString("apk"))
                        .putString(KEY_ERROR, null).apply();
                result = stateJson(context, "Update checked");
            } catch (Exception e) {
                prefs(context).edit().putString(KEY_ERROR, safeError(e)).apply();
                result = staleState(context, safeError(e));
            }
            BUSY.set(false);
            finish(callback, result);
        });
    }

    public static void install(final Context context, final Callback callback) {
        if (!BUSY.compareAndSet(false, true)) {
            finish(callback, staleState(context, "busy"));
            return;
        }
        POOL.execute(() -> {
            JSONObject result;
            try {
                if (!canInstall(context)) {
                    openInstallPermission(context);
                    result = stateJson(context, "Allow this app to install unknown apps first");
                } else {
                    SharedPreferences saved = prefs(context);
                    String url = saved.getString(KEY_URL, null);
                    String version = saved.getString(KEY_VERSION, null);
                    if (url == null || version == null) {
                        JSONObject release = fetchRelease();
                        url = release.optString("apk");
                        version = release.optString("version");
                        saved.edit().putString(KEY_URL, url).putString(KEY_VERSION, version).apply();
                    }
                    keepBackup(context);
                    File apk = download(context, url, "update.apk");
                    verifyApk(apk);
                    File installed = new File(folder(context), "update-" + version + ".apk");
                    if (installed.exists()) installed.delete();
                    if (!apk.renameTo(installed)) throw new IllegalStateException("could_not_stage_update");
                    launchInstall(context, installed);
                    saved.edit().putString(KEY_ERROR, null).apply();
                    result = stateJson(context, "Install prompt opened for " + version);
                }
            } catch (Exception e) {
                prefs(context).edit().putString(KEY_ERROR, safeError(e)).apply();
                result = staleState(context, safeError(e));
            }
            BUSY.set(false);
            finish(callback, result);
        });
    }

    public static void rollback(final Context context, final Callback callback) {
        File backup = new File(folder(context), "previous.apk");
        if (!backup.isFile()) {
            finish(callback, staleState(context, "no_rollback_copy"));
            return;
        }
        try {
            if (!canInstall(context)) {
                openInstallPermission(context);
                finish(callback, staleState(context, "Allow this app to install unknown apps first"));
                return;
            }
            launchInstall(context, backup);
            finish(callback, stateJson(context, "Rollback install prompt opened"));
        } catch (Exception e) {
            finish(callback, staleState(context, safeError(e)));
        }
    }

    private static JSONObject stateJson(Context context, String message) {
        JSONObject result = new JSONObject();
        try {
            result = new JSONObject(state(context));
            result.put("ok", true);
            result.put("message", message);
        } catch (Exception e) {
            try { result.put("error", "state_failed"); } catch (Exception ignored) { }
        }
        return result;
    }

    private static JSONObject staleState(Context context, String error) {
        JSONObject result = new JSONObject();
        try {
            result = new JSONObject(state(context));
            result.put("error", error);
            result.put("ok", false);
        } catch (Exception e) {
            try { result.put("error", error); } catch (Exception ignored) { }
        }
        return result;
    }

    private static void finish(Callback callback, JSONObject result) {
        if (callback != null) callback.done(result);
    }

    private static String safeError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.length() > 120) return error.getClass().getSimpleName();
        return message;
    }

    private static HttpURLConnection open(String url, int timeout) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(timeout);
        connection.setReadTimeout(timeout);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "SmartPilot-Local-Android");
        return connection;
    }

    private static JSONObject fetchRelease() throws Exception {
        HttpURLConnection connection = open(RELEASE_API, 12000);
        try {
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            if (connection.getResponseCode() != 200) throw new IllegalStateException("release_http_" + connection.getResponseCode());
            byte[] raw = read(connection.getInputStream(), 512 * 1024);
            JSONObject release = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) {
                throw new IllegalStateException("no_stable_release");
            }
            String tag = release.optString("tag_name");
            String version = tag.replaceFirst("^[vV]", "");
            if (version.isEmpty() || parts(version)[0] == 0) throw new IllegalStateException("invalid_release_tag");
            JSONArray assets = release.optJSONArray("assets");
            String apk = null;
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.optJSONObject(i);
                    if (asset == null) continue;
                    String name = asset.optString("name", "");
                    String url = asset.optString("browser_download_url", "");
                    if (!name.toLowerCase().endsWith(".apk") || !url.startsWith("https://")) continue;
                    if (apk == null || name.toLowerCase().contains("smartpilot")) apk = url;
                }
            }
            if (apk == null) throw new IllegalStateException("release_has_no_apk");
            JSONObject result = new JSONObject();
            result.put("version", version);
            result.put("apk", apk);
            return result;
        } finally {
            connection.disconnect();
        }
    }

    private static void keepBackup(Context context) throws Exception {
        String source = context.getApplicationInfo().sourceDir;
        File current = new File(source);
        if (!current.isFile()) return;
        File backup = new File(folder(context), "previous.apk");
        copy(current, backup);
    }

    private static File download(Context context, String url, String name) throws Exception {
        File target = new File(folder(context), name);
        HttpURLConnection connection = open(url, 30000);
        try {
            int code = connection.getResponseCode();
            if (code != 200 && code != 302) throw new IllegalStateException("download_http_" + code);
            long declared = connection.getContentLengthLong();
            if (declared > MAX_APK) throw new IllegalStateException("apk_too_large");
            copy(connection.getInputStream(), target, MAX_APK);
            return target;
        } finally {
            connection.disconnect();
        }
    }

    private static void verifyApk(File file) throws Exception {
        if (!file.isFile() || file.length() < 100 * 1024 || file.length() > MAX_APK) {
            throw new IllegalStateException("invalid_apk_size");
        }
        byte[] magic = new byte[2];
        try (InputStream in = new java.io.FileInputStream(file)) {
            if (in.read(magic) != 2 || magic[0] != 'P' || magic[1] != 'K') {
                throw new IllegalStateException("not_an_apk");
            }
        }
    }

    private static void copy(File source, File target) throws Exception {
        try (InputStream in = new java.io.FileInputStream(source);
             FileOutputStream out = new FileOutputStream(target)) {
            pipe(in, out, MAX_APK);
        }
    }

    private static void copy(InputStream source, File target, long limit) throws Exception {
        try (InputStream in = source; FileOutputStream out = new FileOutputStream(target)) {
            pipe(in, out, limit);
        }
    }

    private static void pipe(InputStream in, FileOutputStream out, long limit) throws Exception {
        byte[] buffer = new byte[16 * 1024];
        long total = 0;
        int count;
        while ((count = in.read(buffer)) != -1) {
            total += count;
            if (total > limit) throw new IllegalStateException("file_too_large");
            out.write(buffer, 0, count);
        }
    }

    private static byte[] read(InputStream in, int limit) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int count;
        while ((count = in.read(buffer)) != -1) {
            if (out.size() + count > limit) throw new IllegalStateException("response_too_large");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }

    private static void launchInstall(Context context, File apk) {
        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
        intent.setDataAndType(ApkProvider.uriFor(context, apk.getName()),
                "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
        context.startActivity(intent);
    }
}
