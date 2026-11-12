import Link from "next/link";
import { notFound } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getMyPageData, getNoticeById } from "@/lib/queries";
import { toNoticeHtml, isImageAttachment, isHtmlContent } from "@/lib/noticeContent";
import { sanitizeHtml } from "@/lib/sanitize";
import { formatKstDate } from "@/lib/datetime/kst";
import { parseNoticeTargetClassIds } from "@/lib/noticeTargets";

// 학부모 앱 안의 공지 상세 (2026-11-09 — 설치 앱 범위 문제).
// 공개 홈페이지의 /notices/[id] 는 설치된 학부모 앱의 범위(/mypage) 밖이라, 누르면 주소창이 뜨고
// 아래 탭·헤더가 사라져 돌아올 길이 없었다. 같은 공지를 /mypage 안에서 보여 준다.
// 본문 그리기는 공개 화면과 같은 방식(HTML 은 sanitizeHtml, 옛 글은 toNoticeHtml 이스케이프)을 쓴다.
// 공개 /notices/[id] 주소는 그대로 둔다(밖에서 받은 링크용).
export const dynamic = "force-dynamic";

export default async function ParentNoticeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const parent = await requireVerifiedParent();
    const [notice, data] = await Promise.all([getNoticeById(id), getMyPageData(parent.appUserId)]);
    if (!notice) notFound();

    // 홈·소식 목록과 같은 기준으로만 보여 준다: 전체 공지이거나, 우리 아이 반을 대상으로 한 반 공지.
    const classIds = new Set(
        (data?.children ?? []).flatMap((c) => c.enrollments.map((e: { classId: string | null }) => e.classId).filter(Boolean) as string[]),
    );
    // 전체·반 공지 말고 다른 대상(예: 직원 공지)은 학부모에게 보이지 않는다
    if (notice.targetType !== "ALL" && notice.targetType !== "CLASS") notFound();
    if (notice.targetType === "CLASS") {
        // 관리자 공지 = 쉼표 문자열, 선생님 반 공지 = JSON 배열 — 공용 파서로 둘 다 읽는다
        const targets = parseNoticeTargetClassIds(notice.targetClassIds);
        if (!targets.some((cid) => classIds.has(cid))) notFound();
    }

    let attachments: { url: string; filename: string; size: number }[] = [];
    try { attachments = notice.attachmentsJSON ? JSON.parse(notice.attachmentsJSON) : []; } catch {}
    const imageAtts = attachments.filter(isImageAttachment);
    const fileAtts = attachments.filter((a) => !isImageAttachment(a));

    return (
        <article className="space-y-4">
            <Link href="/mypage/reports#news-notices" className="academy-back-link">
                <span className="material-symbols-outlined text-sm" aria-hidden="true">arrow_back</span>
                소식
            </Link>
            <header>
                {notice.isPinned && (
                    <p className="mb-1 text-xs font-bold text-[var(--color-academy-warning)]">중요 공지</p>
                )}
                <h1 className="break-keep text-xl font-extrabold text-[var(--color-academy-ink)]">{notice.title}</h1>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                    게시일 {formatKstDate(notice.createdAt, { year: "numeric", month: "long", day: "numeric" })}
                    <span className="ml-2">· 게시 당시 기준 안내입니다</span>
                </p>
            </header>

            <div className="academy-panel p-4 md:p-6">
                {isHtmlContent(notice.content) ? (
                    // 리치 에디터 HTML 공지 — XSS 제거(sanitizeHtml) 후에만 넣는다. 원문 그대로 넣지 말 것.
                    <div
                        className="notice-content max-w-none text-[var(--color-academy-muted)] [overflow-wrap:anywhere]"
                        data-outside-links
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(notice.content, { linkifyTextUrls: true }) }}
                    />
                ) : (
                    // 옛 순수 텍스트 공지 — toNoticeHtml 이 이스케이프 + 줄바꿈 + 주소 링크
                    <div
                        className="max-w-none whitespace-pre-wrap text-[15px] leading-loose text-[var(--color-academy-muted)] [overflow-wrap:anywhere]"
                        data-outside-links
                        dangerouslySetInnerHTML={{ __html: toNoticeHtml(notice.content) }}
                    />
                )}

                {/* 이미지 첨부 — 본문 아래에 크게 */}
                {imageAtts.length > 0 && (
                    <div className="mt-6 space-y-3">
                        {imageAtts.map((a, i) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={i} src={a.url} alt={a.filename || `공지 이미지 ${i + 1}`} loading="lazy"
                                className="w-full rounded-xl border border-[var(--color-academy-line)]" />
                        ))}
                    </div>
                )}

                {/* 그 외 첨부파일 — 내려받기 */}
                {fileAtts.length > 0 && (
                    <div className="mt-6 border-t border-[var(--color-academy-line)] pt-4">
                        <h2 className="mb-2 text-sm font-bold text-[var(--color-academy-ink)]">첨부파일 <span className="tabular-nums">{fileAtts.length}</span>개</h2>
                        <ul className="space-y-1">
                            {fileAtts.map((a, i) => (
                                <li key={i}>
                                    <a href={a.url} data-outside-link target="_blank" rel="noopener noreferrer"
                                        className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]">
                                        <span className="material-symbols-outlined text-base" aria-hidden="true">download</span>
                                        <span className="min-w-0 break-all">{a.filename}</span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </article>
    );
}
