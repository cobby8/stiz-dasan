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
        // 수업 영상(2026-11-14): mp4·mov·webm 촬영·선택 허용, 영상은 파일 한 개 상한이 더 크다
        String[] videoAny = FileSelectionPolicy.acceptedTypes(new String[]{"video/*"});
        check(FileSelectionPolicy.videosOnly(videoAny));
        check(!FileSelectionPolicy.imagesOnly(videoAny));
        check(!FileSelectionPolicy.videosOnly(images));
        check(!FileSelectionPolicy.videosOnly(new String[]{"*/*"}));
        check(FileSelectionPolicy.accepts(videoAny, "video/mp4", "capture.mp4"));
        check(FileSelectionPolicy.accepts(videoAny, "video/quicktime", "IMG_0001.MOV"));
        String[] videos = FileSelectionPolicy.acceptedTypes(new String[]{"video/mp4,video/quicktime,video/webm"});
        check(FileSelectionPolicy.videosOnly(videos));
        check(FileSelectionPolicy.accepts(videos, "video/mp4", "clip.mp4"));
        check(FileSelectionPolicy.accepts(videos, "video/webm", "clip.webm"));
        check(FileSelectionPolicy.accepts(videos, "application/octet-stream", "clip.mov"));
        check(FileSelectionPolicy.accepts(videos, null, "clip.m4v"));
        check(!FileSelectionPolicy.accepts(videos, "video/3gpp", "clip.3gp"));
        check(!FileSelectionPolicy.accepts(videos, "video/mp4", "clip.mov"));
        check(!FileSelectionPolicy.accepts(videos, "image/jpeg", "photo.jpg"));
        check(!FileSelectionPolicy.accepts(images, "video/mp4", "clip.mp4"));
        check(FileSelectionPolicy.typeForName("A.MOV").equals("video/quicktime"));
        check(FileSelectionPolicy.maxFileBytes("video/mp4", "clip.mp4") == FileSelectionPolicy.MAX_VIDEO_BYTES);
        check(FileSelectionPolicy.maxFileBytes("application/octet-stream", "clip.webm") == FileSelectionPolicy.MAX_VIDEO_BYTES);
        check(FileSelectionPolicy.maxFileBytes("image/jpeg", "photo.jpg") == FileSelectionPolicy.MAX_FILE_BYTES);
        check(FileSelectionPolicy.maxFileBytes("text/csv", "roster.csv") == FileSelectionPolicy.MAX_FILE_BYTES);
        check(FileSelectionPolicy.MAX_VIDEO_BYTES > FileSelectionPolicy.MAX_FILE_BYTES);
        check(FileSelectionPolicy.VIDEO_CAPTURE_SIZE_LIMIT <= FileSelectionPolicy.MAX_VIDEO_BYTES);
        check(FileSelectionPolicy.bounded(1, false, 40L * 1024 * 1024, 40L * 1024 * 1024, FileSelectionPolicy.MAX_VIDEO_BYTES));
        check(!FileSelectionPolicy.bounded(1, false, 40L * 1024 * 1024, 40L * 1024 * 1024));
        check(!FileSelectionPolicy.bounded(1, false, FileSelectionPolicy.MAX_VIDEO_BYTES + 1, FileSelectionPolicy.MAX_VIDEO_BYTES + 1, FileSelectionPolicy.MAX_VIDEO_BYTES));
        System.out.println("File selection policy: " + checks + " checks passed");
    }
}
