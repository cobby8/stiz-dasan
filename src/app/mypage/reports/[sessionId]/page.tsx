import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { notFound } from "next/navigation";
import { notMergedStudent } from "@/lib/studentVisibility";
import Link from "next/link";
import ReportPhoto from "@/components/parent/ReportPhoto";
import { toSessionReportPhotoViews } from "@/lib/sessionPhotoEntries";

// 학부모 리포트 상세는 실시간 데이터 필요 (보안 체크)
export const dynamic = "force-dynamic";

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 출석 상태 라벨/색상
const STATUS_MAP: Record<string, { label: string; color: string }> = {
    PRESENT: { label: "출석", color: "bg-green-100 text-green-700" },
    ABSENT: { label: "결석", color: "bg-red-100 text-red-700" },
    LATE: { label: "지각", color: "bg-yellow-100 text-yellow-700" },
};

export default async function ParentReportDetailPage({
    params,
}: {
    params: Promise<{ sessionId: string }>;
}) {
    const { sessionId } = await params;

    // ── 1. 로그인 확인 ──
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">로그인이 필요합니다</h2>
                <Link
                    href="/login"
                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold px-6 py-3 rounded-xl hover:bg-orange-600 transition mt-4"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // ── 2. 학부모 ID 조회 (인증 게이트가 검증한 appUserId 사용) ──
    // 이메일 매칭 제거 — 소셜/이메일 불일치 시 자녀를 못 찾던 버그 수정
    const parentAuth = await requireVerifiedParent();
    const parentId = parentAuth.appUserId;
    if (!parentId) notFound();

    // ── 3. 세션이 발행 상태인지 확인 ──
    const sessionRows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT se.id, se.date, se.topic, se.content, se."photosJSON",
                se.published, se."publishedAt",
                c.name AS class_name, c."dayOfWeek", c."startTime", c."endTime",
                p.name AS program_name,
                co.name AS coach_name
         FROM "Session" se
         JOIN "Class" c ON se."classId" = c.id
         LEFT JOIN "Program" p ON c."programId" = p.id
         LEFT JOIN "Coach" co ON se."coachId" = co.id
         WHERE se.id = $1 AND se.published = true`,
        sessionId
    );
    if (!sessionRows[0]) notFound(); // 미발행 또는 존재하지 않는 세션
    const session = sessionRows[0];

    // ── 4. 보안: 내 자녀가 이 세션에 출석했는지 확인 ──
    // 내 자녀 ID 목록 조회
    const myStudents = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, name FROM "Student" s WHERE s."parentId" = $1 AND ${notMergedStudent("s")}`,
        parentId
    );
    if (myStudents.length === 0) notFound();
    const myStudentIds = myStudents.map((s: any) => s.id);

    // 이 세션에 내 자녀가 출석했는지 확인
    const placeholders = myStudentIds.map((_: string, i: number) => `$${i + 2}`).join(",");
    const myAttendances = await prisma.$queryRawUnsafe<any[]>(
        `SELECT a."studentId", a.status, s.name AS student_name
         FROM "Attendance" a
         JOIN "Student" s ON a."studentId" = s.id
         WHERE a."sessionId" = $1 AND a."studentId" IN (${placeholders})
         ORDER BY s.name ASC`,
        sessionId,
        ...myStudentIds
    );
    // 내 자녀가 이 세션에 없으면 접근 거부
    if (myAttendances.length === 0) notFound();

    // ── 5. 내 자녀의 개별 노트 조회 ──
    const myNotes = await prisma.$queryRawUnsafe<any[]>(
        `SELECT ssn."studentId", ssn.note, ssn.rating
         FROM "StudentSessionNote" ssn
         WHERE ssn."sessionId" = $1 AND ssn."studentId" IN (${placeholders})`,
        sessionId,
        ...myStudentIds
    );
    const noteMap = new Map(myNotes.map((n: any) => [n.studentId ?? n.studentid, n]));

    // 사진 파싱
    const photos = toSessionReportPhotoViews(session.photosJSON ?? session.photosjson, sessionId);

    // 날짜 포맷
    const dateStr = new Date(session.date).toLocaleDateString("ko-KR", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
    });

    return (
        <div>
            {/* 뒤로가기 */}
            <Link
                href="/mypage/reports"
                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-200 flex items-center gap-1 mb-4"
            >
                <span className="material-symbols-outlined text-sm">arrow_back</span>
                리포트 목록
            </Link>

            {/* 수업 정보 헤더 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 mb-4">
                <h1 className="text-xl font-extrabold text-gray-900 dark:text-white">
                    {session.topic || "수업 리포트"}
                </h1>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {dateStr} | {session.class_name} ({DAY_LABELS[session.dayOfWeek ?? session.dayofweek] || (session.dayOfWeek ?? session.dayofweek)} {session.startTime ?? session.starttime}~{session.endTime ?? session.endtime})
                </p>
                {(session.program_name) && (
                    <p className="text-xs text-gray-400 mt-0.5">{session.program_name}</p>
                )}
                {(session.coach_name) && (
                    <p className="text-xs text-gray-400 mt-0.5">담당 코치: {session.coach_name}</p>
                )}
            </div>

            {/* 수업 내용 */}
            {(session.content) && (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 mb-4">
                    <h2 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-2 flex items-center gap-1">
                        <span className="material-symbols-outlined text-base">description</span>
                        수업 내용
                    </h2>
                    <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-line">{session.content}</p>
                </div>
            )}

            {/* 수업 사진 */}
            {photos.length > 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 mb-4">
                    <h2 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-1">
                        <span className="material-symbols-outlined text-base">photo_library</span>
                        수업 사진
                    </h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {photos.map((photo, i) => (
                            <ReportPhoto
                                key={`${photo.index}:${photo.src}`}
                                src={photo.src}
                                alt={`수업 사진 ${i + 1}`}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* 내 자녀 출석 + 개별 코멘트 */}
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="p-5 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                    <h2 className="text-sm font-bold text-gray-700 dark:text-gray-200 flex items-center gap-1">
                        <span className="material-symbols-outlined text-base">school</span>
                        우리 아이 수업 현황
                    </h2>
                </div>

                <div className="divide-y divide-gray-100">
                    {myAttendances.map((a: any) => {
                        const studentId = a.studentId ?? a.studentid;
                        const statusInfo = STATUS_MAP[a.status] || { label: a.status, color: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400" };
                        const noteData = noteMap.get(studentId);
                        const rating = noteData?.rating != null ? Number(noteData.rating) : null;

                        return (
                            <div key={studentId} className="px-5 py-4">
                                {/* 학생 이름 + 출석 상태 */}
                                <div className="flex items-center justify-between mb-2">
                                    <span className="font-bold text-gray-900 dark:text-white">{a.student_name}</span>
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${statusInfo.color}`}>
                                        {statusInfo.label}
                                    </span>
                                </div>

                                {/* 참여도 평점 */}
                                {rating !== null && (
                                    <div className="flex items-center gap-1 mb-2">
                                        <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">참여도:</span>
                                        <div className="flex gap-0.5">
                                            {[1, 2, 3, 4, 5].map((star) => (
                                                <span
                                                    key={star}
                                                    className={`material-symbols-outlined text-base ${
                                                        rating >= star ? "text-yellow-400" : "text-gray-300"
                                                    }`}
                                                    style={{
                                                        fontVariationSettings:
                                                            rating >= star ? "'FILL' 1" : "'FILL' 0",
                                                    }}
                                                >
                                                    star
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 코치 코멘트 */}
                                {noteData?.note && (
                                    <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 mt-1">
                                        <p className="text-xs text-gray-500 dark:text-gray-400 font-bold mb-1">코치 코멘트</p>
                                        <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-line">{noteData.note}</p>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
