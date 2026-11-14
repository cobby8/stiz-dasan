"use server";

import {
  getStaffClassPeople,
  type StaffClassPerson,
} from "@/lib/staff-class-people";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { canSeeStaffFees, staffMasksSettledAmounts } from "@/lib/staff-session-rules";

export type LoadStaffClassPeopleResult =
  | { ok: true; people: StaffClassPerson[] }
  | { ok: false; message: string };

/** 수업 화면의 학생 상세 패널에 필요한 정보를 권한 검증 후 불러옵니다. */
export async function loadStaffClassPeople(input: {
  classId: string;
  sessionId?: string | null;
  sessionDateId?: string | null;
}): Promise<LoadStaffClassPeopleResult> {
  const classId = input.classId?.trim();
  const sessionId = input.sessionId?.trim() || null;
  const sessionDateId = input.sessionDateId?.trim() || null;

  if (!classId || classId.length > 100 || (sessionId && sessionId.length > 100) || (sessionDateId && sessionDateId.length > 100)) {
    return { ok: false, message: "수업 정보를 다시 확인해 주세요." };
  }

  const [people, access] = await Promise.all([
    getStaffClassPeople(classId, sessionId, sessionDateId),
    getStaffClassAccessContext(),
  ]);
  // 선생님(원장·부원장 외)에게는 미납 건수·금액을 내려보내지 않는다(f3 보완, 2026-11-13 원장 지시).
  // 화면만 숨기면 응답에 값이 남으므로 서버에서 null 로 바꿔 보낸다.
  if (!canSeeStaffFees(access.staff.appUserRole)) {
    return { ok: true, people: people.map((person) => ({ ...person, billing: null })) };
  }
  // 2026-11-14 부원장 금액 가림: 부원장은 미납 «건수»만 받고 학생별 미납 합계 금액은 서버에서 뺀다
  if (staffMasksSettledAmounts(access.staff.appUserRole)) {
    return { ok: true, people: people.map((person) => ({ ...person, billing: person.billing ? { ...person.billing, unpaidAmount: null } : null })) };
  }
  return { ok: true, people };
}
