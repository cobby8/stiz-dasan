import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { findRollingDriverRunToken } from "@/lib/shuttle/regularRun";
import { driverAppRunHref, driverRunMissingKeyPath } from "@/lib/staff-session-rules";
import { looksLikeStoreApp } from "@/lib/storeApp";

export const dynamic = "force-dynamic";

/**
 * 안드로이드 스토어 앱 전용 «로그인만으로 운행 시작» 길(2026-11-16 원장 지시 «로그인만으로 되도록»).
 *
 * 왜 따로 두나: 앱(1.0.3)의 위치 공유는 운행 링크 주소(/driver/열쇠)에서만 켜진다. 그래서 앱은 /staff/run 을
 * 막고 «준비 중» 창을 띄운다(앱 AppNavigationPolicy.needsAccountRunHandoff — 정확히 /staff/run 만 막는다).
 * 이 주소는 막히지 않으므로, 로그인·셔틀 권한을 확인한 뒤 서버가 오늘 운행 열쇠를 찾아 그 운행 화면으로 보낸다.
 * → 앱을 새로 올리지 않고도 로그인한 기사님이 위치 공유까지 쓴다. 기사님이 원래 문자로 받던 것과 같은 열쇠라 권한을 넓히지 않는다.
 * 순서(인증 → 셔틀 권한 → 열쇠)는 tests/staff-run-login.test.mjs 가 고정한다.
 */
export default async function StaffRunOpenPage() {
  const staff = await requireStaff();
  // 관리자 또는 기사님(승인된 추가 역할 포함)만. 선생님만인 사람은 운행표를 열지 않는다.
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");

  const token = await findRollingDriverRunToken();
  if (!token) {
    // 열쇠가 아직 없으면: 브라우저는 «아직 운행 링크가 없습니다» 안내가 있는 운행표(/staff/run)로.
    // 스토어 앱은 /staff/run 을 막아 «여는 중…»에서 멈추므로, 앱이 여는 셔틀 화면으로 보낸다(2026-11-17).
    const storeApp = looksLikeStoreApp({ userAgent: (await headers()).get("user-agent") });
    redirect(driverRunMissingKeyPath(storeApp));
  }
  // 이 길은 «운행 시작»을 눌러서만 온다 → 운행 화면이 도착하자마자 위치 공유 동의 창을 띄우게 표시를 단다(2026-11-20)
  redirect(driverAppRunHref(token));
}
