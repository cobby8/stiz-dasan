import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { findRollingDriverRunToken } from "@/lib/shuttle/regularRun";
import UnifiedDriverRunPage, { isValidRunDate } from "@/components/shuttle/UnifiedDriverRunPage";

export const dynamic = "force-dynamic";

/**
 * 로그인한 기사님의 오늘 운행표 — 문자로 받은 링크 없이 앱 로그인만으로 연다(다중 역할 5단계, 2026-10-25).
 *
 * 운행 화면은 원래 학원 공용 고정 링크(토큰)로 열린다. 그 링크를 문자로 받지 못했거나 잃어버린
 * 기사님도, 원장이 기사님 역할을 준 계정으로 로그인했으면 같은 화면을 연다. 승하차 체크 등 기존 기능은
 * 같은 열쇠로 그대로 동작하므로 새 권한 경로를 만들지 않는다.
 *
 * 주소가 /staff 안인 이유: 설치된 선생님·통합 앱의 영역(/staff)을 벗어나지 않게.
 */
export default async function StaffRunPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const staff = await requireStaff();
  // 관리자 또는 기사님(승인된 추가 역할 포함)만. 선생님만인 사람은 운행표를 열지 않는다.
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");

  const token = await findRollingDriverRunToken();
  if (!token) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10 text-center">
        <p className="text-4xl" aria-hidden="true">🚌</p>
        <h1 className="mt-3 text-lg font-black text-gray-900 dark:text-white">아직 운행 링크가 없습니다</h1>
        <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
          원장님이 셔틀 배차 화면에서 기사님 운행 링크를 만들면 여기서 바로 열립니다.
        </p>
        <Link href="/staff/shuttle" className="mt-5 inline-flex rounded-xl bg-gray-100 px-4 py-2.5 text-sm font-bold text-gray-700 dark:bg-gray-800 dark:text-gray-200">
          셔틀 화면으로
        </Link>
      </div>
    );
  }

  const sp = await searchParams;
  // date 쿼리는 클라 입력이므로 서버에서 형식·달력 유효성을 확인한 뒤에만 쓴다(기존 /driver/[token] 과 같게).
  const searchDate = sp?.date && isValidRunDate(sp.date) ? sp.date : null;
  // 로그인 경로라 링크를 기기에 기억시키지 않는다(기억 옵션을 켜지 않음) — 계정이 곧 열쇠다.
  // 기억시키면 로그아웃하거나 역할을 회수해도 그 기기에서는 운행표가 계속 열린다.
  return <UnifiedDriverRunPage token={token} searchDate={searchDate} />;
}
