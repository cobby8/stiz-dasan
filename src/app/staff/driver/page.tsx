import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import DriverEntryClient from "./DriverEntryClient";

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
 * 주소가 /staff 안인 이유: 설치된 선생님·통합 앱의 영역(/staff)을 벗어나지 않게.
 */
export default async function StaffDriverEntryPage() {
  const staff = await requireStaff();
  // 관리자 또는 기사님(승인된 추가 역할 포함)만. 선생님만인 사람은 수업 화면으로.
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");
  return <DriverEntryClient canTeach={staff.roles.teacher} />;
}
