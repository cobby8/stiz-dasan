"use server";

import { userFacingError, loginErrorMessage } from "@/lib/user-facing-error";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  isSafeInternalPath,
  normalizeAppRole,
  resolveRedirectForRole,
  type AppRole,
} from "@/lib/auth-routes";
import { linkEnrollmentAccount } from "@/lib/enrollment-account-handoff";
import { getParentViewAccessForAuthUser } from "@/lib/account-view-access";
import { readLastViewDestination } from "@/lib/auth/last-view-server";
import { resolveLoginAuthEmail } from "@/lib/staff-login-id";
// 로그아웃 때 이 기기의 앱 푸시 토큰을 지운다(e2) — 다음 사람이 이 휴대폰에 로그인하기 전까지 옛 계정 알림이 오지 않게
import { forgetNativePushOnThisDevice } from "@/lib/push/nativePushDevice";

async function getRoleForAuthUser(user?: { id?: string | null; email?: string | null }): Promise<AppRole | null> {
  if (!user?.id && !user?.email) return null;

  const rows = await prisma.$queryRawUnsafe<Array<{ role: string }>>(
    `SELECT role FROM "User"
     WHERE "authUserId" = $1 OR id = $1 OR LOWER(email) = LOWER($2)
     ORDER BY CASE WHEN "authUserId" = $1 THEN 0 WHEN id = $1 THEN 1 ELSE 2 END
     LIMIT 1`,
    user.id || "",
    user.email || "",
  );

  return rows[0] ? normalizeAppRole(rows[0].role) : null;
}

export async function login(formData: FormData) {
  const supabase = await createClient();

  const identifier = String(formData.get("email") || formData.get("username") || "").trim();
  const password = String(formData.get("password") || "");
  const redirectTo = formData.get("redirectTo") as string | null;
  const loginContext = formData.get("loginContext");
  const enrollmentHandoff = String(formData.get("enrollmentHandoff") || "");

  if (!identifier || !password) {
    return { error: "아이디(또는 이메일)와 비밀번호를 입력해 주세요." };
  }

  // 학부모식 아이디(새로 오는 선생님·기사님 포함)를 먼저 찾는다 — 직원 로그인 칸에서도(2026-11-18 5단계).
  // 예전엔 직원 칸이면 입력을 «번호@staff.stiz.kr»로만 바꿔서, 학부모와 같은 가입으로 들어온 새 직원의 아이디가 실패했다.
  let usernameEmail: string | null = null;
  if (!identifier.includes("@")) {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM "User" WHERE LOWER(username) = LOWER($1) AND role = 'PARENT' LIMIT 1`,
      identifier,
    );
    usernameEmail = rows[0]?.email || null;
  }
  // 학부모 아이디가 아니고 휴대폰 번호 모양이면 기존 선생님·기사님 계정(«번호@staff.stiz.kr»)으로 본다(b3).
  // 로그인 화면은 하나 — 로그인한 뒤 역할에 맞는 화면으로 간다(원장 2026-11-13). 판정은 resolveLoginAuthEmail 한 곳.
  const authEmail = resolveLoginAuthEmail({ identifier, loginContext, usernameEmail });

  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (error) {
    if (error.message === "Invalid login credentials") {
      // 학부모는 아이디로 로그인한다 — 틀렸을 때 «아이디·비밀번호 찾기»로 안내한다.
      // 2026-11-17: «아이디·비밀번호 찾기»는 학부모 전용이라 선생님·기사님·관리자에게 보여 주면 막힌다.
      // 로그인 화면이 하나라 누구인지는 입력값 모양으로만 안다 — 휴대폰 번호(숫자·하이픈·띄어쓰기, 01 로 시작)나 이메일(@)이면 직원 안내를 보인다.
      const looksLikeStaffLogin = /^01[\d\s-]+$/.test(identifier) || identifier.includes("@");
      return {
        error: loginContext === "staff"
          ? "휴대폰 번호(또는 이메일) 또는 비밀번호가 올바르지 않습니다."
          : looksLikeStaffLogin
            ? "아이디 또는 비밀번호가 맞지 않습니다. 처음이시거나 비밀번호가 기억나지 않으면 아래 카카오·구글·Apple 로그인을 눌러 주세요. 본인인증 한 번으로 바로 들어올 수 있어요."
            : "아이디 또는 비밀번호가 올바르지 않습니다. 기억나지 않으면 아래 «아이디·비밀번호 찾기»를 이용해 주세요.",
      };
    }
    if (error.message === "Email not confirmed") {
      return { error: "이메일 인증이 필요합니다. 받은 인증 메일을 확인해주세요." };
    }
    return { error: loginErrorMessage(error) };
  }

  // 실제 권한은 DB 역할만 신뢰합니다. DB에 없는 계정은 안전한 학부모로 제한합니다.
  const role = (await getRoleForAuthUser(data.user)) || "PARENT";
  // 로그인 직후도 계속 화면과 같이, 본인에게 직접 연결된 자녀만 인정합니다.
  const parentView = data.user ? await getParentViewAccessForAuthUser(data.user) : { hasOwnChildren: false, roles: undefined };
  let destination = resolveRedirectForRole(role, redirectTo, {
    preferRoleHome: loginContext === "staff" && redirectTo === "/staff",
    stayInStaffApp: loginContext === "staff-app",
    hasOwnChildren: parentView.hasOwnChildren,
    // 승인된 추가 역할(선생님·기사님)까지 보고 목적지를 정한다(다중 역할, 2026-10-25).
    roles: parentView.roles,
  });
  // «마지막에 쓰던 화면»(2026-11-17 원장 승인): 원래 가려던 화면·로그인 맥락·수강신청 연결이 없을 때만, 이 계정이 실제로
  // 쓸 수 있는 화면이면 그 화면에서 시작한다(판정은 계속 화면·앱 시작 주소와 같은 함수 — 권한은 서버가 다시 확인).
  if (data.user && !enrollmentHandoff) {
    const lastView = await readLastViewDestination({
      role,
      access: parentView,
      requestedPath: redirectTo,
      context: typeof loginContext === "string" ? loginContext : null,
    });
    if (lastView) destination = lastView;
  }

  if (enrollmentHandoff) {
    const appUsers = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "User"
        WHERE ("authUserId" = $1 OR ("authUserId" IS NULL AND id = $1))
          AND role = 'PARENT'
        ORDER BY CASE WHEN "authUserId" = $1 THEN 0 ELSE 1 END
        LIMIT 1`,
      data.user.id,
    );
    if (!appUsers[0]) {
      await supabase.auth.signOut();
      return { error: "학부모 계정으로 로그인해 주세요." };
    }
    try {
      await linkEnrollmentAccount({
        token: enrollmentHandoff,
        parentUserId: appUsers[0].id,
      });
      destination = "/mypage";
    } catch (linkError) {
      await supabase.auth.signOut();
      return {
        error: userFacingError(linkError, "수강신청서를 계정에 연결하지 못했습니다."),
      };
    }
  }

  // Metadata is only a UI/navigation hint. DB remains the permission source,
  // so a metadata sync failure must not turn a successful login into a failure.
  await supabase.auth.updateUser({
    data: {
      ...data.user?.user_metadata,
      role,
    },
  }).catch(() => undefined);

  revalidatePath("/", "layout");
  redirect(destination);
}

