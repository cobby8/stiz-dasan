import Link from "next/link";
import ParentBackLink from "@/components/parent/ParentBackLink";
import { notFound, redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { formatKstDate } from "@/lib/datetime/kst";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { getMyInquiry } from "@/lib/requests/inquiry-thread";
import { INQUIRY_PARENT_STATUS_LABEL, INQUIRY_PARENT_STATUS_TONE } from "@/lib/requests/inquiryThreadRules";
import InquiryThread from "@/components/parent/InquiryThread";
import InquiryReplyForm from "./InquiryReplyForm";
// 학원 대표 번호(설정값) — 연속 글 한도 안내의 전화 버튼용. 못 읽으면 null(버튼 없이 글자만)
import { getUsableAcademyPhone } from "@/lib/academyPhone";

export const dynamic = "force-dynamic";
export const metadata = { title: "보낸 문의 | 스티즈 농구교실" };

// 문의 한 건 — 대화 형태(내 글 → 학원 답 → 내 추가 글 …)로 보고, 아래에서 이어 쓴다(2026-11-14 원장 결정표 c3).
// 내 문의가 아니면 404 — 소유 확인은 조회 SQL 안에서 한다(getMyInquiry).

export default async function ParentRequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    const inquiry = await getMyInquiry(prisma, parent.appUserId, id);
    if (!inquiry) notFound();

    return (
        <div className="mx-auto grid max-w-2xl gap-3">
            <div className="flex items-center gap-2">
                <ParentBackLink fallbackHref="/mypage/requests" ariaLabel="보낸 문의 목록으로" className="academy-back-link" />
                <h1 className="academy-heading min-w-0 flex-1 break-keep">{inquiry.title}</h1>
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${TONE_BADGE_CLASS[INQUIRY_PARENT_STATUS_TONE[inquiry.status]]}`}>
                    {INQUIRY_PARENT_STATUS_LABEL[inquiry.status]}
                </span>
            </div>

            <InquiryThread
                viewer="PARENT"
                bubbles={inquiry.bubbles.map((bubble) => ({
                    key: bubble.key,
                    author: bubble.author,
                    body: bubble.body,
                    // 시각 글자는 서버에서 KST 로 만들어 넘긴다(기기 시간대를 따라가지 않게)
                    timeLabel: bubble.at ? formatKstDate(bubble.at, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "",
                }))}
            />

            {inquiry.canReply ? (
                <InquiryReplyForm requestId={inquiry.id} academyPhone={await getUsableAcademyPhone()} />
            ) : (
                // 이어 쓰기를 쓸 수 없는 환경 — 막다른 곳으로 두지 않고 새 문의로 보낸다
                <Link href="/mypage#parent-request-form" className="academy-button-secondary w-full">새 문의 보내기</Link>
            )}
        </div>
    );
}
