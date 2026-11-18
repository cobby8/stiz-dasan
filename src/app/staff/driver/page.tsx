import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { DRIVER_START_PARAM } from "@/lib/staff-session-rules";
import DriverEntryClient from "./DriverEntryClient";
import { hasDriverRunInProgress } from "./activeRun";

export const dynamic = "force-dynamic";

/**
 * 기사님 첫 화면(로그인 후 도착지) — 2026-11-13 b7·G3.
 *
 * 왜 따로 두는가:
 *   예전 기사님 첫 화면(/staff/shuttle)은 «운행 시작(위치 전송)»이 없는 계정용 운행표라,
 *   로그인한 기사님이 학부모에게 위치를 보낼 수 없었다. 위치 전송이 되는 화면은 /staff/run 이다.
 *   그런데 아이폰 스토어 앱은 지금 /staff/shuttle·/staff/run 으로 가는 길을 앱이 막는다(앱 다음 업데이트에서 열림).
 *   서버는 «스토어 앱인지»를 모른다(표식이 브라우저 sessionStorage 에 있다) → 화면에서 판정해
 *   아이폰 스토어 앱이면 안내를 보이고, 그 밖에는 바로 운행 화면으로 넘긴다.
 *
 * 2026-11-18 원장 결정 F: 로그인 직후처럼 «그냥» 들어온 경우의 첫 화면은 셔틀 명단(/staff/shuttle)이다 —
 *   운행 화면에는 아래 메뉴·이름 메뉴가 없어 다른 화면으로 갈 길이 없었다. 명단의 «운행 시작»(?start=1)을 눌러 온 경우와
 *   «이미 운행이 진행 중»인 경우(앱이 다시 켜졌을 때 위치 전송이 끊기지 않게)에만 운행 화면으로 넘긴다.
 *
 * 주소가 /staff 안인 이유: 설치된 선생님·통합 앱의 영역(/staff)을 벗어나지 않게.
 */
export default async function StaffDriverEntryPage({ searchParams }: { searchParams?: Promise<{ start?: string | string[] }> }) {
  const staff = await requireStaff();
  // 관리자 또는 기사님(승인된 추가 역할 포함)만. 선생님만인 사람은 수업 화면으로.
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");
  // «운행 시작»을 눌러 왔나 — 정해진 값(1)만 받는다
  const pressedStart = (await searchParams)?.[DRIVER_START_PARAM] === "1";
  // 운행 중에 앱이 다시 켜진 경우(2026-11-18 F 보완): 명단으로 보내면 «운행 시작»을 다시 눌러야 위치 전송이 이어지는데,
  // 모르고 체크만 하면 위치가 끊긴 채 달린다 → 진행 중인 운행이 있을 때만 예전처럼 운행 화면으로 바로 넘긴다.
  // 권한 확인 뒤에만, 눌러 온 경우엔 조회하지 않는다
  const startRun = pressedStart || (await hasDriverRunInProgress());
  return <DriverEntryClient canTeach={staff.roles.teacher} startRun={startRun} />;
}
