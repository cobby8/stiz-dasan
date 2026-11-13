import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { findLinkedAppUserId } from "@/lib/auth-guard";
import {
    NATIVE_PUSH_DEVICE_COOKIE,
    NATIVE_TOKENS_PER_USER,
    parseNativePushRegistration,
} from "@/lib/push/nativePushPolicy";
import { fcmServiceAccount } from "@/lib/push/fcm";

// 스토어 앱(안드로이드·아이폰) 푸시 토큰 등록·해제(e2, 2026-11-14) — 모든 역할 공용, 역할 제한 없음.
//
// 앱이 FCM 토큰을 웹 화면에 건네면, 웹(NativePushRegistrar)이 «웹뷰의 로그인 쿠키 그대로» 이 주소로 보낸다.
// ★ 누구의 토큰인지는 웹푸시(/api/push)와 같이 «지금 로그인(Auth id)에 직접 연결된 앱 계정»으로만 정한다.
//   요청 본문의 userId 같은 값은 받지 않는다 — 남의 계정으로 토큰을 걸 수 없다.

/** 로그인 확인 + 앱 계정 id. 실패하면 응답(NextResponse)을 돌려준다 */
async function currentAppUserId(): Promise<{ userId: string } | { response: NextResponse }> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return { response: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }) };
    }
    const userId = await findLinkedAppUserId(user.id);
    if (!userId) {
        return { response: NextResponse.json({ error: "사용자를 찾을 수 없습니다." }, { status: 404 }) };
    }
    return { userId };
}

// GET: 로그인 상태 + 서버 발송 키 설정 여부 — 앱이 처음 알림 권한을 물을지 정할 때·설정 화면 안내에 쓴다.
// configured=false(FCM_SERVICE_ACCOUNT_JSON 없음·깨짐)면 앱 알림이 실제로 가지 않으므로 화면은 «문자·카카오톡» 안내로.
// 키 값 자체는 돌려주지 않는다(있다/없다만).
export async function GET() {
    try {
        const me = await currentAppUserId();
        if ("response" in me) return me.response;
        return NextResponse.json({ ok: true, configured: fcmServiceAccount() !== null });
    } catch {
        return NextResponse.json({ error: "확인하지 못했습니다." }, { status: 500 });
    }
}

// POST: 앱 토큰 등록 { platform: "android" | "ios", token }
export async function POST(req: NextRequest) {
    try {
        const me = await currentAppUserId();
        if ("response" in me) return me.response;

        const parsed = parseNativePushRegistration(await req.json().catch(() => null));
        if (!parsed) {
            return NextResponse.json({ error: "토큰 정보가 올바르지 않습니다." }, { status: 400 });
        }

        // 같은 토큰이 이미 있으면 «지금 이 기기에 로그인한 사람»으로 옮긴다(웹푸시 endpoint 와 같은 규칙).
        // 토큰은 기기(앱 설치)마다 하나라, 가족이 한 휴대폰에서 계정을 바꿔 로그인하면 옛 계정 알림이 오지 않게 해야 한다.
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `INSERT INTO "NativePushToken" (id, "userId", platform, token, "createdAt", "lastSeenAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())
             ON CONFLICT (token) DO UPDATE SET "userId" = $1, platform = $2, "lastSeenAt" = NOW()
             RETURNING id`,
            me.userId,
            parsed.platform,
            parsed.token,
        );
        // 기기 바꿈·재설치로 쌓인 옛 토큰은 최근 N개만 남긴다
        await prisma.$executeRawUnsafe(
            `DELETE FROM "NativePushToken"
             WHERE "userId" = $1 AND id NOT IN (
               SELECT id FROM "NativePushToken" WHERE "userId" = $1 ORDER BY "lastSeenAt" DESC LIMIT $2
             )`,
            me.userId,
            NATIVE_TOKENS_PER_USER,
        );

        const res = NextResponse.json({ ok: true });
        // 로그아웃할 때 «이 기기 토큰»을 지우려고 줄 id 를 기억한다(토큰 값은 쿠키에 넣지 않는다)
        if (rows[0]?.id) {
            res.cookies.set(NATIVE_PUSH_DEVICE_COOKIE, rows[0].id, {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                path: "/",
                maxAge: 60 * 60 * 24 * 365,
            });
        }
        return res;
    } catch (e) {
        console.error("Native push register error:", e instanceof Error ? e.message : "UNKNOWN");
        return NextResponse.json({ error: "알림 등록에 실패했습니다." }, { status: 500 });
    }
}

// DELETE: 앱 토큰 해제 { token } — 본인 것만 지운다
export async function DELETE(req: NextRequest) {
    try {
        const me = await currentAppUserId();
        if ("response" in me) return me.response;

        const body = (await req.json().catch(() => null)) as { token?: unknown } | null;
        if (typeof body?.token !== "string" || !body.token) {
            return NextResponse.json({ error: "token 이 필요합니다." }, { status: 400 });
        }
        await prisma.$executeRawUnsafe(
            `DELETE FROM "NativePushToken" WHERE token = $1 AND "userId" = $2`,
            body.token,
            me.userId,
        );
        const res = NextResponse.json({ ok: true });
        res.cookies.delete(NATIVE_PUSH_DEVICE_COOKIE);
        return res;
    } catch (e) {
        console.error("Native push unregister error:", e instanceof Error ? e.message : "UNKNOWN");
        return NextResponse.json({ error: "알림 해제에 실패했습니다." }, { status: 500 });
    }
}
