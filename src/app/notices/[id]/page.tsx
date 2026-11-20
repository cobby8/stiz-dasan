// 오류를 숨기지 않는 조회 — DB 오류가 «없는 공지(404)»로 저장되지 않게(저장 화면, 속도 10회차)
import { getNoticeByIdOrThrow, getAcademySettings } from "@/lib/queries";
import PublicPageLayout from "@/components/PublicPageLayout";
import AnimateOnScroll from "@/components/ui/AnimateOnScroll";
import Badge from "@/components/ui/Badge";
import CTABanner from "@/components/landing/CTABanner";
import Link from "next/link";
import ReturnLink from "@/components/common/ReturnLink";
import { notFound } from "next/navigation";
import { toNoticeHtml, isImageAttachment, isHtmlContent } from "@/lib/noticeContent";
import { sanitizeHtml } from "@/lib/sanitize";
import { formatKstDate } from "@/lib/datetime/kst";
import { buildNoticeMetadata } from "@/lib/noticeMetadata";
import type { Metadata } from "next";

export const revalidate = 60;

// 2026-11-19 속도 10회차: 미리 만들 공지는 없다([]) — 그래도 이 함수가 있어야 Next 가 이 화면을 «처음 열릴 때 그려 저장(ISR)»으로 다룬다.
// 없으면 revalidate=60 이 있어도 매번 서버에서 새로 그렸다(빌드 표 ƒ, 운영 응답 x-vercel-cache 가 계속 MISS).
// 사람마다 다른 내용이 없는 공개 화면이고, 공지 수정·삭제는 admin.ts 가 이 주소를 바로 갱신한다(revalidatePath(`/notices/${id}`)).
export async function generateStaticParams() {
    return [];
}

// 공개 화면에는 «전체 공지»만 보인다(2026-11-20 원장 결정).
// 특정 반에만 보낸 공지(targetType=CLASS)는 주소를 알아도 «없는 공지(404)»로 보이고,
// 그 반 학부모는 마이페이지 소식(/mypage/news/[id])에서 로그인한 채로 본다.
// 공개 목록·홈·챗봇은 원래부터 전체 공지만 보여 줬고, 이 상세 화면만 반 공지가 열리던 구멍이었다.
// 반 공지를 전체 공지로 바꾸면 updateNotice 가 이 주소를 갱신해 저장된 404 도 바로 풀린다.
function publicOnly<T extends { targetType?: string | null }>(notice: T | null): T | null {
    return notice && notice.targetType === "ALL" ? notice : null;
}

// 공지마다 제목·요약·canonical(/notices/[id])을 따로 단다 — 홈 메타를 물려받아 검색에서 중복 처리되던 문제.
// getNoticeByIdOrThrow 는 react cache 로 감싸져 있어 본문 렌더와 같은 요청에서 DB 를 두 번 읽지 않는다.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
    const { id } = await params;
    // 반 공지는 제목도 메타에 싣지 않는다(«공지를 찾을 수 없습니다» + 검색 제외)
    return buildNoticeMetadata(publicOnly(await getNoticeByIdOrThrow(id)));
}

