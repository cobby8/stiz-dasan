/**
 * 비회원 결제 링크 — prisma 연결부(서버·관리자 내부 전용). 규칙은 guestPayLinkRules, DB 동작은 guestPayLink.
 * ⚠️ 화면(클라이언트) 코드에서 import 하지 말 것(토큰 발급 = 결제 열쇠 생성).
 */
import { prisma } from "@/lib/prisma";
import { BILLING_LINK_BASE } from "@/lib/messaging/parent-alimtalk-templates";
import { hashSensitiveRateLimitKey, takePublicRateLimit } from "@/lib/seasonal/public-rate-limit";
import { issueGuestPayLink, resolveGuestPayToken, revokeGuestPayLinks, type IssuedGuestPayLink, type ResolvedGuestPayToken } from "@/lib/payments/guestPayLink";
import { shouldUseGuestPayLink, type GuestPayLinkSource } from "@/lib/payments/guestPayLinkRules";

/** 같은 주소(IP)에서 10분에 이만큼 넘게 열면 막는다 — 토큰 43자라 맞히기는 불가능하지만 두드리기 자체를 줄인다 */
export const GUEST_PAY_RATE_LIMIT = { limit: 60, windowMs: 10 * 60 * 1000 } as const;
/** 틀린 링크 응답 지연(ms) — 빠르게 여러 개를 시험하지 못하게 */
export const GUEST_PAY_FAIL_DELAY_MS = 400;

export type GuestPayLinkResult = IssuedGuestPayLink & { url: string };

/**
 * 청구서 한 장의 비회원 결제 링크 — 관리자/서버 내부 전용.
 * 토큰은 해시만 저장해 «있는 링크를 다시 꺼내기»가 불가능하므로 부를 때마다 새 링크를 발급한다
 * (이전 링크는 그대로 둔다 — 이미 보낸 안내의 링크가 죽지 않게). 결제할 수 없는 청구서면 null.
 */
export async function getOrCreateInvoiceGuestLink(
    invoiceId: string,
    opts: { source: GuestPayLinkSource; createdByUserId?: string | null },
): Promise<GuestPayLinkResult | null> {
    const issued = await issueGuestPayLink(prisma, { invoiceId, source: opts.source, createdByUserId: opts.createdByUserId ?? null });
    if (!issued) return null;
    // 안내 알림톡 버튼과 같은 도메인(BILLING_LINK_BASE)을 쓴다 — 카톡으로 붙여 보내도 같은 주소
    return { ...issued, url: `${BILLING_LINK_BASE}${issued.path}` };
}

/**
 * 청구 안내 발송 직전 — «가입하지 않은» 학부모의 청구서마다 링크를 발급해 invoiceId → 경로(pay/<토큰>)로 돌려준다.
 * 한 장이라도 발급에 실패하면(표가 아직 없음 등) 그 청구서는 예전 경로(payments/<id>)로 나간다 — 발송을 막지 않는다.
 */
export async function issueGuestPayPathsForNotices(
    rows: Array<{ invoiceId: string | null; parentId: string | null; parentHasAccount: boolean | null; phone: string | null }>,
    opts: { source: GuestPayLinkSource; createdByUserId?: string | null },
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const row of rows) {
        // 번호가 없으면 문자·알림톡이 안 나가므로(앱 알림만) 링크도 만들지 않는다
        if (!row.invoiceId || out.has(row.invoiceId) || !String(row.phone ?? "").replace(/\D/g, "")) continue;
        if (!shouldUseGuestPayLink(row)) continue;
        try {
            const issued = await issueGuestPayLink(prisma, { invoiceId: row.invoiceId, source: opts.source, createdByUserId: opts.createdByUserId ?? null });
            if (issued) out.set(row.invoiceId, issued.path);
        } catch (error) {
            console.error("[guest-pay] 안내용 링크 발급 실패(이 청구서는 로그인 링크로 보냄):", error instanceof Error ? error.message.slice(0, 200) : error);
        }
    }
    return out;
}

/** 이 청구서의 살아 있는 비회원 링크를 모두 닫는다(관리자 «결제 링크 모두 닫기»). 닫은 개수 */
export function revokeInvoiceGuestLinks(invoiceId: string): Promise<number> {
    return revokeGuestPayLinks(prisma, invoiceId);
}

/** 토큰 확인(공개 화면·API 공용) */
export function resolveGuestPayLink(token: unknown, opts: { touch?: boolean } = {}): Promise<ResolvedGuestPayToken> {
    return resolveGuestPayToken(prisma, token, opts);
}

/** 같은 주소(IP)에서 너무 자주 두드리면 false. 주소 원문은 기록하지 않는다(해시 키) */
export function guestPayRateLimitOk(ip: string, scope: "page" | "api"): boolean {
    return takePublicRateLimit(`guest-pay:${scope}:${hashSensitiveRateLimitKey(ip || "unknown")}`, GUEST_PAY_RATE_LIMIT).allowed;
}

/** 요청 머리글에서 주소(IP) 한 줄 — clientIpKey 와 같은 순서 */
export function guestPayClientIp(headers: Headers): string {
    const raw = headers.get("cf-connecting-ip")
        || headers.get("x-real-ip")
        || headers.get("x-forwarded-for")?.split(",")[0]
        || "unknown";
    return raw.trim().slice(0, 100) || "unknown";
}

/** «학원으로 문의» 전화번호(학원 설정). 못 읽으면 빈 값 — 화면은 문구만 보인다 */
export async function guestPayContactPhone(): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ contactPhone: string | null }>>(
        `SELECT "contactPhone" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    ).catch(() => [] as Array<{ contactPhone: string | null }>);
    return String(rows[0]?.contactPhone ?? "").trim();
}

/** 틀린 링크 응답을 조금 늦춘다 */
export function guestPayFailDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, GUEST_PAY_FAIL_DELAY_MS));
}
