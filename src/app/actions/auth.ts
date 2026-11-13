"use server";

import { userFacingError, loginErrorMessage } from "@/lib/user-facing-error";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAppRole,
  resolveRedirectForRole,
  type AppRole,
} from "@/lib/auth-routes";
import { linkEnrollmentAccount } from "@/lib/enrollment-account-handoff";
import { getParentViewAccessForAuthUser } from "@/lib/account-view-access";
import { staffLoginEmail } from "@/lib/staff-login-id";
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

  let authEmail = identifier;
  if (loginContext === "staff") {
    // 직원은 휴대폰 번호만 넣어도 된다 — 초대 가입 로그인 메일이 «번호@staff.stiz.kr» 라서(b3). 이메일은 그대로.
    authEmail = staffLoginEmail(identifier);
  } else if (!identifier.includes("@")) {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM "User" WHERE LOWER(username) = LOWER($1) AND role = 'PARENT' LIMIT 1`,
      identifier,
    );
    // 학부모 아이디가 아니고 휴대폰 번호 모양이면 선생님·기사님 계정(«번호@staff.stiz.kr»)으로 본다.
    // 로그인 화면은 하나 — 로그인한 뒤 역할에 맞는 화면으로 간다(원장 2026-11-13). 학부모 아이디가 먼저라 학부모 로그인은 그대로.
    const staffEmail = staffLoginEmail(identifier);
    authEmail = rows[0]?.email || (staffEmail !== identifier ? staffEmail : `${identifier.toLowerCase()}@member.stiz.kr`);
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (error) {
    if (error.message === "Invalid login credentials") {
      // 학부모는 아이디로 로그인한다 — 틀렸을 때 «아이디·비밀번호 찾기»로 안내한다.
      return {
        error: loginContext === "staff"
          ? "휴대폰 번호(또는 이메일) 또는 비밀번호가 올바르지 않습니다."
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

export async function logoutStaff() {
  await forgetNativePushOnThisDevice();
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/staff/login");
}

export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
