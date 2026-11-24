package com.example.tuyalocalkey.offline;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.method.HideReturnsTransformationMethod;
import android.text.method.PasswordTransformationMethod;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.DownloadListener;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/** Shows the offline web app; the foreground service owns the Python server. */
public class OfflineActivity extends Activity {
    private static final String TAG = "TuyaOffline";
    private static final String LOCAL_URL = "http://127.0.0.1:8000/local";
    private static final int NOTIFICATION_REQUEST = 1001;

    // Package-private: LocalControlService reads the same private preferences.
    static final String PREFS = "remote_access";
    static final String KEY_ENABLED = "enabled";
    static final String KEY_USER = "user";
    static final String KEY_PASSWORD = "password";

    private WebView web;
    /** Mirrored on the main thread; JS bridges run on JavaBridge and must never touch WebView. */
    private volatile String currentUrl = "";
    private TextView status;
    private Button remoteSettings;
    private CheckBox remoteToggle;
    private View remotePanel;
    private EditText remoteUser;
    private EditText remotePass;
    private Button showPass;
    private TextView remoteUrl;
    private Button copyRemote;

    private Button phoneSettings;
    private View phonePanel;
    private TextView wifiStatus;
    private TextView serviceStatus;
    private TextView notificationStatus;
    private TextView batteryStatus;
    private Button notificationAction;
    private Button batteryAction;

    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable waitForServerCallback = this::waitForServer;
    private int attempts = 0;
    private int serverProbeGeneration = 0;

