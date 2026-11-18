import { redirect } from "next/navigation";

// 2026-11-18 원장 승인: 옛 «홈 화면 바로가기» 선생님 설치 안내 화면은 지우고 주소만 살려 /install 로 넘긴다.
// (next.config redirects 가 먼저 넘기지만, 그 규칙이 빠져도 옛 화면이 다시 뜨지 않게 여기서도 넘긴다)
export default function TeacherAppInstallPage() {
  redirect("/install");
}
