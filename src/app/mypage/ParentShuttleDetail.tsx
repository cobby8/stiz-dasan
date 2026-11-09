import Link from "next/link";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import { formatKstDate } from "@/lib/datetime/kst";

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
    return (
        <section id="mypage-shuttle" aria-labelledby="parent-shuttle-heading" className="academy-panel scroll-mt-24 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="parent-shuttle-heading" className="flex items-center gap-2 font-bold text-[var(--color-academy-ink)]">
                    <span className="material-symbols-outlined leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "20px" }} aria-hidden="true">airport_shuttle</span>
                    셔틀 배정
                    <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">{items.length}건</span>
                </h2>
                <div className="flex flex-wrap items-stretch gap-2">
                    {driverContact?.phone && (
                        <a
                            href={`tel:${driverContact.phone.replace(/[^0-9]/g, "")}`}
                            // 보조 버튼(테두리, M-07). 키보드 초점 링은 유지
                            className="academy-button-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-academy-primary)] focus-visible:ring-offset-2"
                            aria-label={`셔틀 기사님 ${driverContact.name}에게 전화하기`}
                        >
                            <span className="material-symbols-outlined leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "16px" }} aria-hidden="true">call</span>
                            기사님께 연락 ({driverContact.name})
                        </a>
                    )}
                    <Link href="/mypage/shuttle"
                        className="flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-academy-line)] px-3 py-2 text-xs font-bold text-[var(--color-academy-ink)]">
                        셔틀 당일 변경
                    </Link>
                </div>
            </div>

            <div className="space-y-2">
                {items.map((item) => {
                    const status = SHUTTLE_STATUS[item.status];
                    const showDetails = item.status === "CONFIRMED" || item.status === "COMPLETED";
                    return (
                        <article key={item.id} className="rounded-xl bg-[var(--color-academy-soft)] p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <p className="text-sm font-bold text-[var(--color-academy-ink)]">
                                        {showChild && childNames[item.studentId] && <span className="mr-1 font-bold text-[var(--color-academy-ink)]">{childNames[item.studentId]}</span>}
                                        {item.title}
                                    </p>
                                    <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
                                        {item.label}{item.direction ? ` · ${SHUTTLE_DIRECTION[item.direction]}` : ""}
                                    </p>
                                </div>
                                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.color}`}>{status.label}</span>
                            </div>

                            <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                                <dt className="text-[var(--color-academy-muted)]">운행일</dt>
                                <dd className="font-medium text-[var(--color-academy-ink)]">
                                    {item.serviceDate ? <time dateTime={item.serviceDate}>{formatShuttleDate(item.serviceDate)}</time> : "운행일 확인 중"}
                                </dd>
                                {/* 셔틀 확정 승·하차 시각(저장된 배차 노선 기준). 방학특강·정규 공통, 값이 있을 때만 노출한다. */}
                                {(item.pickupEtaLabel || item.dropoffEtaLabel) && (
                                    <>
                                        <dt className="text-[var(--color-academy-muted)]">확정 시각</dt>
                                        <dd className="font-medium text-[var(--color-academy-ink)]">
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
                                        <dd className="font-medium text-[var(--color-academy-ink)]">{item.routeName || "노선 확인 중"}</dd>
                                        <dt className="text-[var(--color-academy-muted)]">
                                            {item.direction === "PICKUP" ? "탑승 장소" : item.direction === "DROPOFF" ? "하차 장소" : "정류장"}
                                        </dt>
                                        <dd className="font-medium text-[var(--color-academy-ink)]">
                                            {item.stopName || "정류장 확인 중"}
                                            {item.stopAddress && <span className="mt-0.5 block text-xs font-normal text-[var(--color-academy-muted)]">{item.stopAddress}</span>}
                                        </dd>
                                        <dt className="text-[var(--color-academy-muted)]">확정 시간</dt>
                                        <dd className="font-medium text-[var(--color-academy-ink)]">
                                            {item.plannedAt ? <time dateTime={item.plannedAt}>{formatShuttleTime(item.plannedAt)}</time> : "시간 확인 중"}
                                        </dd>
                                        <dt className="text-[var(--color-academy-muted)]">차량</dt>
                                        <dd className="font-medium text-[var(--color-academy-ink)]">{item.vehicleName || "차량 확인 중"}</dd>
                                        {item.rideStatus && (
                                            <>
                                                <dt className="text-[var(--color-academy-muted)]">탑승 상태</dt>
                                                <dd className="font-medium text-[var(--color-academy-ink)]">
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
