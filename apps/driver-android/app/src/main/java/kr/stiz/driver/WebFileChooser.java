package kr.stiz.driver;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** System chooser only: never enables WebView local-file access or broad photo permissions. */
final class WebFileChooser {
    private final Activity activity;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService copier = Executors.newSingleThreadExecutor();
    private final String authority;
    private Request pending;
    private boolean destroyed;
    private static final long RETENTION_MS = 24L * 60 * 60 * 1000;

    private static final class Request {
        final int code;
        final String page;
        final String[] accepted;
        final boolean multiple;
        ValueCallback<Uri[]> callback;
        File camera;
        Uri cameraUri;
        boolean delivered;
        boolean processing;
        Request(int code, String page, String[] accepted, boolean multiple, ValueCallback<Uri[]> callback) {
            this.code = code; this.page = page; this.accepted = accepted; this.multiple = multiple; this.callback = callback;
        }
    }

    WebFileChooser(Activity activity, WebView web) {
        this.activity = activity; this.web = web; authority = activity.getPackageName() + ".attachments";
        copier.execute(this::pruneOldFiles);
    }

    boolean open(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        cancel();
        String page = web.getUrl();
        boolean supportedMode = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN
            || params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        if (destroyed || page == null || !MainActivity.trustedAppPage(Uri.parse(page)) || !supportedMode) {
            callback.onReceiveValue(null); return true;
        }
        int requestCode = FileSelectionPolicy.nextRequestCode();
        if (requestCode < 0) { callback.onReceiveValue(null); return true; }
        String[] accepted = FileSelectionPolicy.acceptedTypes(params.getAcceptTypes());
        Request request = new Request(requestCode, page, accepted,
            params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE, callback);
        pending = request;
        try {
            if (params.isCaptureEnabled() && FileSelectionPolicy.imagesOnly(accepted)
                && FileSelectionPolicy.accepts(accepted, "image/jpeg", "capture.jpg")) {
                request.camera = File.createTempFile("capture-", ".jpg", directory());
                request.cameraUri = FileProvider.getUriForFile(activity, authority, request.camera);
                Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                camera.putExtra(MediaStore.EXTRA_OUTPUT, request.cameraUri);
                camera.setClipData(ClipData.newRawUri("사진 촬영", request.cameraUri));
                camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                activity.startActivityForResult(camera, request.code);
            } else {
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType(accepted.length == 1 ? accepted[0] : "*/*");
                if (accepted.length > 1) picker.putExtra(Intent.EXTRA_MIME_TYPES, accepted);
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, request.multiple);
                picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivityForResult(picker, request.code);
            }
        } catch (RuntimeException | java.io.IOException failure) {
            finish(request, null);
            android.widget.Toast.makeText(activity, "파일 선택 또는 카메라 앱을 열지 못했습니다. 다시 시도해 주세요.", android.widget.Toast.LENGTH_LONG).show();
        }
        return true;
    }

    boolean result(int code, int resultCode, Intent data) {
        if (code < 21001 || code > 30000) return false;
        Request request = pending;
        if (request == null || request.code != code || request.delivered || request.processing) return true;
        if (resultCode != Activity.RESULT_OK || !samePage(request)) { finish(request, null); return true; }
        ArrayList<Uri> selected = new ArrayList<>();
        if (request.cameraUri != null) selected.add(request.cameraUri);
        else if (data != null) {
            LinkedHashSet<Uri> unique = new LinkedHashSet<>();
            if (data.getData() != null) unique.add(data.getData());
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > FileSelectionPolicy.MAX_FILES) { finish(request, null); return true; }
            if (clip != null) for (int index = 0; index < clip.getItemCount() && index <= FileSelectionPolicy.MAX_FILES; index++) {
                Uri uri = clip.getItemAt(index).getUri();
                if (uri != null) unique.add(uri);
            }
            selected.addAll(unique);
        }
        if (selected.isEmpty() || selected.size() > (request.multiple ? FileSelectionPolicy.MAX_FILES : 1)) { finish(request, null); return true; }
        request.processing = true;
        copier.execute(() -> copySelected(request, selected));
        return true;
    }

    void navigation(String url) { if (pending != null && !pending.page.equals(url)) cancel(); }
    void documentStarted() { cancel(); }
    void cancel() { if (pending != null) finish(pending, null); }
    void destroy() { destroyed = true; cancel(); copier.shutdownNow(); }

    private boolean samePage(Request request) {
        return !destroyed && !activity.isFinishing() && !activity.isDestroyed() && pending == request
            && !request.delivered && request.page.equals(web.getUrl()) && MainActivity.trustedAppPage(Uri.parse(request.page));
    }

    private File directory() throws java.io.IOException {
        File dir = new File(activity.getCacheDir(), "web-attachments");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Attachment cache unavailable");
        return dir;
    }

    private void copySelected(Request request, ArrayList<Uri> selected) {
        ArrayList<File> copies = new ArrayList<>();
        ArrayList<Uri> result = new ArrayList<>();
        long total = 0;
        try {
            for (Uri uri : selected) {
                if (Thread.currentThread().isInterrupted()) throw new java.io.IOException("Cancelled");
                boolean camera = request.cameraUri != null && request.cameraUri.equals(uri);
                if (!camera && !FileSelectionPolicy.externalContent(uri.toString(), authority)) throw new java.io.IOException("Unsupported selection");
                String name = camera ? "capture.jpg" : "";
                long declared = -1;
                if (!camera) try (Cursor cursor = activity.getContentResolver().query(uri,
                    new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (nameIndex >= 0) name = cursor.getString(nameIndex);
                        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) declared = cursor.getLong(sizeIndex);
                    }
                }
                String mime = camera ? "image/jpeg" : activity.getContentResolver().getType(uri);
                if (mime != null) mime = mime.toLowerCase(java.util.Locale.ROOT).split(";", 2)[0].trim();
                if (!FileSelectionPolicy.accepts(request.accepted, mime, name) || declared > FileSelectionPolicy.MAX_FILE_BYTES) throw new java.io.IOException("Unsupported file");
                String extension = safeExtension(name);
                if (extension.isEmpty() && mime != null) {
                    String inferred = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
                    extension = inferred != null && inferred.matches("[A-Za-z0-9]{1,8}") ? "." + inferred : "";
                }
                File copy = new File(directory(), UUID.randomUUID() + extension);
                copies.add(copy);
                long bytes = 0;
                try (InputStream input = camera ? new FileInputStream(request.camera) : activity.getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(copy)) {
                    if (input == null) throw new java.io.IOException("Selection unreadable");
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (Thread.currentThread().isInterrupted()) throw new java.io.IOException("Cancelled");
                        bytes += count;
                        if (bytes > FileSelectionPolicy.MAX_FILE_BYTES || total + bytes > FileSelectionPolicy.MAX_TOTAL_BYTES) throw new java.io.IOException("File too large");
                        output.write(buffer, 0, count);
                    }
                }
                total += bytes;
                if (!FileSelectionPolicy.bounded(selected.size(), request.multiple, bytes, total)) throw new java.io.IOException("File limit exceeded");
                if ((mime != null && mime.startsWith("image/")) || FileSelectionPolicy.typeForName(name).startsWith("image/")) verifyImage(copy, mime, name);
                result.add(FileProvider.getUriForFile(activity, authority, copy));
            }
            main.post(() -> {
                if (samePage(request)) finish(request, result.toArray(new Uri[0]));
                else { for (File copy : copies) copy.delete(); finish(request, null); }
            });
        } catch (Exception failure) {
            for (File copy : copies) copy.delete();
            main.post(() -> {
                boolean active = samePage(request);
                finish(request, null);
                if (active) android.widget.Toast.makeText(activity, "파일을 확인하지 못했습니다. 형식·크기를 확인하고 다시 선택해 주세요.", android.widget.Toast.LENGTH_LONG).show();
            });
        }
    }

    private static String safeExtension(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        String extension = dot < 0 ? "" : name.substring(dot).toLowerCase(java.util.Locale.ROOT);
        return extension.matches("\\.[a-z0-9]{1,8}") ? extension : "";
    }

    private static void verifyImage(File file, String mime, String name) throws java.io.IOException {
        android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        android.graphics.BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || !FileSelectionPolicy.accepts(new String[]{FileSelectionPolicy.effectiveImageType(mime, name)}, bounds.outMimeType, name)) {
            throw new java.io.IOException("Invalid image content");
        }
    }

    private void finish(Request request, Uri[] result) {
        if (request.delivered) return;
        request.delivered = true;
        if (pending == request) pending = null;
        if (request.cameraUri != null) activity.revokeUriPermission(request.cameraUri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (request.camera != null) request.camera.delete();
        ValueCallback<Uri[]> callback = request.callback;
        request.callback = null;
        if (callback != null) callback.onReceiveValue(result);
        // Successful copies stay available while WebView reads them; only old cache files are pruned later.
    }

    private void pruneOldFiles() {
        File dir = new File(activity.getCacheDir(), "web-attachments");
        File[] files = dir.listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - RETENTION_MS;
        for (File file : files) if (file.isFile() && file.lastModified() < cutoff) file.delete();
    }
}
