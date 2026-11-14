import { prisma } from "@/lib/prisma";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { notFound } from "next/navigation";
import Link from "next/link";
import FeedPhotoGallery from "@/components/parent/FeedPhotoGallery";
import { SessionVideoList } from "@/components/parent/SessionVideoPlayer";
import { countSessionVideos, listViewableSessionPhotos, loadParentViewableSession } from "@/lib/feed/server";
import { formatKstDate } from "@/lib/datetime/kst";
import { ATTENDANCE_TONE, statusBadgeClass } from "@/lib/ui/statusTones";

// 학부모 리포트 상세는 실시간 데이터 필요 (보안 체크)
export const dynamic = "force-dynamic";

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 출석 상태 라벨/색상
// 출결 상태색 = 공용 지도(statusTones): 출석 정상 · 지각 주의 · 결석 위험
const STATUS_MAP: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: statusBadgeClass(ATTENDANCE_TONE.PRESENT) },
    ABSENT: { label: "결석", color: statusBadgeClass(ATTENDANCE_TONE.ABSENT) },
    LATE: { label: "지각", color: statusBadgeClass(ATTENDANCE_TONE.LATE) },
};

/**
 * 수업 소식 상세(2026-11-14 수업 피드 개편) — 본문·사진(누르면 크게)·영상·우리 아이 출결과 코치 코멘트.
 * 볼 수 있는가는 수업 피드 공용 판정 하나(loadParentViewableSession):
 *   끝났고 발행된 수업 + 그 수업에 참여한 내 아이(출결 기록 또는 그 반 ACTIVE 수강).
 * 사진은 서버에서 «실제로 열리는 것만» 넘긴다(사진 라우트와 같은 판정이라 403 헛요청이 없다).
 */
