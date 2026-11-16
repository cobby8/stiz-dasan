package kr.stiz.driver;

import java.net.URI;

/**
 * 음성 입력(마이크) 허용 판정(2026-11-16, 1.0.4). 안드로이드에 기대지 않는 순수 규칙 — tests/VoiceCapturePolicyTest.java 가 직접 돌린다.
 *
 * 웹의 «음성으로 기록» 버튼(src/components/staff/VoiceToTextButton.tsx)은 getUserMedia({audio:true}) 로 마이크를 연다.
 * 웹뷰는 그때 «이 화면이 마이크를 쓰려 한다»고 앱에 묻는다. 여기서는 그 물음에 «누가·무엇을» 요청했는지만 보고 답을 정한다.
 * 원칙(권한 최소): 우리 사이트가, 우리 사이트 화면에서, 마이크 «하나만» 요청했을 때만 허용한다. 영상·그 밖의 자원·다른 출처는 전부 거부.
 */
final class VoiceCapturePolicy {
    private VoiceCapturePolicy() { }

    /** android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE 와 같은 글자(순수 자바 테스트를 위해 여기에 따로 둔다) */
    static final String AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE";
    /** 웹이 «이 앱은 음성 입력이 된다»를 알아보는 사용자 에이전트 표식 — 웹 쪽 판정과 글자가 정확히 같아야 한다 */
    static final String USER_AGENT_MARK = " STIZVoice/1";

    enum Decision { DENY, GRANT, ASK }

    /** 통합 앱에서만 켠다. 격리 시험 앱(sandbox)은 실제 기기 기능을 쓰지 않고, 기사님 전용 앱에는 음성 버튼이 없다 */
    static boolean enabled(boolean unified, boolean sandbox) { return unified && !sandbox; }

    /**
     * 웹뷰의 권한 요청을 받아 줄 조건.
     * @param requestOrigin 요청한 쪽의 출처(안쪽 화면 iframe 이면 그 iframe 의 출처) — 「https://www.stiz-dasan.kr/」 모양
     * @param pageUrl       지금 웹뷰 맨 위에 보이는 화면 주소
     * @param resources     요청한 자원 목록 — 마이크 하나뿐이어야 한다
     */
    static boolean allowed(String origin, String requestOrigin, String pageUrl, String[] resources, boolean unified, boolean sandbox) {
        if (!enabled(unified, sandbox)) return false;
        if (resources == null || resources.length != 1 || !AUDIO_CAPTURE.equals(resources[0])) return false;
        return bareOrigin(origin, requestOrigin) && pageUrl != null && AppNavigationPolicy.isAppPage(origin, pageUrl, unified);
    }

    /** 요청 출처는 경로·질의가 없는 «출처 그대로»여야 한다(https://호스트 또는 https://호스트/) */
    private static boolean bareOrigin(String origin, String requestOrigin) {
        if (requestOrigin == null || !AppNavigationPolicy.sameOrigin(origin, requestOrigin)) return false;
        try {
            URI uri = new URI(requestOrigin);
            String path = uri.getRawPath() == null ? "" : uri.getRawPath();
            return (path.isEmpty() || "/".equals(path)) && uri.getRawQuery() == null && uri.getRawFragment() == null;
        } catch (Exception failure) { return false; }
    }

    /**
     * 휴대폰 권한 창을 기다리는 사이 화면이 바뀌었는지. 주소의 «경로»가 같으면 같은 화면으로 본다
     * (화면 이동 감시가 ?·# 없이 경로만 알려 주는 경우가 있어, 전체 주소로 비교하면 멀쩡한 요청을 잘못 끊는다).
     */
    static boolean samePage(String origin, String requestedPage, String currentPage) {
        if (requestedPage == null || currentPage == null) return false;
        if (!AppNavigationPolicy.sameOrigin(origin, requestedPage) || !AppNavigationPolicy.sameOrigin(origin, currentPage)) return false;
        try {
            String before = new URI(requestedPage).getRawPath(), after = new URI(currentPage).getRawPath();
            return (before == null ? "" : before).equals(after == null ? "" : after);
        } catch (Exception failure) { return false; }
    }

    /** 조건이 맞고 휴대폰 마이크 권한이 이미 있으면 바로 허용, 없으면 그때 권한 창을 띄운다. 조건이 안 맞으면 권한이 있어도 거부 */
    static Decision decide(boolean allowed, boolean runtimePermissionGranted) {
        if (!allowed) return Decision.DENY;
        return runtimePermissionGranted ? Decision.GRANT : Decision.ASK;
    }
}