    private final Runnable phoneRefresh = new Runnable() {
        @Override
        public void run() {
            if (phonePanel.getVisibility() != View.VISIBLE) return;
            refreshPhonePanel();
            handler.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_offline);

        status = findViewById(R.id.status);
        web = findViewById(R.id.webview);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        remoteSettings = findViewById(R.id.remoteSettings);
        remoteToggle = findViewById(R.id.remoteToggle);
        remotePanel = findViewById(R.id.remotePanel);
        remoteUser = findViewById(R.id.remoteUser);
        remotePass = findViewById(R.id.remotePass);
        showPass = findViewById(R.id.showPass);
        remoteUrl = findViewById(R.id.remoteUrl);
        copyRemote = findViewById(R.id.copyRemote);

        phoneSettings = findViewById(R.id.phoneSettings);
        phonePanel = findViewById(R.id.phonePanel);
        wifiStatus = findViewById(R.id.wifiStatus);
        serviceStatus = findViewById(R.id.serviceStatus);
        notificationStatus = findViewById(R.id.notificationStatus);
        batteryStatus = findViewById(R.id.batteryStatus);
        notificationAction = findViewById(R.id.notificationAction);
        batteryAction = findViewById(R.id.batteryAction);

        String user = prefs.getString(KEY_USER, "");
        if (user == null || user.isEmpty()) user = "tuya";
        String password = prefs.getString(KEY_PASSWORD, "");
        if (password == null || password.isEmpty()) {
            password = NetworkUtils.randomToken();
            prefs.edit().putString(KEY_PASSWORD, password).apply();
        }
        remoteUser.setText(user);
        remotePass.setText(password);
        remoteToggle.setChecked(prefs.getBoolean(KEY_ENABLED, false));
        remotePanel.setVisibility(View.GONE);
        updateRemoteUrl(user, password);
        if (remoteEnabled()) applyWebViewAuth(user, password);

        remoteSettings.setOnClickListener(v -> {
            setPanelOpen(remotePanel.getVisibility() != View.VISIBLE);
            if (remotePanel.getVisibility() == View.VISIBLE) setPhonePanelOpen(false);
        });
        phoneSettings.setOnClickListener(v -> {
            setPhonePanelOpen(phonePanel.getVisibility() != View.VISIBLE);
            if (phonePanel.getVisibility() == View.VISIBLE) setPanelOpen(false);
        });
        remoteToggle.setOnCheckedChangeListener((button, checked) ->
                updateRemoteUrl(fieldText(remoteUser), fieldText(remotePass)));
        showPass.setOnClickListener(v -> togglePasswordVisibility());
        copyRemote.setOnClickListener(v -> copyRemoteDetails());
        findViewById(R.id.applyRemote).setOnClickListener(v -> applyRemoteSettings());

        notificationAction.setOnClickListener(v -> openNotificationSettings());
        batteryAction.setOnClickListener(v -> requestBatteryExemption());
        findViewById(R.id.vivoSettings).setOnClickListener(v -> openAppDetails());

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl().toString());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                currentUrl = url == null ? "" : url;
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler authHandler,
                                                  String host, String realm) {
                if (remoteEnabled()
                        && ("127.0.0.1".equalsIgnoreCase(host) || "localhost".equalsIgnoreCase(host))) {
                    String name = fieldText(remoteUser);
                    String secret = fieldText(remotePass);
                    authHandler.proceed(name.isEmpty() ? "tuya" : name, secret);
                } else {
                    authHandler.cancel();
                }
            }
        });

        web.addJavascriptInterface(new QrSaver(), "TuyaNative");
        web.addJavascriptInterface(new PilotBridge(), "PilotNative");
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition,
                                        String mimeType, long contentLength) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    Toast.makeText(OfflineActivity.this, "No app can open this download", Toast.LENGTH_SHORT).show();
                }
            }
        });

        ensureNotificationPermission();
        scheduleAlarm();
        startLocalService();
        waitForServer();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (phonePanel.getVisibility() == View.VISIBLE) refreshPhonePanel();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(phoneRefresh);
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_REQUEST) refreshPhonePanel();
    }

    /** Funtouch OS may deny notifications; the service still runs, but ask once. */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        try {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
        } catch (Exception e) {
            Log.w(TAG, "Could not request notification permission", e);
        }
    }

    /** The service survives Activity death, so re-issue this after any settings change. */
    private void startLocalService() {
        Intent intent = new Intent(this, LocalControlService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Exception e) {
            Log.w(TAG, "Foreground start failed; trying normal start", e);
            try {
                startService(intent);
            } catch (Exception fatal) {
                Log.e(TAG, "Could not start local control service", fatal);
                status.setText(R.string.phone_server_error);
            }
        }
    }

    private boolean notificationsAllowed() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        return manager == null || manager.areNotificationsEnabled();
    }

    private boolean batteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void openNotificationSettings() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                startActivity(intent);
                return;
            }
            openAppDetails();
        } catch (Exception e) {
            openAppDetails();
        }
    }

    private void requestBatteryExemption() {
        if (batteryExempt()) {
            openAppDetails();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            openAppDetails();
        }
    }

    private void openAppDetails() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, R.string.phone_settings_unavailable, Toast.LENGTH_SHORT).show();
        }
    }

    private void setPhonePanelOpen(boolean open) {
        phonePanel.setVisibility(open ? View.VISIBLE : View.GONE);
        phoneSettings.setText(open ? R.string.phone_close : R.string.phone_settings);
        handler.removeCallbacks(phoneRefresh);
        if (open) {
            refreshPhonePanel();
            handler.postDelayed(phoneRefresh, 2000);
        }
    }

    private void refreshPhonePanel() {
        String hint = LocalControlService.getNetworkHint();
        if (hint == null || hint.isEmpty()) hint = NetworkUtils.wifiSubnet(this);
        wifiStatus.setText(getString(R.string.phone_wifi,
                hint.isEmpty() ? getString(R.string.phone_wifi_none) : hint));

        String error = LocalControlService.getLastError();
        if (!LocalControlService.isRunning()) {
            serviceStatus.setText(R.string.phone_server_stopped);
        } else if (error != null && !error.isEmpty()) {
            serviceStatus.setText(R.string.phone_server_error);
        } else {
            serviceStatus.setText(R.string.phone_server_running);
        }

        boolean allowed = notificationsAllowed();
        notificationStatus.setText(allowed
                ? R.string.phone_notifications_allowed : R.string.phone_notifications_blocked);
        notificationAction.setText(allowed ? R.string.phone_open_settings : R.string.phone_enable);

        boolean exempt = batteryExempt();
        batteryStatus.setText(exempt ? R.string.phone_battery_exempt : R.string.phone_battery_optimized);
        batteryAction.setText(exempt ? R.string.phone_open_settings : R.string.phone_exempt);
    }

    /** The embedded server is the only origin allowed inside this WebView. */
    private static boolean isTrusted(Uri uri) {
        if (uri == null || !"http".equalsIgnoreCase(uri.getScheme())) return false;
        if (!"127.0.0.1".equalsIgnoreCase(uri.getHost()) && !"localhost".equalsIgnoreCase(uri.getHost())) return false;
        int port = uri.getPort();
        return port == 8000 || (port < 0 && "localhost".equalsIgnoreCase(uri.getHost()));
    }

    private boolean handleNavigation(String url) {
        if (isTrusted(Uri.parse(url))) {
            currentUrl = url;
            web.loadUrl(url);
            return true;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    /** Direct phone mode is opt-in; the default stays on loopback. */
    private boolean remoteEnabled() {
        return prefs.getBoolean(KEY_ENABLED, false);
    }

    private static String fieldText(EditText field) {
        return field.getText() == null ? "" : field.getText().toString().trim();
    }

    private void setPanelOpen(boolean open) {
        remotePanel.setVisibility(open ? View.VISIBLE : View.GONE);
        remoteSettings.setText(open ? R.string.remote_close : R.string.remote_settings);
    }

    private void togglePasswordVisibility() {
        boolean hidden = remotePass.getTransformationMethod() instanceof PasswordTransformationMethod;
        remotePass.setTransformationMethod(hidden
                ? HideReturnsTransformationMethod.getInstance()
                : PasswordTransformationMethod.getInstance());
        remotePass.setSelection(remotePass.getText().length());
        showPass.setText(hidden ? R.string.remote_hide : R.string.remote_show);
    }

    private void copyRemoteDetails() {
        String details = remoteUrl.getText().toString();
        if (remoteUrl.getVisibility() != View.VISIBLE || details.isEmpty()) {
            Toast.makeText(this, "Enable direct mode first", Toast.LENGTH_SHORT).show();
            return;
        }
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Smart Pilot Local", details));
        }
        Toast.makeText(this, R.string.remote_copied, Toast.LENGTH_SHORT).show();
    }

    /** Give WebView credentials before the first 401, otherwise it caches the failure. */
    private void applyWebViewAuth(String user, String password) {
        WebViewDatabase.getInstance(getApplicationContext()).clearHttpAuthUsernamePassword();
        web.clearCache(true);
        web.setHttpAuthUsernamePassword("127.0.0.1", "Smart Pilot Local", user, password);
    }

    private void updateRemoteUrl(String user, String password) {
        if (!remoteToggle.isChecked()) {
            remoteUrl.setVisibility(View.GONE);
            return;
        }
        if (user.isEmpty() || password.isEmpty()) {
            remoteUrl.setText("Set a username and password, then tap Apply.");
            remoteUrl.setVisibility(View.VISIBLE);
            return;
        }
        String tsIp = NetworkUtils.tailscaleIp();
        if (tsIp.isEmpty()) {
            remoteUrl.setText("Direct mode is on. Local Wi-Fi devices can open "
                    + "http://" + NetworkUtils.wifiSubnet(this).replace("/24", "")
                    + ":8000/local — login: " + user + " / " + password);
        } else {
            remoteUrl.setText("Open http://" + tsIp + ":8000/local on the tailnet. "
                    + "Login: " + user + " / " + password);
        }
        remoteUrl.setVisibility(View.VISIBLE);
    }

    /** Persist the toggle and let the service rebind without killing the process. */
    private void applyRemoteSettings() {
        String user = fieldText(remoteUser);
        String password = fieldText(remotePass);
        if (user.isEmpty()) user = "tuya";
        if (password.isEmpty()) {
            password = NetworkUtils.randomToken();
            remotePass.setText(password);
        }
        prefs.edit()
                .putBoolean(KEY_ENABLED, remoteToggle.isChecked())
                .putString(KEY_USER, user)
                .putString(KEY_PASSWORD, password)
                .commit();
        updateRemoteUrl(user, password);
        Toast.makeText(this, "Applying remote access…", Toast.LENGTH_SHORT).show();
        if (remoteToggle.isChecked()) applyWebViewAuth(user, password);
        setPanelOpen(false);
        startLocalService();
        attempts = 0;
        waitForServer();
    }

    private void waitForServer() {
        final int generation = ++serverProbeGeneration;
        handler.removeCallbacks(waitForServerCallback);
        new Thread(() -> {
            boolean ready = portOpen();
            handler.post(() -> {
                if (generation != serverProbeGeneration) return;
                if (ready) {
                    status.setText(remoteEnabled() ? R.string.ready_direct : R.string.ready);
                    if (remoteEnabled()) {
                        String user = fieldText(remoteUser);
                        String password = fieldText(remotePass);
                        applyWebViewAuth(user.isEmpty() ? "tuya" : user, password);
                    }
                    currentUrl = LOCAL_URL;
                    web.loadUrl(LOCAL_URL);
                } else if (++attempts > 200) {
                    String error = LocalControlService.getLastError();
                    status.setText(error == null || error.isEmpty()
                            ? R.string.phone_server_error : R.string.phone_server_error);
                } else {
                    handler.postDelayed(waitForServerCallback, 300);
                }
                refreshPhonePanel();
            });
        }, "tuya-probe").start();
    }

    /** 15-minute alarm keeps scene schedules ticking after the app is backgrounded. */
    private void scheduleAlarm() {
        try {
            Intent intent = new Intent(this, ScheduleReceiver.class);
            intent.setAction(ScheduleReceiver.TICK);
            PendingIntent pending = PendingIntent.getBroadcast(this, 1002, intent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            AlarmManager alarm = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (alarm != null) {
                long interval = 15 * 60 * 1000L;
                alarm.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        SystemClock.elapsedRealtime() + interval, interval, pending);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not schedule scene alarm", e);
        }
    }

    private static boolean portOpen() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 8000), 250);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Native update controls exposed only to the trusted local page. */
    public class PilotBridge {
        private boolean trusted() {
            return isTrusted(Uri.parse(currentUrl));
        }

        private void callback(java.util.function.Consumer<UpdateManager.Callback> action) {
            UpdateManager.Callback wrapped = result -> {
                String json = result == null ? "{}" : result.toString();
                handler.post(() -> web.evaluateJavascript(
                        "window.pilotUpdateResult && window.pilotUpdateResult(" +
                        JSONObject.quote(json) + ")", null));
            };
            action.accept(wrapped);
        }

        @JavascriptInterface
        public String updateState() {
            return trusted() ? UpdateManager.state(OfflineActivity.this) : "{\"platform\":\"android\"}";
        }

        @JavascriptInterface
        public void checkUpdate() {
            if (trusted()) callback(done -> UpdateManager.check(OfflineActivity.this, done));
        }

        @JavascriptInterface
        public void installUpdate() {
            if (trusted()) callback(done -> UpdateManager.install(OfflineActivity.this, done));
        }

        @JavascriptInterface
        public void rollback() {
            if (trusted()) callback(done -> UpdateManager.rollback(OfflineActivity.this, done));
        }

        @JavascriptInterface
        public void openInstallPermission() {
            if (trusted()) UpdateManager.openInstallPermission(OfflineActivity.this);
        }

        /** Family hub setup: reveal the existing opt-in Direct mode panel. */
        @JavascriptInterface
        public void openDirectSettings() {
            if (trusted()) runOnUiThread(() -> setPanelOpen(true));
        }

        /** Save a generated file to Downloads. WebView cannot save blob: URLs. */
        @JavascriptInterface
        public void saveDownload(String name, String base64, String mime) {
            if (!trusted()) {
                Log.w(TAG, "Blocked download save from untrusted origin");
                return;
            }
            try {
                String data = base64 == null ? "" : base64;
                int comma = data.indexOf(',');
                if (comma >= 0) data = data.substring(comma + 1);
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                if (bytes.length == 0) throw new IllegalStateException("empty download");

                String safe = (name == null || !name.matches("[A-Za-z0-9._-]+"))
                        ? "smart-pilot-download.bin" : name;
                final String fileName = safe;
                String type = (mime == null || mime.isEmpty())
                        ? "application/octet-stream" : mime;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, type);
                    values.put(MediaStore.Downloads.RELATIVE_PATH,
                            Environment.DIRECTORY_DOWNLOADS + "/SmartPilot");
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = getContentResolver().insert(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IllegalStateException("Downloads insert failed");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(uri, values, null, null);
                } else {
                    java.io.File dir = new java.io.File(
                            Environment.getExternalStoragePublicDirectory(
                                    Environment.DIRECTORY_DOWNLOADS), "SmartPilot");
                    if (!dir.exists() && !dir.mkdirs()) {
                        throw new IllegalStateException("could not create Downloads/SmartPilot");
                    }
                    try (java.io.FileOutputStream out =
                                 new java.io.FileOutputStream(new java.io.File(dir, fileName))) {
                        out.write(bytes);
                    }
                }

                final long size = bytes.length;
                handler.post(() -> Toast.makeText(OfflineActivity.this,
                        "Saved to Downloads/SmartPilot/" + fileName + " (" + size + " bytes)",
                        Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e(TAG, "Could not save download", e);
                handler.post(() -> Toast.makeText(OfflineActivity.this,
                        "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }

    /** JavaScript bridge used by the QR screen to save the PNG to Gallery. */
    public class QrSaver {
        @JavascriptInterface
        public void saveQr(String dataUrl) {
            if (!isTrusted(Uri.parse(currentUrl))) {
                Log.w(TAG, "Blocked QR save from untrusted origin");
                return;
            }
            try {
                String base64 = dataUrl == null ? "" : dataUrl;
                int comma = base64.indexOf(',');
                if (comma >= 0) base64 = base64.substring(comma + 1);
                byte[] png = Base64.decode(base64, Base64.DEFAULT);

                String name = "tuya-login-qr-" + System.currentTimeMillis() + ".png";
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.put(MediaStore.Images.Media.RELATIVE_PATH,
                            Environment.DIRECTORY_PICTURES + "/TuyaLocalKey");
                    values.put(MediaStore.Images.Media.IS_PENDING, 1);
                }
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("Gallery insert failed");
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    out.write(png);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.clear();
                    values.put(MediaStore.Images.Media.IS_PENDING, 0);
                    getContentResolver().update(uri, values, null, null);
                }
                handler.post(() -> Toast.makeText(OfflineActivity.this,
                        "QR saved to Gallery. Smart Life → Scan → Gallery se choose karein.",
                        Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                Log.e(TAG, "Could not save QR image", e);
                handler.post(() -> Toast.makeText(OfflineActivity.this,
                        "QR save nahi hua: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }

    private boolean backCheckPending;

    @Override
    public void onBackPressed() {
        if (backCheckPending) return;
        String url = web.getUrl();
        if (url == null || !isTrusted(Uri.parse(url))) {
            navigateBack();
            return;
        }
        backCheckPending = true;
        web.evaluateJavascript(
                "typeof window.smartPilotDismissOverlay === 'function' && window.smartPilotDismissOverlay()",
                dismissed -> {
                    backCheckPending = false;
                    if (!isFinishing() && !isDestroyed() && url.equals(web.getUrl())
                            && !"true".equals(dismissed)) navigateBack();
                });
    }

    private void navigateBack() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
