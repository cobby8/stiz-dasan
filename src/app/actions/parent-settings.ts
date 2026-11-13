"use server";

import { revalidatePath } from "next/cache";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { writePushPrefs } from "@/lib/parent-notification-preferences";
import { cleanDisplayName, newPasswordProblem, normalizePushPrefs } from "@/lib/mypage/parentSettings";
import { PARENT_WEAK_PASSWORD_MESSAGE, isWeakPasswordRejection } from "@/lib/parent-password-rules";
import { normalizePreferredPaymentMethod } from "@/lib/payments/preferredMethod";

// 학부모 설정 화면(/mypage/settings) 서버 동작 (2026-11-10 원장 결정 k7).
//
// ★ 보안: 누구의 정보를 바꿀지는 화면이 정하지 않는다. requireVerifiedParent() 가 확인한
//   로그인 사용자(appUserId)만 SQL 조건에 들어간다 — 화면이 다른 사람 id 를 보내도 받을 칸이 없다(IDOR 방지).

type Result = { ok: true } | { ok: false; error: string };

/** 내 이름 바꾸기 — 로그인한 본인 줄만 */
export async function updateMyName(name: string): Promise<Result> {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) return { ok: false, error: "다시 로그인해 주세요." };
    const clean = cleanDisplayName(name);
    if (!clean) return { ok: false, error: "이름은 1~30자로 입력해 주세요." };
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "User" SET name = $1, "updatedAt" = NOW() WHERE id = $2 AND "withdrawnAt" IS NULL`,
            clean,
            parent.appUserId,
        );
    } catch (e) {
        console.error("[updateMyName] failed:", e);
        return { ok: false, error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
    revalidatePath("/mypage", "layout");
    return { ok: true };
}

/**
 * 비밀번호 바꾸기 — 아이디·비밀번호로 로그인하는 계정만.
 * 지금 비밀번호를 한 번 더 확인한다(잠깐 열어 둔 휴대폰으로 남이 바꾸지 못하게).
 * 확인은 «저장하지 않는 별도 연결»로 해서 지금 로그인(쿠키)을 건드리지 않는다.
 */
export async function changeMyPassword(current: string, next: string, confirm: string): Promise<Result> {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) return { ok: false, error: "다시 로그인해 주세요." };
    const problem = newPasswordProblem(String(current ?? ""), String(next ?? ""), String(confirm ?? ""));
    if (problem) return { ok: false, error: problem };

    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;
    if (error || !user?.email) return { ok: false, error: "다시 로그인해 주세요." };
    const hasPasswordLogin = (user.identities ?? []).some((identity) => identity.provider === "email");
    if (!hasPasswordLogin) return { ok: false, error: "간편로그인 계정은 비밀번호가 없습니다." };

    // 1) 지금 비밀번호 확인 — 세션을 저장하지 않는 연결(쿠키·다른 기기 로그인에 영향 없음)
    const verifier = createSupabaseJsClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const checked = await verifier.auth.signInWithPassword({ email: user.email, password: current });
    if (checked.error || checked.data.user?.id !== user.id) {
        return { ok: false, error: "지금 비밀번호가 맞지 않습니다." };
    }
    // 확인용으로 만든 세션만 닫는다(scope local — 전체 로그아웃이 아님)
    await verifier.auth.signOut({ scope: "local" }).catch(() => undefined);

    // 2) 지금 로그인한 본인 계정의 비밀번호를 바꾼다
    const updated = await supabase.auth.updateUser({ password: next });
    if (updated.error) {
        console.error("[changeMyPassword] update failed:", updated.error.message);
        // 약한 비밀번호 거절은 이유를 알려 준다(가입·활성화·비밀번호 찾기와 같은 판정·문장)
        if (isWeakPasswordRejection(updated.error)) return { ok: false, error: PARENT_WEAK_PASSWORD_MESSAGE };
        return { ok: false, error: "비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
    return { ok: true };
}

/**
 * 자주 쓰는 결제 방법 저장(2026-11-13) — 로그인한 본인 계정만. 값은 화이트리스트만(모르는 값·빈 값 = 정하지 않음).
 * 결제가 승인되면 그때 쓴 방법으로 다시 바뀐다(«지난번 결제 방법»과 같은 칸).
 */
export async function saveMyPreferredPaymentMethod(value: unknown): Promise<Result> {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) return { ok: false, error: "다시 로그인해 주세요." };
    const clean = normalizePreferredPaymentMethod(value);
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "User" SET "preferredPaymentMethod" = $1, "preferredPaymentMethodUpdatedAt" = NOW() WHERE id = $2 AND "withdrawnAt" IS NULL`,
            clean,
            parent.appUserId,
        );
    } catch (e) {
        console.error("[saveMyPreferredPaymentMethod] failed:", e);
        return { ok: false, error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
    revalidatePath("/mypage/settings");
    return { ok: true };
}

/** 앱 알림 종류별 받기 저장 — 로그인한 본인 설정만 */
export async function saveMyPushPrefs(input: unknown): Promise<Result> {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) return { ok: false, error: "다시 로그인해 주세요." };
    try {
        await writePushPrefs(parent.appUserId, normalizePushPrefs(input));
    } catch (e) {
        console.error("[saveMyPushPrefs] failed:", e);
        return { ok: false, error: "저장하지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
    revalidatePath("/mypage/settings");
    return { ok: true };
}
