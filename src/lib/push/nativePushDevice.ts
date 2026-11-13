import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { findLinkedAppUserId } from "@/lib/auth-guard";
import { NATIVE_PUSH_DEVICE_COOKIE } from "@/lib/push/nativePushPolicy";

/**
 * 로그아웃: «이 기기»의 앱 푸시 토큰을 지운다(e2, 2026-11-14).
 *
 * 왜 쿠키인가: 로그아웃은 서버 액션이라 어느 휴대폰의 토큰인지 모른다. 토큰을 등록할 때
 * /api/push/native 가 그 줄 id 를 httpOnly 쿠키(stiz_np)로 남겨 두고, 로그아웃 때 그 줄만 지운다.
 * (같은 사람의 다른 휴대폰 토큰은 그대로 — 그 휴대폰은 여전히 로그인 중일 수 있다.)
 * 지금 로그인한 사람을 알면 «그 사람 줄일 때만» 지운다 — 쿠키가 남의 줄 id 를 가리켜도 남의 토큰을 지우지 않게.
 * 사람을 모르면(로그인 확인 실패) 쿠키의 줄만 지운다(예전과 같음).
 *
 * 로그아웃을 막지 않는다 — 실패해도 조용히 넘어간다(표가 아직 없는 DB 포함).
 */
export async function forgetNativePushOnThisDevice(): Promise<void> {
  try {
    const jar = await cookies();
    const id = jar.get(NATIVE_PUSH_DEVICE_COOKIE)?.value;
    if (!id) return;
    jar.delete(NATIVE_PUSH_DEVICE_COOKIE);
    const userId = await currentAppUserId();
    if (userId) {
      await prisma.$executeRawUnsafe(`DELETE FROM "NativePushToken" WHERE id = $1 AND "userId" = $2`, id, userId);
    } else {
      await prisma.$executeRawUnsafe(`DELETE FROM "NativePushToken" WHERE id = $1`, id);
    }
  } catch (error) {
    console.error("Native push logout cleanup failed:", error instanceof Error ? error.message : "UNKNOWN");
  }
}

async function currentAppUserId(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user ? await findLinkedAppUserId(user.id) : null;
  } catch {
    return null;
  }
}
