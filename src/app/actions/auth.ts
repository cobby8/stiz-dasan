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
    return { error: "이메일과 비밀번호를 입력해주세요." };
  }

  let authEmail = identifier;
  if (loginContext !== "staff" && !identifier.includes("@")) {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
      `SELECT email FROM "User" WHERE LOWER(username) = LOWER($1) AND role = 'PARENT' LIMIT 1`,
      identifier,
    );
    authEmail = rows[0]?.email || `${identifier.toLowerCase()}@member.stiz.kr`;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (error) {
    if (error.message === "Invalid login credentials") {
      return { error: "이메일 또는 비밀번호가 올바르지 않습니다." };
    }
    if (error.message === "Email not confirmed") {
      return { error: "이메일 인증이 필요합니다. 받은 인증 메일을 확인해주세요." };
    }
    return { error: loginErrorMessage(error) };
  }

  // 실제 권한은 DB 역할만 신뢰합니다. DB에 없는 계정은 안전한 학부모로 제한합니다.
  const role = (await getRoleForAuthUser(data.user)) || "PARENT";
  // 로그인 직후도 계속 화면과 같이, 본인에게 직접 연결된 자녀만 인정합니다.
  const parentView = data.user ? await getParentViewAccessForAuthUser(data.user) : { hasOwnChildren: false };
  let destination = resolveRedirectForRole(role, redirectTo, {
    preferRoleHome: loginContext === "staff" && redirectTo === "/staff",
    stayInStaffApp: loginContext === "staff-app",
    hasOwnChildren: parentView.hasOwnChildren,
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
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}

export async function logoutStaff() {
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
