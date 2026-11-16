// 선생님 화면 «셔틀» 탭의 권한 판정(2026-11-16 원장 지시 «일반 선생님에게 셔틀 탭 열어줘»).
// 순수 함수만 둔다(prisma·next import 금지 — tests/staff-driver-role.test.mjs 가 그대로 실행한다).
//
// 사람은 셋으로 나뉜다:
//   - 관리자(원장·부원장) / 기사님: 기존 셔틀 권한(shuttleScope ALL·OWN) — 예전과 같다
//   - 일반 선생님(관리자·기사 역할 없음): «보기»(탑승 여부·차량 위치) + 직접 운행하는 날의 «선생님 운행»(탑승 체크)
//       · 보기 모드에서는 연락처·건강 특이사항을 서버가 아예 내려보내지 않는다(탑승 여부만 본다)
//       · 배정·검토·노선 편집·위치 전송 같은 기사님·관리자 기능은 열지 않는다
//   - 그 밖(직원 아님): 못 들어온다
import { shuttleScope, type EffectiveRoles } from "@/lib/account/roles";

export type StaffShuttleAccess = {
  /** 셔틀 탭에 들어올 수 있는가 */
  canOpen: boolean;
  /** 관리자·기사님이 아닌 «일반 선생님»으로 들어온 경우 */
  teacherOnly: boolean;
};

export function staffShuttleAccess(roles: EffectiveRoles): StaffShuttleAccess {
  const scoped = shuttleScope(roles) !== "NONE";
  return { canOpen: scoped || roles.teacher, teacherOnly: !scoped && roles.teacher };
}

type RiderWithPrivate = {
  parentPhone: string | null;
  studentPhone: string | null;
  healthNote?: string | null;
  hasHealthNote?: boolean;
  /** «오늘 탑승 장소: …»처럼 보호자가 적은 장소 글이 들어갈 수 있다 */
  shuttleNote?: string | null;
};

/**
 * 일반 선생님의 «보기» 모드용 — 학생 줄에서 연락처·건강 특이사항·장소 메모를 뺀다(탑승 여부만 본다).
 * 화면에서 가리는 것이 아니라 서버가 내려보내는 값 자체를 지운다.
 */
export function stripRiderPrivate<Row extends { riders: RiderWithPrivate[] }>(rows: Row[]): Row[] {
  return rows.map((row) => ({
    ...row,
    riders: row.riders.map((rider) => ({ ...rider, parentPhone: null, studentPhone: null, healthNote: null, hasHealthNote: false, shuttleNote: null })),
  }));
}
