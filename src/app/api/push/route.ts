import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { findLinkedAppUserId } from "@/lib/auth-guard";

// 웹 푸시 구독 등록·해제 — 모든 역할(학부모·선생님·기사님·관리자) 공용. 역할 제한 없음.
//
// ★ 누구의 구독인지는 «지금 로그인(Auth id)에 직접 연결된 앱 계정»으로만 정한다(findLinkedAppUserId).
//   예전엔 이메일로 찾아(2026-11-10 보안 검수 HIGH) 간편로그인 계정은 구독이 실패하고,
//   이메일이 겹치면 남의 userId 로 저장돼 남의 알림이 이 기기로 올 수 있었다.

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

// POST: 웹 푸시 구독 등록
export async function POST(req: NextRequest) {
    try {
        const me = await currentAppUserId();
        if ("response" in me) return me.response;

        const { subscription } = await req.json();
        const endpoint = subscription?.endpoint;
        const p256dh = subscription?.keys?.p256dh;
        const auth = subscription?.keys?.auth;
        if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || typeof p256dh !== "string" || typeof auth !== "string") {
            return NextResponse.json({ error: "구독 정보가 없습니다." }, { status: 400 });
        }

        // 구독 저장. 같은 endpoint 가 이미 있으면 «지금 이 기기에 로그인한 사람»으로 옮긴다.
        // endpoint 는 기기(브라우저)마다 하나라, 가족이 한 휴대폰에서 계정을 바꿔 로그인했을 때
        // 옛 계정 알림이 계속 이 기기로 오지 않게 하려면 재할당이 맞다(endpoint 는 그 기기만 아는 긴 주소).
        await prisma.$executeRawUnsafe(
            `INSERT INTO "PushSubscription" (id, "userId", endpoint, p256dh, auth, "createdAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())
             ON CONFLICT (endpoint) DO UPDATE SET "userId" = $1, p256dh = $3, auth = $4`,
            me.userId,
            endpoint,
            p256dh,
            auth,
        );

        return NextResponse.json({ ok: true });
    } catch (e) {
        console.error("Push subscribe error:", e);
        return NextResponse.json({ error: "구독 처리에 실패했습니다." }, { status: 500 });
    }
}

// DELETE: 웹 푸시 구독 해제
export async function DELETE(req: NextRequest) {
    try {
        // 로그인한 사용자만 자신의 구독을 해제할 수 있다.
        const me = await currentAppUserId();
        if ("response" in me) return me.response;

        const { endpoint } = await req.json();
        if (!endpoint) {
            return NextResponse.json({ error: "endpoint가 필요합니다." }, { status: 400 });
        }

        await prisma.$executeRawUnsafe(
            `DELETE FROM "PushSubscription" WHERE endpoint = $1 AND "userId" = $2`, endpoint, me.userId
        );

        return NextResponse.json({ ok: true });
    } catch (e) {
        console.error("Push unsubscribe error:", e);
        return NextResponse.json({ error: "구독 해제에 실패했습니다." }, { status: 500 });
    }
}
