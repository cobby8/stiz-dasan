import Link from "next/link";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import { formatKstDate, kstDow } from "@/lib/datetime/kst";

// 학부모 «셔틀 배정 상세» 한 칸 (2026-11-09 홈에서 «일정» 탭으로 옮김).
// 예전엔 홈의 접힌 칸(details) 안에 있어 «안에 뭐가 있는지» 안 보였다. 일정 탭에서는 펼친 채로 보인다.
// 표시 전용 — 데이터는 getParentShuttleOverview 가 고른 칸 그대로(배정 확정·완료일 때만 노선·정류장·차량 공개).

// 상태 뜻은 src/lib/ui/statusTones.ts 와 같다(접수 = 대기 주의 · 준비 중 = 진행 정보 · 확정 = 정상 · 완료 = 중립).
// 이 파일은 테스트가 import 맵으로 불러와서 지도를 import 하지 않고 TONE_BADGE_CLASS 와 같은 글자를 그대로 적는다.
const SHUTTLE_STATUS: Record<ParentShuttleOverviewItem["status"], { label: string; color: string }> = {
    REQUESTED: { label: "신청 접수", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    PREPARING: { label: "배정 준비 중", color: "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]" },
    CONFIRMED: { label: "배정 확정", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    COMPLETED: { label: "운행 완료", color: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]" },
};

const SHUTTLE_DIRECTION = {
    PICKUP: "등원",
    DROPOFF: "하원",
} as const;

const SHUTTLE_RIDE_STATUS: Record<string, string> = {
    PENDING: "탑승 대기",
    BOARDED: "탑승",
    DROPPED_OFF: "하차",
    NO_SHOW: "미탑승",
};

// 서버(UTC) 첫 렌더와 휴대폰(KST) 렌더가 같은 글자를 내도록 날짜는 모두 KST 로 고정한다.
// (timeZone 없는 toLocaleDateString 은 서버에서 하루 전 날짜가 나와 하이드레이션 불일치 #418 이 난다)
export function formatShuttleDate(value: string | null): string {
    if (!value) return "운행일 확인 중";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    // 읽을 수 없는 모양이면 예전처럼 원문을 그대로 보인다(fallback = value).
    return formatKstDate(value, { year: "numeric", month: "long", day: "numeric", weekday: "short" }, value);
}

function formatShuttleTime(value: string | null): string {
    if (!value) return "시간 확인 중";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    // 확정 시간은 UTC로 내려온다. 기기 설정과 무관하게 항상 한국시간으로 보여준다.
    return date.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
/** 월요일부터(일요일은 맨 뒤) */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export type RosterWeekLine = { key: string; studentId: string; dayLabel: string; title: string; text: string };

/**
 * 명단에서 만든 7일 운행 항목(fromRoster)을 «아이 × 요일 × 반» 한 줄로 줄인다(2026-11-14 검수 — 날마다 카드가 늘어지던 것).
 * 줄 글자 «등원 17:45 승차 다산푸르지오 · 하원 19:35 하차 다산푸르지오». 같은 요일이 7일 안에 두 번이면 가까운 날 것.
 */
export function rosterWeekLines(items: ParentShuttleOverviewItem[]): RosterWeekLine[] {
    const groups = new Map<string, { studentId: string; dow: number; title: string; pickup?: ParentShuttleOverviewItem; dropoff?: ParentShuttleOverviewItem }>();
    const sorted = items.filter((i) => i.fromRoster && i.serviceDate).sort((a, b) => String(a.serviceDate).localeCompare(String(b.serviceDate)));
    for (const item of sorted) {
        const dow = kstDow(item.serviceDate!);
        if (!Number.isInteger(dow)) continue;
        const key = `${item.studentId}|${dow}|${item.title}`;
        const g = groups.get(key) ?? { studentId: item.studentId, dow, title: item.title };
        if (item.direction === "PICKUP" && !g.pickup) g.pickup = item;
        if (item.direction === "DROPOFF" && !g.dropoff) g.dropoff = item;
        groups.set(key, g);
    }
    const leg = (name: string, item: ParentShuttleOverviewItem | undefined, eta: string | null | undefined) =>
        item ? [name, eta, item.stopName].filter(Boolean).join(" ") : null;
    return [...groups.entries()]
        .sort(([, a], [, b]) => a.studentId.localeCompare(b.studentId) || WEEK_ORDER.indexOf(a.dow) - WEEK_ORDER.indexOf(b.dow))
        .map(([key, g]) => ({
            key,
            studentId: g.studentId,
            dayLabel: DOW_KO[g.dow],
            title: g.title,
            text: [leg("등원", g.pickup, g.pickup?.pickupEtaLabel), leg("하원", g.dropoff, g.dropoff?.dropoffEtaLabel)].filter(Boolean).join(" · "),
        }));
}

export default function ParentShuttleDetail({
    items,
    driverContact = null,
    childNames = {},
}: {
    items: ParentShuttleOverviewItem[];
    driverContact?: { name: string; phone: string } | null;
    /** studentId → 이름. 자녀가 둘 이상이면 항목마다 누구 셔틀인지 붙인다. */
    childNames?: Record<string, string>;
}) {
    const showChild = new Set(items.map((item) => item.studentId)).size > 1;
    // 명단 항목(7일 운행)은 요일별 한 줄로 줄이고, 자세한 날짜별 일정은 «아이 기록 › 셔틀»에서 본다
    const weekLines = rosterWeekLines(items);
    const rosterChildren = [...new Set(weekLines.map((line) => line.studentId))];
    const cards = items.filter((item) => !item.fromRoster);
    return (
        <section id="mypage-shuttle" aria-labelledby="parent-shuttle-heading" className="academy-panel scroll-mt-24 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="parent-shuttle-heading" className="academy-section-title flex items-center gap-2">
                    셔틀 배정
                    <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">{weekLines.length + cards.length}건</span>
                </h2>
                <div className="flex flex-wrap items-stretch gap-2">
                    {driverContact?.phone && (
                        <a
                            href={`tel:${driverContact.phone.replace(/[^0-9]/g, "")}`}
                            // 보조 버튼(테두리, M-07). 키보드 초점 링은 유지
                            className="academy-button-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-academy-primary)] focus-visible:ring-offset-2"
                            aria-label={`셔틀 기사님 ${driverContact.name}에게 전화하기`}
                        >
                            기사님께 연락 ({driverContact.name})
                        </a>
                    )}
                    <Link href="/mypage/shuttle"
                        className="academy-button-secondary">
                        셔틀 당일 변경
                    </Link>
                </div>
            </div>

            {weekLines.length > 0 && (
                <div className="mb-2 overflow-hidden rounded-xl bg-[var(--color-academy-soft)]">
                    <p className="px-3 pt-2 text-xs font-medium text-[var(--color-academy-muted)]">정규 셔틀 · 요일별(다가오는 7일)</p>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {weekLines.map((line) => (
                            <li key={line.key} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                                <span className="w-8 shrink-0 text-xs text-[var(--color-academy-muted)]">{line.dayLabel}</span>
                                <span className="min-w-0 flex-1 break-keep tabular-nums text-[var(--color-academy-ink)]">
                                    {showChild && childNames[line.studentId] && <span className="mr-1 font-semibold">{childNames[line.studentId]}</span>}
                                    {line.text}
                                    <span className="block text-xs text-[var(--color-academy-muted)]">{line.title}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-x-1 px-1.5 pb-1">
                        {rosterChildren.map((id) => (
                            <Link key={id} href={`/mypage/record?child=${encodeURIComponent(id)}#record-shuttle-heading`} className="academy-button-text whitespace-nowrap">
                                {showChild && childNames[id] ? `${childNames[id]} ` : ""}아이 기록 › 셔틀 ▸
                            </Link>
                        ))}
                    </div>
                </div>
            )}

            <div className="space-y-2">
                {cards.map((item) => {
                    const status = SHUTTLE_STATUS[item.status];
                    const showDetails = item.status === "CONFIRMED" || item.status === "COMPLETED";
                    return (
                        <article key={item.id} className="rounded-xl bg-[var(--color-academy-soft)] p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <p className="text-sm font-semibold text-[var(--color-academy-ink)]">
                                        {showChild && childNames[item.studentId] && <span className="mr-1 text-[var(--color-academy-ink)]">{childNames[item.studentId]}</span>}
                                        {item.title}
                                    </p>
                                    <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
                                        {item.label}{item.direction ? ` · ${SHUTTLE_DIRECTION[item.direction]}` : ""}
                                    </p>
                                </div>
                                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${status.color}`}>{status.label}</span>
                            </div>

                            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                                <dt className="text-[var(--color-academy-muted)]">운행일</dt>
                                <dd className="text-[var(--color-academy-ink)]">
                                    {item.serviceDate ? <time dateTime={item.serviceDate}>{formatShuttleDate(item.serviceDate)}</time> : "운행일 확인 중"}
                                </dd>
                                {/* 셔틀 확정 승·하차 시각(저장된 배차 노선 기준). 방학특강·정규 공통, 값이 있을 때만 노출한다. */}
                                {(item.pickupEtaLabel || item.dropoffEtaLabel) && (
                                    <>
                                        <dt className="text-[var(--color-academy-muted)]">확정 시각</dt>
                                        <dd className="text-[var(--color-academy-ink)]">
                                            {[
                                                item.pickupEtaLabel ? `등원 ${item.pickupEtaLabel}` : null,
                                                item.dropoffEtaLabel ? `하원 ${item.dropoffEtaLabel}` : null,
                                            ].filter(Boolean).join(" · ")}
                                        </dd>
                                    </>
                                )}
                                {showDetails && (
                                    <>
                                        <dt className="text-[var(--color-academy-muted)]">노선</dt>
                                        <dd className="text-[var(--color-academy-ink)]">{item.routeName || "노선 확인 중"}</dd>
                                        <dt className="text-[var(--color-academy-muted)]">
                                            {item.direction === "PICKUP" ? "탑승 장소" : item.direction === "DROPOFF" ? "하차 장소" : "정류장"}
                                        </dt>
                                        <dd className="text-[var(--color-academy-ink)]">
                                            {item.stopName || "정류장 확인 중"}
                                            {item.stopAddress && <span className="mt-0.5 block text-xs font-normal text-[var(--color-academy-muted)]">{item.stopAddress}</span>}
                                        </dd>
                                        <dt className="text-[var(--color-academy-muted)]">확정 시간</dt>
                                        <dd className="text-[var(--color-academy-ink)]">
                                            {item.plannedAt ? <time dateTime={item.plannedAt}>{formatShuttleTime(item.plannedAt)}</time> : "시간 확인 중"}
                                        </dd>
                                        <dt className="text-[var(--color-academy-muted)]">차량</dt>
                                        <dd className="text-[var(--color-academy-ink)]">{item.vehicleName || "차량 확인 중"}</dd>
                                        {item.rideStatus && (
                                            <>
                                                <dt className="text-[var(--color-academy-muted)]">탑승 상태</dt>
                                                <dd className="text-[var(--color-academy-ink)]">
                                                    {SHUTTLE_RIDE_STATUS[item.rideStatus] || "상태 확인 중"}
                                                </dd>
                                            </>
                                        )}
                                    </>
                                )}
                            </dl>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}
