import Link from "next/link";
import type { EnrollmentShuttleProgress, ShuttleProgressStatus } from "@/lib/enrollment/shuttle-progress";

// 상태별 글자색: 배차 완료 = 정상(초록), 휴원 중 = 보류(회색), 그 외는 기존 강조색 그대로.
function statusTone(status?: ShuttleProgressStatus) {
    if (status === "ASSIGNED") return "text-[var(--color-academy-success)]";
    if (status === "PAUSED") return "text-[var(--color-academy-muted)]";
    return "text-[var(--color-academy-ink)]";
}

export default function EnrollmentShuttleProgressView({ progress, detailed = false }: { progress?: EnrollmentShuttleProgress | null; detailed?: boolean }) {
    const label = progress?.label || "셔틀 상태 확인 필요";
    if (!detailed) return <span className={`text-xs font-medium ${statusTone(progress?.status)}`} title={progress?.detail}>{label}</span>;
    return <section aria-label="셔틀 진행 상태" className="min-w-0 space-y-2 rounded-xl border border-[var(--color-academy-line)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold">셔틀 · <span className={progress?.status === "ASSIGNED" || progress?.status === "PAUSED" ? statusTone(progress.status) : undefined}>{label}</span></h3>{progress && progress.totalCount > 0 && <span className="text-xs tabular-nums">{progress.confirmedCount}/{progress.totalCount} 배차 확정</span>}</div>
        <p className="text-xs text-[var(--color-academy-muted)]">{progress?.serviceMonth && `${progress.serviceMonth} · `}{progress?.detail || "상태를 다시 조회해 주세요. 확인되지 않은 배차와 안내는 완료로 표시하지 않습니다."}</p>
        {progress?.legs?.map(leg => <div key={`${leg.dayOfWeek}-${leg.direction}`} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 border-t border-[var(--color-academy-line)] pt-2 text-xs"><span className="font-medium">{({ Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" } as Record<string,string>)[leg.dayOfWeek] || leg.dayOfWeek} · {leg.direction === "PICKUP" ? "등원" : "하원"}{leg.timeLabel ? ` ${leg.timeLabel}` : ""}</span><span className={leg.status === "ASSIGNED" || leg.status === "PAUSED" ? statusTone(leg.status) : undefined}>{leg.label.split(" · ").at(-1)}</span><p className="basis-full text-[var(--color-academy-muted)]">{leg.detail}</p></div>)}
        {progress && <div className="flex flex-wrap gap-2"><Link prefetch={false} href={progress.rosterHref} className="academy-button-secondary">셔틀 명단 확인</Link><Link prefetch={false} href={progress.dispatchHref} className="academy-button-secondary">배차 확인</Link></div>}
    </section>;
}
