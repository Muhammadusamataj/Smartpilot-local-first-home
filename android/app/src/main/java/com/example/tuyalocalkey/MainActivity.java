package com.example.tuyalocalkey;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.text.InputType;
import android.webkit.DownloadListener;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

/** Thin client for a Tuya Local Key server running on a PC / HA box / cloud host. */
public class MainActivity extends Activity {
    private static final String PREFS = "tuya_local_key";
    private static final String URL_KEY = "server_url";
    // 10.0.2.2 is the host machine when running in the Android emulator.
    private static final String DEFAULT_URL = "http://10.0.2.2:8000/local";

    private WebView web;
    private EditText urlField;
    private SharedPreferences prefs;
    private String trustedScheme = "http";
    private String trustedHost = "";
    private int trustedPort = 80;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        web = findViewById(R.id.webview);
        urlField = findViewById(R.id.serverUrl);
        urlField.setText(prefs.getString(URL_KEY, DEFAULT_URL));

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
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

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
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                LinearLayout layout = new LinearLayout(MainActivity.this);
                layout.setOrientation(LinearLayout.VERTICAL);
                layout.setPadding(48, 24, 48, 8);
                EditText user = new EditText(MainActivity.this);
                user.setHint("Username");
                user.setSingleLine(true);
                EditText pass = new EditText(MainActivity.this);
                pass.setHint("Password");
                pass.setSingleLine(true);
                pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                layout.addView(user);
                layout.addView(pass);
                new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Server login")
                    .setView(layout)
                    .setPositiveButton("Sign in", (d, w) -> handler.proceed(user.getText().toString(), pass.getText().toString()))
                    .setNegativeButton("Cancel", (d, w) -> handler.cancel())
                    .setOnCancelListener(d -> handler.cancel())
                    .show();
            }
        });

        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition,
                                        String mimeType, long contentLength) {
                if (url != null && (url.startsWith("blob:") || url.startsWith("data:"))) {
                    Toast.makeText(MainActivity.this, "Use a browser or the offline APK to export files.", Toast.LENGTH_LONG).show();
                    return;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "No app can open this download", Toast.LENGTH_SHORT).show();
                }
            }
        });

        Button open = findViewById(R.id.open);
        open.setOnClickListener(v -> loadFromField());
        urlField.setOnKeyListener((v, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_UP) {
                loadFromField();
                return true;
            }
            return false;
        });

        loadFromField();
    }

    /** Only the configured server origin may navigate inside this WebView. */
    private boolean isTrusted(Uri uri) {
        if (uri == null || uri.getHost() == null) return false;
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
        if (!scheme.equalsIgnoreCase(trustedScheme) || !uri.getHost().equalsIgnoreCase(trustedHost)) return false;
        int port = uri.getPort();
        if (port < 0) port = "https".equalsIgnoreCase(scheme) ? 443 : 80;
        return port == trustedPort;
    }

    private boolean handleNavigation(String url) {
        Uri uri = Uri.parse(url);
        if (uri != null && isTrusted(uri)) {
            return false;
        }
        // External links open in the user's browser, never in the app WebView.
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void loadFromField() {
        String value = urlField.getText().toString().trim();
        if (value.isEmpty()) value = DEFAULT_URL;
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        // Do not append a slash: /local/ is a different URL base and breaks the
        // page's relative API calls. Keep exactly what the user configured.
        Uri uri = Uri.parse(value);
        if (uri == null || uri.getHost() == null) {
            Toast.makeText(this, "Enter a valid server address", Toast.LENGTH_SHORT).show();
            return;
        }
        trustedScheme = uri.getScheme();
        trustedHost = uri.getHost();
        trustedPort = uri.getPort();
        if (trustedPort < 0) trustedPort = "https".equalsIgnoreCase(trustedScheme) ? 443 : 80;
        urlField.setText(value);
        prefs.edit().putString(URL_KEY, value).apply();
        web.loadUrl(value);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
            "(function(){return !!(window.smartPilotDismissOverlay && window.smartPilotDismissOverlay());})()",
            value -> {
                if ("true".equals(value)) return;
                if (web.canGoBack()) {
                    web.goBack();
                } else {
                    MainActivity.super.onBackPressed();
                }
            }
        );
    }
}