export default async function NoticeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // DB에서 공지사항 상세와 학원 설정을 병렬로 가져온다
    const [found, settings] = await Promise.all([
        getNoticeByIdOrThrow(id),
        getAcademySettings() as Promise<any>,
    ]);

    // 없는 공지와 반 공지는 똑같이 404 — 반 공지가 있다는 사실도 드러내지 않는다
    const notice = publicOnly(found);
    if (!notice) notFound();

    const phone = settings.contactPhone || "010-0000-0000";

    // 첨부파일 JSON 파싱
    let attachments: { url: string; filename: string; size: number }[] = [];
    try { attachments = notice.attachmentsJSON ? JSON.parse(notice.attachmentsJSON) : []; } catch {}
    // 이미지 첨부(본문 아래 인라인 노출)와 그 외 파일(다운로드 링크)로 분리
    const imageAtts = attachments.filter(isImageAttachment);
    const fileAtts = attachments.filter(a => !isImageAttachment(a));

    // 파일 크기 포맷 함수
    function formatSize(bytes: number) {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }

    return (
        <PublicPageLayout>
            {/* 페이지 히어로 — 그라데이션 + 장식 도형 + 공지 제목/날짜 */}
            <section className="public-page-hero public-page-hero--compact relative overflow-hidden bg-gradient-to-br from-[var(--color-public-dark)] via-[var(--color-public-dark)] to-[var(--color-public-dark)] text-white py-16 md:py-20">
                <div className="max-w-4xl mx-auto px-6 md:px-4 relative">
                    <AnimateOnScroll>
                        {/* 목록으로 돌아가기 링크 — 목록에서 왔으면 한 칸 뒤로(스크롤 그대로), 아니면 목록으로(ReturnLink, 2026-11-17) */}
                        <ReturnLink
                            href="/notices"
                            className="inline-flex items-center gap-1.5 text-[var(--color-public-dark-muted)] hover:text-white text-sm mb-2 min-h-11 transition-colors"
                        >
                            <span aria-hidden="true">←</span> 목록으로 돌아가기
                        </ReturnLink>

                        {/* 고정 공지 뱃지 */}
                        {notice.isPinned && (
                            <div className="mb-3">
                                <Badge variant="error" size="md">
                                    중요 공지
                                </Badge>
                            </div>
                        )}

                        {/* 공지 제목 */}
                        <h1 className="text-3xl md:text-4xl font-bold leading-tight mb-3 break-keep">{notice.title}</h1>

                        {/* 날짜 */}
                        <p className="text-[var(--color-public-dark-muted)] text-sm">
                            게시일 · {" "}
                            {formatKstDate(notice.createdAt, {
                                year: "numeric",
                                month: "long",
                                day: "numeric",
                            })}
                        </p>
                        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--color-public-dark-muted)]">
                            <span>공지 내용은 게시 당시 기준입니다.</span>
                            <Link href="/schedule" className="underline underline-offset-2">현재 시간표</Link>
                            <Link href="/seasonal" className="underline underline-offset-2">방학특강 모집 확인</Link>
                        </p>
                    </AnimateOnScroll>
                </div>
            </section>

            {/* 공지 본문 + 첨부파일 */}
            <div className="bg-surface-section dark:bg-[var(--color-public-paper)] transition-colors duration-300">
                <div className="max-w-4xl mx-auto px-4 py-12 md:py-16">
                    <AnimateOnScroll>
                        <div className="bg-white dark:bg-[var(--color-public-tint)] rounded-2xl border border-[var(--color-public-line)] dark:border-[var(--color-public-line)] transition-colors duration-300 shadow-sm p-6 md:p-10">
                            {/* 본문 — 새 공지(리치 에디터 HTML)와 옛 공지(순수 텍스트)를 판별해 각기 안전하게 렌더 */}
                            {isHtmlContent(notice.content) ? (
                                // 리치 에디터로 작성된 HTML 공지: XSS 제거(sanitizeHtml, jsdom 미사용) 후 .notice-content 서식 적용
                                // ⚠️ 반드시 sanitizeHtml을 거친다 — 원문을 그대로 넣으면 XSS 위험. sanitize.ts는 sanitize-html(순수 JS)이라 500 안전.
                                // .notice-content 는 line-height/font-size를 자체 지정하므로 글자색만 컨테이너에서 상속시킨다(라이트/다크 대응).
                                <div
                                    className="notice-content max-w-none text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] [overflow-wrap:anywhere]"
                                    data-outside-links
                                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(notice.content, { linkifyTextUrls: true }) }}
                                />
                            ) : (
                                // 옛 순수 텍스트 공지(하위호환): 줄바꿈 유지 + URL 자동 링크(toNoticeHtml이 이미 이스케이프해 안전, sanitize 미경유 → 500 위험 없음)
                                <div
                                    className="max-w-none whitespace-pre-wrap text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] leading-loose text-[15px] md:text-base [overflow-wrap:anywhere]"
                                    data-outside-links
                                    dangerouslySetInnerHTML={{ __html: toNoticeHtml(notice.content) }}
                                />
                            )}

                            {/* 이미지 첨부 — 본문 아래에 이미지로 크게 노출 (클릭 시 원본 열기) */}
                            {imageAtts.length > 0 && (
                                <div className="mt-8 space-y-4">
                                    {imageAtts.map((a, i) => (
                                        <a key={i} href={a.url} data-outside-link target="_blank" rel="noopener noreferrer" className="block group">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={a.url}
                                                alt={a.filename || `공지 이미지 ${i + 1}`}
                                                loading="lazy"
                                                className="w-full rounded-2xl border border-[var(--color-public-line)] dark:border-[var(--color-public-line)] shadow-sm group-hover:shadow-md transition-shadow"
                                            />
                                        </a>
                                    ))}
                                </div>
                            )}

                            {/* 이미지 외 첨부파일 — 다운로드 링크 */}
                            {fileAtts.length > 0 && (
                                <div className="mt-10 pt-6 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]">
                                    <h3 className="text-sm font-semibold text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] mb-4 flex items-center gap-2">
                                        첨부파일 ({fileAtts.length}개)
                                    </h3>
                                    <div className="space-y-2">
                                        {fileAtts.map((a, i) => (
                                            <a
                                                key={i}
                                                href={a.url} data-outside-link
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center justify-between bg-[var(--color-public-tint)] hover:bg-[var(--color-public-tint)] dark:bg-[var(--color-public-paper)] dark:hover:bg-[var(--color-public-tint)] rounded-xl px-4 py-3.5 transition-colors group"
                                            >
                                                <span className="text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)] truncate group-hover:text-[var(--color-public-strong)] dark:group-hover:text-brand-neon-lime transition-colors">
                                                    {a.filename}
                                                </span>
                                                <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                                                    <span className="text-xs text-[var(--color-public-muted)]">{formatSize(a.size)}</span>
                                                    <span className="text-xs font-medium text-[var(--color-public-accent)] dark:text-brand-neon-lime">내려받기</span>
                                                </div>
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </AnimateOnScroll>

                    {/* 목록으로 돌아가기 버튼 — 본문 하단 */}
                    <div className="mt-8 text-center">
                        <ReturnLink
                            href="/notices"
                            className="public-btn-secondary text-sm"
                        >
                            목록으로 돌아가기
                        </ReturnLink>
                    </div>
                </div>
            </div>

            {/* CTA 배너 */}
            <CTABanner variant="outline"
                title="궁금한 점이 있으신가요?"
                subtitle="언제든지 편하게 문의해 주세요"
                phone={phone}
                primaryLabel="체험 수업 신청"
                primaryHref="/apply"
            />
        </PublicPageLayout>
    );
}
