package kr.stiz.driver;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.FileNotFoundException;

/** Test APK only, read-only, static bytes; no filesystem path is accepted or read. */
public final class SyntheticAttachmentProvider extends ContentProvider {
    private static final byte[] PNG = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==", android.util.Base64.DEFAULT);
    @Override public boolean onCreate() { return true; }
    private String key(Uri uri) {
        String path = uri.getPath();
        if (!"kr.stiz.driver.test.synthetic".equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null
            || !("/one".equals(path) || "/two".equals(path) || "/json".equals(path) || "/badimage".equals(path) || "/oversize".equals(path))) throw new IllegalArgumentException("Unknown synthetic fixture");
        return path.substring(1);
    }
    private byte[] bytes(Uri uri) { return "json".equals(key(uri)) ? "{\"fixture\":true}".getBytes(java.nio.charset.StandardCharsets.UTF_8) : "badimage".equals(key(uri)) ? new byte[]{1,2,3} : PNG; }
    @Override public String getType(Uri uri) { return "json".equals(key(uri)) ? "application/json" : "image/png"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        String id = key(uri);
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{id + (id.equals("json") ? ".json" : ".png"), id.equals("oversize") ? 26L * 1024 * 1024 : bytes(uri).length});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read-only fixture");
        byte[] content = bytes(uri);
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            new Thread(() -> { try (java.io.OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) { out.write(content); } catch (java.io.IOException ignored) { } }, "synthetic-attachment").start();
            return pipe[0];
        } catch (java.io.IOException failure) { throw new FileNotFoundException("Fixture pipe unavailable"); }
    }
    @Override public Uri insert(Uri uri, ContentValues value) { throw new UnsupportedOperationException("Read-only fixture"); }
    @Override public int update(Uri uri, ContentValues value, String where, String[] args) { throw new UnsupportedOperationException("Read-only fixture"); }
    @Override public int delete(Uri uri, String where, String[] args) { throw new UnsupportedOperationException("Read-only fixture"); }
}
