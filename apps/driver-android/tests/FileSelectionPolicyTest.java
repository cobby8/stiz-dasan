package kr.stiz.driver;

import java.util.Arrays;

/** Plain JVM checks: no file, student data, device, permission or network access. */
public final class FileSelectionPolicyTest {
    private static int checks;
    private static void check(boolean value) { checks++; if (!value) throw new AssertionError("File selection check " + checks); }
    public static void main(String[] args) {
        int firstRequest = FileSelectionPolicy.nextRequestCode();
        int afterRecreationRequest = FileSelectionPolicy.nextRequestCode();
        check(firstRequest >= 21001 && firstRequest <= 30000);
        check(afterRecreationRequest > firstRequest);
        String[] images = FileSelectionPolicy.acceptedTypes(new String[]{"image/jpeg,image/png", "image/webp"});
        check(Arrays.equals(images, new String[]{"image/jpeg", "image/png", "image/webp"}));
        check(FileSelectionPolicy.imagesOnly(images));
        check(!FileSelectionPolicy.imagesOnly(new String[]{"*/*"}));
        check(FileSelectionPolicy.accepts(images, "image/jpeg", "photo.JPG"));
        check(FileSelectionPolicy.accepts(images, "application/octet-stream", "photo.jpg"));
        check(!FileSelectionPolicy.accepts(images, "image/png", "wrong.jpg"));
        check(!FileSelectionPolicy.accepts(images, "text/html", "photo.jpg"));
        check(!FileSelectionPolicy.accepts(images, "image/heic", "photo.heic"));
        check(!FileSelectionPolicy.accepts(images, "image/svg+xml", "picture.svg"));
        check(FileSelectionPolicy.accepts(new String[]{"image/*"}, "image/heic", "photo.heic"));
        check(FileSelectionPolicy.accepts(new String[]{"image/*"}, "image/png", "photo"));
        check(!FileSelectionPolicy.accepts(images, null, "photo"));
        check(Arrays.equals(FileSelectionPolicy.acceptedTypes(new String[]{".JSON,.csv,.xlsx,.xls,.txt"}),
            new String[]{"application/json", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "text/plain"}));
        check(FileSelectionPolicy.accepts(new String[]{"text/csv"}, "text/plain", "roster.csv"));
        check(FileSelectionPolicy.accepts(new String[]{"text/csv"}, "application/vnd.ms-excel", "roster.csv"));
        check(FileSelectionPolicy.accepts(new String[]{"text/csv"}, "text/comma-separated-values", "roster.csv"));
        check(!FileSelectionPolicy.accepts(new String[]{"text/csv"}, "application/vnd.ms-excel", "roster.xls"));
        check(FileSelectionPolicy.accepts(new String[]{"application/json"}, "text/plain", "schedule.json"));
        check(FileSelectionPolicy.accepts(new String[]{"application/json"}, null, "schedule.json"));
        check(!FileSelectionPolicy.accepts(new String[]{"application/json"}, "text/plain", "schedule.txt"));
        check(FileSelectionPolicy.accepts(new String[]{"application/vnd.ms-excel"}, "application/vnd.ms-excel", "roster.xls"));
        check(FileSelectionPolicy.accepts(new String[]{"*/*"}, "application/pdf", "document.pdf"));
        check(FileSelectionPolicy.acceptedTypes(null)[0].equals("*/*"));
        check(FileSelectionPolicy.acceptedTypes(new String[]{"image/png", "IMAGE/PNG"}).length == 1);
        check(FileSelectionPolicy.acceptedTypes(new String[]{".foo"})[0].equals("application/x-stiz-unsupported"));
        check(!FileSelectionPolicy.accepts(FileSelectionPolicy.acceptedTypes(new String[]{".foo"}), "image/jpeg", "photo.jpg"));
        check(FileSelectionPolicy.acceptedTypes(new String[]{""})[0].equals("*/*"));
        check(FileSelectionPolicy.effectiveImageType("application/octet-stream", "photo.JPG").equals("image/jpeg"));
        check(FileSelectionPolicy.effectiveImageType(null, "photo.png").equals("image/png"));
        check(FileSelectionPolicy.effectiveImageType("image/png", "photo.jpg").equals("image/png"));
        String own = "kr.stiz.driver.unified.attachments";
        check(FileSelectionPolicy.externalContent("content://com.android.providers.media.documents/document/image%3A12", own));
        check(FileSelectionPolicy.externalContent("content://com.android.providers.downloads.documents/document/12", own));
        for (String value : new String[]{"file:///data/user/0/private", "https://evil.invalid/file", "http://evil.invalid/file", "content://" + own + "/selected_attachments/x", "content://user@provider/path", "content://provider:44/path", "content://provider/path#fragment", "content://%61uthority/path", "javascript:alert(1)", "not a URI", "content:///path"}) {
            check(!FileSelectionPolicy.externalContent(value, own));
        }
        check(FileSelectionPolicy.bounded(1, false, 1, 1));
        check(FileSelectionPolicy.bounded(10, true, FileSelectionPolicy.MAX_FILE_BYTES, FileSelectionPolicy.MAX_TOTAL_BYTES));
        check(!FileSelectionPolicy.bounded(2, false, 1, 1));
        check(!FileSelectionPolicy.bounded(11, true, 1, 1));
        check(!FileSelectionPolicy.bounded(0, true, 1, 1));
        check(!FileSelectionPolicy.bounded(1, true, 0, 0));
        check(!FileSelectionPolicy.bounded(1, true, -1, 1));
        check(!FileSelectionPolicy.bounded(1, true, FileSelectionPolicy.MAX_FILE_BYTES + 1, FileSelectionPolicy.MAX_FILE_BYTES + 1));
        check(!FileSelectionPolicy.bounded(4, true, 20, FileSelectionPolicy.MAX_TOTAL_BYTES + 1));
        check(!FileSelectionPolicy.bounded(1, true, 30, 20));
        System.out.println("File selection policy: " + checks + " checks passed");
    }
}
