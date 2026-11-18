import { permanentRedirect } from "next/navigation";

// 2026-11-18 원장 승인: 기사님 사용 설명 화면은 지우고 스토어 앱 설치 안내(/install) 하나로 모은다.
// 이미 문자로 보낸 주소가 있어 404 대신 /install 로 영구 이동시킨다.
export default function DriverGuidePage() {
  permanentRedirect("/install");
}
