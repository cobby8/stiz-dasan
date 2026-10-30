package kr.stiz.driver;

import java.net.URI;
import java.util.LinkedHashSet;
import java.util.Locale;

/** File selection has no GPS capability. Only explicitly selected, bounded content is delivered. */
final class FileSelectionPolicy {
    private static final java.util.concurrent.atomic.AtomicInteger REQUEST_SEQUENCE = new java.util.concurrent.atomic.AtomicInteger(21000);
    static final int MAX_FILES = 10;
    static final long MAX_FILE_BYTES = 25L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 100L * 1024 * 1024;
    private FileSelectionPolicy() { }

    // Process-wide allocation prevents a late result from a rotated Activity matching a new chooser.
    static int nextRequestCode() {
        int code = REQUEST_SEQUENCE.incrementAndGet();
        return code <= 30000 ? code : -1;
    }

    static String[] acceptedTypes(String[] values) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        boolean explicit = false;
        if (values != null) for (String value : values) {
            if (value == null) continue;
            for (String part : value.split(",")) {
                String type = part.trim().toLowerCase(Locale.ROOT);
                if (!type.isEmpty()) explicit = true;
                if (type.startsWith(".")) type = typeForName("file" + type);
                if (type.matches("[a-z0-9!#$&^_.+-]+/(?:[a-z0-9!#$&^_.+-]+|\\*)") || type.equals("*/*")) result.add(type);
            }
        }
        if (result.isEmpty()) result.add(explicit ? "application/x-stiz-unsupported" : "*/*");
        return result.toArray(new String[0]);
    }

    static boolean imagesOnly(String[] accepted) {
        for (String type : accepted) if (!type.startsWith("image/")) return false;
        return accepted.length > 0;
    }

    static boolean accepts(String[] accepted, String mime, String name) {
        String supplied = mime == null ? "" : mime.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
        String byName = typeForName(name);
        // Generic document providers sometimes report octet-stream. The explicit filename remains usable.
        String actual = supplied.isEmpty() || supplied.equals("application/octet-stream") ? byName : supplied;
        if (supplied.equals("text/plain") && (byName.equals("application/json") || byName.equals("text/csv"))) actual = byName;
        if (byName.equals("text/csv") && (supplied.equals("application/vnd.ms-excel") || supplied.equals("text/comma-separated-values"))) actual = byName;
        if (!byName.isEmpty() && !actual.isEmpty() && !equivalent(actual, byName)) return false;
        for (String type : accepted) {
            if (type.equals("*/*")) return true;
            if (equivalent(type, actual)) return true;
            if (type.endsWith("/*") && actual.startsWith(type.substring(0, type.length() - 1))) return true;
        }
        return false;
    }

    static String effectiveImageType(String mime, String name) {
        String supplied = mime == null ? "" : mime.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
        return supplied.isEmpty() || supplied.equals("application/octet-stream") ? typeForName(name) : supplied;
    }

    static boolean equivalent(String left, String right) {
        if (left.equals(right)) return true;
        return (left.equals("text/csv") && right.equals("application/csv"))
            || (right.equals("text/csv") && left.equals("application/csv"));
    }

    static String typeForName(String name) {
        if (name == null) return "";
        String lower = name.toLowerCase(Locale.ROOT);
        int dot = lower.lastIndexOf('.');
        if (dot < 0) return "";
        switch (lower.substring(dot + 1)) {
            case "jpg": case "jpeg": return "image/jpeg";
            case "png": return "image/png";
            case "webp": return "image/webp";
            case "gif": return "image/gif";
            case "heic": return "image/heic";
            case "heif": return "image/heif";
            case "avif": return "image/avif";
            case "json": return "application/json";
            case "csv": return "text/csv";
            case "txt": return "text/plain";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "pdf": return "application/pdf";
            default: return "";
        }
    }

    static boolean externalContent(String value, String ownAuthority) {
        try {
            URI uri = new URI(value);
            return "content".equals(uri.getScheme()) && uri.getRawAuthority() != null
                && uri.getRawUserInfo() == null && uri.getPort() == -1 && uri.getFragment() == null
                && !uri.getRawAuthority().equalsIgnoreCase(ownAuthority)
                && !uri.getRawAuthority().contains("@") && !uri.getRawAuthority().contains(":")
                && !uri.getRawAuthority().contains("%");
        } catch (Exception failure) { return false; }
    }

    static boolean bounded(int count, boolean multiple, long bytes, long total) {
        return count > 0 && count <= (multiple ? MAX_FILES : 1)
            && bytes > 0 && bytes <= MAX_FILE_BYTES && total >= bytes && total <= MAX_TOTAL_BYTES;
    }
}
