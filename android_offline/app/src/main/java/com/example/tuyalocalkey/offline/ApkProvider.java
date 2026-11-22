package com.example.tuyalocalkey.offline;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/** Serves only APKs inside the app-private updates folder to the installer. */
public class ApkProvider extends ContentProvider {
    public static final String FOLDER = "updates";

    public static String authority(Context context) {
        return context.getPackageName() + ".apkprovider";
    }

    public static Uri uriFor(Context context, String fileName) {
        return new Uri.Builder().scheme("content").authority(authority(context))
                .appendPath(fileName).build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] args, String sortOrder) {
        return null;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || !name.endsWith(".apk") || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("Invalid APK name");
        }
        File file = new File(new File(getContext().getFilesDir(), FOLDER), name);
        if (!file.isFile()) throw new FileNotFoundException(name);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }
}
