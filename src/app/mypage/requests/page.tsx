import Link from "next/link";
import ParentBackLink from "@/components/parent/ParentBackLink";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { formatKstDate } from "@/lib/datetime/kst";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { listMyInquiries } from "@/lib/requests/inquiry-thread";
import { INQUIRY_PARENT_STATUS_LABEL, INQUIRY_PARENT_STATUS_TONE } from "@/lib/requests/inquiryThreadRules";

export const dynamic = "force-dynamic";
export const metadata = { title: "보낸 문의 | 스티즈 농구교실" };

// «보낸 문의» (2026-11-14 원장 결정표 c3) — 내가 학원에 보낸 문의를 언제든 다시 본다.
// 예전엔 답변·대기 건이 있을 때만 홈에 «보낸 메시지» 줄이 보여, 끝난 문의는 다시 찾을 길이 없었다.
// 한 줄 행: 날짜 · 첫 줄 · 상태(답변 대기/답변 옴/완료). 누르면 대화 화면에서 이어 쓴다.
// 대상은 서버가 확인한 로그인 사용자(appUserId)의 문의만 — 화면 값으로 남의 문의를 열 수 없다.

export default async function ParentRequestsPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    // bounced=1 로 목적지를 지운다(다른 계정 화면과 같은 이유 — 거절 → 판별 → 거절 반복 방지)
    if (!parent) redirect("/mypage/continue?bounced=1");

    const rows = await listMyInquiries(prisma, parent.appUserId);

    return (
        <div className="mx-auto grid max-w-2xl gap-3">
            <div className="flex items-center gap-2">
                {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
                <ParentBackLink fallbackHref="/mypage" ariaLabel="홈으로" className="academy-back-link" />
                <h1 className="academy-heading min-w-0 flex-1">보낸 문의</h1>
                {/* 새 문의는 홈의 문의 폼 한 곳에서 쓴다(폼을 두 벌 두지 않는다) */}
                <Link href="/mypage#parent-request-form" className="academy-button-primary shrink-0">새 문의</Link>
            </div>

            {rows.length === 0 ? (
                // 빈 상태는 한 줄 높이로 — 바로 위 «새 문의»가 다음 행동이다
                <p className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-3 text-sm text-[var(--color-academy-muted)]">
                    보낸 문의가 아직 없어요
                </p>
            ) : (
                <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
                    {rows.map((row) => (
                        <li key={row.id}>
                            <Link href={`/mypage/requests/${row.id}`} className="flex min-h-12 items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]">
                                <span className="w-14 shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--color-academy-muted)]">
                                    {formatKstDate(row.createdAt, { month: "numeric", day: "numeric" })}
                                </span>
                                {/* 환불 문의는 제목(«환불 문의 · 2026-11 수강료 72,000원»)이 곧 내용이라 제목을 보인다 */}
                                <span className="line-clamp-2 min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                                    {row.title.startsWith("환불 문의") ? row.title : row.firstLine || row.title}
                                </span>
                                <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${TONE_BADGE_CLASS[INQUIRY_PARENT_STATUS_TONE[row.status]]}`}>
                                    {INQUIRY_PARENT_STATUS_LABEL[row.status]}
                                </span>
                                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
