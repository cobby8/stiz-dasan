import { cookies } from "next/headers";
import { canRoleAccessPath, defaultPathForRole, type AccessRoles, type AppRole } from "@/lib/auth-routes";
import { resolveAccountViews } from "@/lib/account-views";
import { LAST_VIEW_COOKIE, resolveLastViewDestination } from "@/lib/auth/last-view";

/**
 * «마지막에 쓰던 화면» 쿠키를 읽어, 이 계정이 그 화면을 실제로 쓸 수 있을 때만 주소를 돌려준다(서버 전용).
 *
 * 왜 따로 뒀나: 목적지를 정하는 곳이 둘 이상이어도(계속 화면·시작 주소·로그인) 같은 판정을 쓰게 하려고.
 * 권한 확인은 두 겹이다 — ① 화면 전환 목록과 같은 판정(resolveAccountViews) ② 경로 판정(canRoleAccessPath).
 * 둘 중 하나라도 아니면 null 을 돌려주고, 부르는 쪽은 지금처럼 대표 역할 기본 화면으로 보낸다.
 */
export async function readLastViewDestination(input: {
  role: AppRole;
  /** getParentViewAccessForAuthUser 가 돌려준 값(서버가 확인한 자격) */
  access: {
    hasOwnChildren?: boolean;
    canUseParentView?: boolean;
    grants?: Parameters<typeof resolveAccountViews>[2];
    roles?: AccessRoles;
  };
  requestedPath?: string | null;
  context?: string | null;
  bounced?: boolean;
}): Promise<string | null> {
  const { role, access, requestedPath, context, bounced } = input;
  // 쿠키를 볼 일이 없는 경우(원래 가려던 화면·로그인 맥락·방금 거절됨)는 읽지도 않는다.
  if (bounced || requestedPath || context) return null;

  let cookieValue: string | undefined;
  try {
    cookieValue = (await cookies()).get(LAST_VIEW_COOKIE)?.value;
  } catch {
    // 쿠키를 못 읽어도 로그인·앱 시작은 그대로 되어야 한다.
    return null;
  }
  if (!cookieValue) return null;

  // 실제 기사님은 화면 전환 주소(운행표 /staff/shuttle)가 아니라 기사님 첫 화면으로 보낸다 —
  // 앱을 켰을 때 위치 전송이 되는 운행 화면으로 이어지는 기존 흐름(2026-11-13)을 지킨다.
  // 관리자가 «기사님» 화면을 고른 경우는 운행표 그대로.
  const isDriver = access.roles ? access.roles.driver : role === "DRIVER";
  const views = resolveAccountViews(role, Boolean(access.canUseParentView), access.grants ?? []).map((view) =>
    view.key === "driver" && isDriver ? { key: view.key, href: defaultPathForRole("DRIVER") } : view,
  );

  const destination = resolveLastViewDestination({ cookieValue, views, requestedPath, context, bounced });
  if (!destination) return null;
  return canRoleAccessPath(role, destination, { hasOwnChildren: access.hasOwnChildren, roles: access.roles })
    ? destination
    : null;
}
