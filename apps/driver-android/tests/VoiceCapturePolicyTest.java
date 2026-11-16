package kr.stiz.driver;

/** 음성 입력(마이크) 허용 판정 — 안드로이드 없이 순수 자바로 돌린다(2026-11-16, 1.0.4). */
public final class VoiceCapturePolicyTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError("check " + (checks + 1)); checks++; }
    public static void main(String[] args) {
        String origin = "https://www.stiz-dasan.kr";
        String page = origin + "/staff/session/abc?tab=memo";
        String[] audio = {VoiceCapturePolicy.AUDIO_CAPTURE};
        String video = "android.webkit.resource.VIDEO_CAPTURE";

        // 웹과 맞춘 표식·자원 이름(안드로이드 PermissionRequest.RESOURCE_AUDIO_CAPTURE 와 같은 글자)
        check(VoiceCapturePolicy.USER_AGENT_MARK.equals(" STIZVoice/1"));
        check(VoiceCapturePolicy.AUDIO_CAPTURE.equals("android.webkit.resource.AUDIO_CAPTURE"));

        // 통합 앱(운영·개발)에서만 켠다. 격리 시험 앱·기사님 전용 앱은 끈다
        check(VoiceCapturePolicy.enabled(true, false));
        check(!VoiceCapturePolicy.enabled(true, true));
        check(!VoiceCapturePolicy.enabled(false, false));
        check(!VoiceCapturePolicy.enabled(false, true));

        // 허용: 우리 사이트 화면에서, 우리 사이트가, 마이크 하나만 요청
        check(VoiceCapturePolicy.allowed(origin, origin + "/", page, audio, true, false));
        check(VoiceCapturePolicy.allowed(origin, origin, page, audio, true, false));
        check(VoiceCapturePolicy.allowed(origin, origin + ":443/", origin + "/mypage", audio, true, false));

        // 거부: 요청한 자원이 마이크 하나가 아닐 때
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{video}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{VoiceCapturePolicy.AUDIO_CAPTURE, video}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{video, VoiceCapturePolicy.AUDIO_CAPTURE}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{VoiceCapturePolicy.AUDIO_CAPTURE, VoiceCapturePolicy.AUDIO_CAPTURE}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{"android.webkit.resource.PROTECTED_MEDIA_ID"}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{"android.webkit.resource.MIDI_SYSEX"}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{"ANDROID.WEBKIT.RESOURCE.AUDIO_CAPTURE"}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[]{null}, true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, new String[0], true, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, null, true, false));

        // 거부: 요청한 쪽(출처)이 우리 사이트가 아닐 때 — 결제창·광고 같은 안쪽 화면(iframe) 포함
        for (String requester : new String[]{"https://evil.invalid/", "https://www.stiz-dasan.kr.evil.invalid/", "http://www.stiz-dasan.kr/",
            "https://www.stiz-dasan.kr:444/", "https://user@www.stiz-dasan.kr/", "https://stiz-dasan.kr/", "https://api.tosspayments.com/",
            "https://www.stiz-dasan.kr/mypage", "https://www.stiz-dasan.kr/?x=1", "https://www.stiz-dasan.kr/#x", "file:///", "about:blank", "null", "", null}) {
            check(!VoiceCapturePolicy.allowed(origin, requester, page, audio, true, false));
        }

        // 거부: 지금 보이는 화면이 우리 사이트가 아닐 때(결제·본인인증 중 등)
        for (String shown : new String[]{"https://pay.toss.im/checkout", "https://evil.invalid/staff", "http://www.stiz-dasan.kr/staff",
            "https://www.stiz-dasan.kr//evil", "https://www.stiz-dasan.kr/a/../b", "about:blank", "data:text/html,x", "", null}) {
            check(!VoiceCapturePolicy.allowed(origin, origin + "/", shown, audio, true, false));
        }

        // 거부: 기능을 끈 빌드(격리 시험 앱·기사님 전용 앱)
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, audio, true, true));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", origin + "/driver/token", audio, false, false));
        check(!VoiceCapturePolicy.allowed(origin, origin + "/", page, audio, false, true));

        // 권한 창을 기다리는 사이 화면이 바뀌었는지: 주소의 «경로»가 같으면 같은 화면(뒤의 ?·# 는 무시)
        check(VoiceCapturePolicy.samePage(origin, page, page));
        check(VoiceCapturePolicy.samePage(origin, page, origin + "/staff/session/abc"));
        check(VoiceCapturePolicy.samePage(origin, page, origin + "/staff/session/abc?tab=photo#top"));
        check(!VoiceCapturePolicy.samePage(origin, page, origin + "/staff/session/abc/"));
        check(!VoiceCapturePolicy.samePage(origin, page, origin + "/staff/session/other"));
        check(!VoiceCapturePolicy.samePage(origin, page, origin + "/staff"));
        check(!VoiceCapturePolicy.samePage(origin, page, "https://evil.invalid/staff/session/abc"));
        check(!VoiceCapturePolicy.samePage(origin, page, "https://pay.toss.im/staff/session/abc"));
        check(!VoiceCapturePolicy.samePage(origin, page, null));
        check(!VoiceCapturePolicy.samePage(origin, null, page));
        check(!VoiceCapturePolicy.samePage(origin, null, null));

        // 마지막 결정: 허용 조건 + 휴대폰 마이크 권한 → 거부 / 바로 허용 / 권한 창 띄우기
        check(VoiceCapturePolicy.decide(false, false) == VoiceCapturePolicy.Decision.DENY);
        check(VoiceCapturePolicy.decide(false, true) == VoiceCapturePolicy.Decision.DENY);   // 휴대폰 권한이 있어도 조건이 안 맞으면 거부
        check(VoiceCapturePolicy.decide(true, true) == VoiceCapturePolicy.Decision.GRANT);
        check(VoiceCapturePolicy.decide(true, false) == VoiceCapturePolicy.Decision.ASK);

        System.out.println("PASS " + checks + " voice capture policy checks; no microphone/network calls");
    }
}
