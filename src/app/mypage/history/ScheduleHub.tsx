import Link from "next/link";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import ParentShuttleDetail from "../ParentShuttleDetail";

// «일정» 탭 윗부분 (2026-11-09 원장 결정 D1 안 A).
// 결석·보강·셔틀·수강 변경 신청과 수강 반·셔틀 배정을 한 화면에 모은다. 아래에는 기존 출결·수납 기록이 이어진다.
// 예전엔 이 길들이 홈의 접힌 칸(결석·보강 신청 · 셔틀 배정 상세 · 수강·출결·수납 기록) 셋에 흩어져 있었고,
// 홈 타일 «결석·보강»을 누르면 홈 맨 아래로 뛰어 접힌 칸을 강제로 펼쳤다.
// 표시 전용 — 쓰기 없음. 주소는 전부 기존 화면 그대로(문자로 나간 링크가 안 깨진다).

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

export type ScheduleChild = {
    id: string;
    name: string;
    enrollments: {
        id: string;
        className: string;
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        programName?: string | null;
        displayStatus?: string;
        startsOn?: string | null;
        startsLater?: boolean;
    }[];
};

function Icon({ name, className = "" }: { name: string; className?: string }) {
    return <span className={`material-symbols-outlined leading-none ${className}`} style={{ fontSize: "20px" }} aria-hidden="true">{name}</span>;
}

export default function ScheduleHub({
    childList,
    shuttleItems,
    driverContact = null,
    makeupAvailable = 0,
    seasonalUpcoming = 0,
}: {
    childList: ScheduleChild[];
    shuttleItems: ParentShuttleOverviewItem[];
    driverContact?: { name: string; phone: string } | null;
    /** 지금 쓸 수 있는 보강권 수(자녀 전체) */
    makeupAvailable?: number;
    /** 앞으로 남은 방학특강 회차 수 — 0 이면 방학특강 줄을 숨긴다(방학 기간에만 보이게, D6) */
    seasonalUpcoming?: number;
}) {
    const showChildName = childList.length > 1;
    const childNames = Object.fromEntries(childList.map((c) => [c.id, c.name]));
    const enrollmentRows = childList.flatMap((c) => c.enrollments.map((e) => ({ child: c, e })));

    // 신청 줄 — 한 줄 행(제목 + 짧은 설명). 꽉 찬 버튼은 쓰지 않는다(이 화면의 주인공은 목록).
    const actions: { href: string; icon: string; title: string; desc: string; badge?: string }[] = [
        { href: "/mypage/regular-absence", icon: "edit_calendar", title: "정규수업 결석 신고", desc: "날짜와 사유를 골라 신고하세요. 신고한 결석은 선생님과 기사님에게 표시됩니다." },
        { href: "/mypage/makeup", icon: "event_repeat", title: "보강 예약", desc: "결석하면 보강권이 생겨요. 학년이 맞는 다른 수업을 직접 예약하세요.", badge: makeupAvailable > 0 ? `보강권 ${makeupAvailable}장` : undefined },
        ...(seasonalUpcoming > 0
            ? [{ href: "/mypage/seasonal", icon: "sports_basketball", title: "방학특강 결석 신고 · 보강", desc: "신고한 결석은 선생님과 기사님에게 표시됩니다. 보강도 신청할 수 있습니다.", badge: `남은 ${seasonalUpcoming}회` }]
            : []),
        { href: "/mypage/shuttle", icon: "airport_shuttle", title: "셔틀 당일 변경", desc: "수업은 오지만 셔틀만 바꿀 때" },
        { href: "/mypage/enrollment-change", icon: "swap_horiz", title: "수강 변경 신청", desc: "반 변경·휴원·퇴원 신청" },
    ];

    return (
        <div className="mb-6 space-y-4">
            <div>
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">일정</h1>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">수업·결석·보강·셔틀과 출결 기록을 한곳에서 확인하세요.</p>
            </div>

            {/* 신청 — 결석·보강·셔틀·수강 변경 */}
            <nav aria-label="일정 신청" className="academy-panel overflow-hidden">
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {actions.map((a) => (
                        <li key={a.href}>
                            <Link href={a.href} className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-[var(--color-academy-soft)]">
                                <Icon name={a.icon} className="shrink-0 text-[var(--color-academy-primary)]" />
                                <span className="min-w-0 flex-1">
                                    <span className="block break-keep text-sm font-bold text-[var(--color-academy-ink)]">{a.title}</span>
                                    <span className="block text-xs text-[var(--color-academy-muted)]">{a.desc}</span>
                                </span>
                                {a.badge && (
                                    <span className="shrink-0 rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-xs font-bold tabular-nums text-[var(--color-academy-primary)]">{a.badge}</span>
                                )}
                                <Icon name="chevron_right" className="shrink-0 text-[var(--color-academy-muted)]" />
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>

            {/* 수강 반 — 한 줄 행(반 이름 · 요일 시간 오른쪽) */}
            {enrollmentRows.length > 0 && (
                <section id="mypage-enrollments" aria-labelledby="schedule-enrollments-heading" className="academy-panel scroll-mt-24 overflow-hidden">
                    <h2 id="schedule-enrollments-heading" className="border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">
                        수강 반 <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{enrollmentRows.length}</span>
                    </h2>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {enrollmentRows.map(({ child, e }) => (
                            <li key={`${child.id}-${e.id}`} className="flex min-h-11 items-center gap-2 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="break-keep text-sm font-bold text-[var(--color-academy-ink)]">
                                        {showChildName && <span className="mr-1 text-[var(--color-academy-primary)]">{child.name}</span>}
                                        {e.className}
                                    </p>
                                    {/* 2026-11-09 새 기준: 승인된 반은 개시일 전에도 수강 중 — 첫 수업 전이면 개시일만 안내 */}
                                    {e.startsLater && <p className="text-xs font-bold text-[var(--color-academy-primary)]">{e.startsOn}부터 수업 시작</p>}
                                </div>
                                <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-muted)]">
                                    {DAY_LABELS[e.dayOfWeek] || e.dayOfWeek} {e.startTime}~{e.endTime}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* 셔틀 배정 — 예전 홈 접힌 칸의 내용 그대로, 펼친 채로 */}
            {shuttleItems.length > 0 && (
                <ParentShuttleDetail items={shuttleItems} driverContact={driverContact} childNames={childNames} />
            )}
        </div>
    );
}
