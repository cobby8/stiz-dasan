import type { AppRole } from "@/lib/auth-routes";
import { effectiveRoles, type RoleGrantRow } from "@/lib/account/roles";

export type AccountViewOption = {
  key: "admin" | "teacher" | "driver" | "parent";
  label: string;
  href: "/admin" | "/staff" | "/staff/shuttle" | "/mypage";
};

/**
 * 화면 보기는 계정의 권한 값을 바꾸지 않습니다. 서버에서 확인한 자격만 받습니다.
 *
 * 2026-10-25 다중 역할: 승인된 추가 역할(grants)도 화면으로 연다. 예전에는 기사님을 화면 전환에서
 * 아예 뺐는데, 원장 결정으로 「기사님 + 학부모」「선생님 + 기사님」이 가능해져 기사님 화면도 넣는다.
 * grants 를 넘기지 않으면 예전과 같은 결과(주 역할만)다.
 */
export function resolveAccountViews(
  role: AppRole | null,
  canUseParentView: boolean,
  grants: readonly RoleGrantRow[] = [],
): AccountViewOption[] {
  if (!role) return [];
  const roles = effectiveRoles({ primaryRole: role, grants, hasStudents: false });
  const views: AccountViewOption[] = [];
  if (roles.admin) views.push({ key: "admin", label: "관리자", href: "/admin" });
  if (roles.teacher) views.push({ key: "teacher", label: "선생님", href: "/staff" });
  // 관리자는 셔틀을 관리자 화면에서 다루므로 따로 넣지 않는다(기사님 화면은 본인 노선 체크용).
  if (roles.driver && !roles.admin) views.push({ key: "driver", label: "기사님", href: "/staff/shuttle" });
  // 학부모 화면은 휴대폰 인증·자녀 연결 규칙을 지킨 결과(canUseParentView)만 따른다.
  if (canUseParentView) views.push({ key: "parent", label: "학부모", href: "/mypage" });
  return views;
}
