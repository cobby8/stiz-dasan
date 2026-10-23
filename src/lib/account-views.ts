import type { AppRole } from "@/lib/auth-routes";

export type AccountViewOption = {
  key: "admin" | "teacher" | "parent";
  label: string;
  href: "/admin" | "/staff" | "/mypage";
};

/** 화면 보기는 계정의 권한 값을 바꾸지 않습니다. 서버에서 확인한 자격만 받습니다. */
export function resolveAccountViews(role: AppRole | null, canUseParentView: boolean): AccountViewOption[] {
  if (!role || role === "DRIVER") return [];
  const views: AccountViewOption[] = [];
  if (role === "ADMIN" || role === "VICE_ADMIN") views.push({ key: "admin", label: "관리자", href: "/admin" });
  if (role === "ADMIN" || role === "VICE_ADMIN" || role === "INSTRUCTOR") views.push({ key: "teacher", label: "선생님", href: "/staff" });
  if (canUseParentView) views.push({ key: "parent", label: "학부모", href: "/mypage" });
  return views;
}