export default async function ParentReportDetailPage({
    params,
}: {
    params: Promise<{ sessionId: string }>;
}) {
    const { sessionId } = await params;

    // ── 1. 로그인 확인 ──
    // 로그인·학부모 확인은 레이아웃이 이미 한 확인을 그대로 쓴다(요청 단위 기억, 2026-11-14 속도 개선)
    const parentAuth = await requireVerifiedParent().catch(() => null);
    if (!parentAuth) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <h2 className="academy-heading mb-2">로그인이 필요합니다</h2>
                <Link
                    href="/login"
                    className="academy-button-primary mt-4"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // ── 2. 학부모 ID (인증 게이트가 검증한 appUserId) ──
    const parentId = parentAuth.appUserId;
    if (!parentId) notFound();

    // ── 3. 볼 수 있는 수업인가 + 참여한 내 아이(IDOR: 아이는 로그인한 보호자 쪽에서만 찾는다) ──
    const viewable = await loadParentViewableSession(parentId, sessionId);
    if (!viewable) notFound(); // 없는 수업·미발행·내 아이가 참여하지 않은 수업 — 구분하지 않는다
    const { session, children } = viewable;
    const childIds = children.map((c) => c.id);

    // ── 4. 내 아이 출결·코멘트 · 볼 수 있는 사진 · 영상 수 ──
    const [attendances, notes, photoMap, videoCounts] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ studentId: string; status: string }>>(
            `SELECT a."studentId", a.status FROM "Attendance" a
              WHERE a."sessionId" = $1 AND a."studentId" = ANY($2::text[])`,
            sessionId, childIds,
        ),
        prisma.$queryRawUnsafe<Array<{ studentId: string; note: string | null; rating: number | null }>>(
            `SELECT ssn."studentId", ssn.note, ssn.rating FROM "StudentSessionNote" ssn
              WHERE ssn."sessionId" = $1 AND ssn."studentId" = ANY($2::text[])`,
            sessionId, childIds,
        ),
        listViewableSessionPhotos([{ id: session.id, classId: session.classId, photosJSON: session.photosJSON }]),
        countSessionVideos([session.id]),
    ]);
    const statusMap = new Map(attendances.map((a) => [a.studentId, a.status]));
    const noteMap = new Map(notes.map((n) => [n.studentId, n]));
    const photos = photoMap.get(session.id) ?? [];
    const videoCount = videoCounts.get(session.id) ?? 0;

    // 날짜 — KST 달력 문자열(SQL ::date)로 그린다(서버 UTC 에서 새벽 수업이 전날로 보이지 않게).
    const dateStr = formatKstDate(session.ymd, {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
    });
    const dayLabel = session.dayOfWeek ? (DAY_LABELS[session.dayOfWeek] || session.dayOfWeek) : "";

    return (
        <div className="space-y-3">
            {/* 뒤로가기 — 누르는 영역 44px(academy-back-link) */}
            <Link
                href="/mypage/reports"
                className="academy-back-link gap-1 px-2 text-sm text-[var(--color-academy-muted)]"
            >
                <span aria-hidden="true">←</span>
                소식
            </Link>

            {/* 수업 정보 머리 — 제목 1줄 + 날짜·반·시간 1줄 + 담당 */}
            <header className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4">
                <h1 className="academy-heading">{session.topic || "수업 리포트"}</h1>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                    {dateStr} · {session.className}
                    {session.startTime && <span className="tabular-nums"> ({dayLabel} {session.startTime}~{session.endTime})</span>}
                </p>
                {(session.programName || session.coachName) && (
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-[var(--color-academy-faint)]">
                        {session.programName && <span>{session.programName}</span>}
                        {session.coachName && <span>담당 코치: {session.coachName}</span>}
                    </p>
                )}
            </header>

            {/* 내 아이 출결 + 개별 코멘트 — 학부모가 가장 먼저 찾는 칸이라 머리 바로 아래(M-12) */}
            <section aria-labelledby="report-children-heading" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white">
                <h2 id="report-children-heading" className="academy-section-title border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-2">
                    우리 아이 수업 현황
                </h2>
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {children.map((child) => {
                        const status = statusMap.get(child.id);
                        const statusInfo = (status && STATUS_MAP[status]) || { label: "확인 중", color: statusBadgeClass("neutral") };
                        const noteData = noteMap.get(child.id);
                        const rating = noteData?.rating != null ? Number(noteData.rating) : null;
                        return (
                            <li key={child.id} className="px-4 py-3">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-semibold text-[var(--color-academy-ink)]">{child.name}</span>
                                    <span className={`rounded px-2 py-0.5 text-xs ${statusInfo.color}`}>{statusInfo.label}</span>
                                </div>
                                {rating !== null && (
                                    <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-academy-muted)]">
                                        참여도
                                        <span className="text-base leading-none text-[var(--color-academy-ink)]" aria-label={`참여도 ${rating}점`}>
                                            {[1, 2, 3, 4, 5].map((star) => (rating >= star ? "★" : "☆")).join("")}
                                        </span>
                                    </p>
                                )}
                                {noteData?.note && (
                                    <div className="mt-2 rounded-lg bg-[var(--color-academy-soft)] p-3">
                                        <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">코치 코멘트</p>
                                        <p className="whitespace-pre-line text-sm text-[var(--color-academy-muted)]">{noteData.note}</p>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>

            {/* 수업 내용(오늘 수업 한 줄) */}
            {session.content && (
                <section aria-labelledby="report-content-heading" className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4">
                    <h2 id="report-content-heading" className="academy-section-title mb-1.5">수업 내용</h2>
                    <p className="whitespace-pre-line text-sm text-[var(--color-academy-muted)]">{session.content}</p>
                </section>
            )}

            {/* 수업 사진 — 누르면 크게 */}
            {photos.length > 0 && (
                <section aria-labelledby="report-photos-heading" className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4">
                    <h2 id="report-photos-heading" className="academy-section-title mb-2">
                        수업 사진 <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">{photos.length}</span>
                    </h2>
                    <FeedPhotoGallery photos={photos} />
                </section>
            )}

            {/* 수업 영상 — 재생 주소는 화면에서 따로 받아 온다(10분짜리 서명 주소) */}
            {videoCount > 0 && (
                <section aria-labelledby="report-videos-heading" className="rounded-xl border border-[var(--color-academy-line)] bg-white p-4">
                    <h2 id="report-videos-heading" className="academy-section-title mb-2">
                        수업 영상 <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">{videoCount}</span>
                    </h2>
                    <SessionVideoList sessionId={session.id} />
                </section>
            )}
        </div>
    );
}