export async function signup(formData: FormData) {
  void formData;
  return { error: "새 회원가입 화면에서 휴대폰 인증을 완료해 주세요." };
}

export async function logout() {
  await forgetNativePushOnThisDevice();
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

/**
 * 로그아웃한 뒤, 다시 로그인하면 보던 화면으로 돌아오게 한다(2026-11-17).
 * 쓰는 곳: 카카오 학부모 인증 화면에서 직원 계정으로 들어온 경우 — 그냥 로그아웃하면 학부모로 다시 로그인해도
 * 인증 화면으로 못 돌아왔다. 숨은 입력 returnTo 로 돌아올 주소를 받는다.
 * 화면에서 온 값이라 그대로 믿지 않는다: 사이트 안 주소만 허용(isSafeInternalPath — «/» 시작, «//»·«\» 금지, /login 금지),
 * 역할 판별 중간 주소(continue)도 막는다(돌아오는 길이 맴돈다). 어긋나면 보통 로그아웃처럼 /login 으로만 간다.
 */
export async function logoutAndReturn(formData: FormData) {
  const returnTo = String(formData.get("returnTo") || "");
  const bare = returnTo.split("?")[0].split("#")[0];
  const isContinue = bare === "/auth/continue" || bare === "/staff/continue" || bare === "/mypage/continue";
  const safeReturnTo = isSafeInternalPath(returnTo) && !isContinue ? returnTo : null;

  // 아래 네 줄은 logout 과 같다(이 기기 앱 푸시 토큰 지우기 → 로그아웃 → 캐시 비우기)
  await forgetNativePushOnThisDevice();
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect(safeReturnTo ? `/login?redirect=${encodeURIComponent(safeReturnTo)}` : "/login");
}

export async function logoutStaff() {
  await forgetNativePushOnThisDevice();
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  // 2026-11-17 원장 지시: 직원 전용 로그인 화면을 없앴다 — 로그아웃하면 누구나 같은 로그인 화면으로 간다.
  redirect("/login");
}

export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
