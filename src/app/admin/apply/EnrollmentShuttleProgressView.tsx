import Link from "next/link";
import type { EnrollmentShuttleProgress } from "@/lib/enrollment/shuttle-progress";

export default function EnrollmentShuttleProgressView({ progress, detailed = false }: { progress?: EnrollmentShuttleProgress | null; detailed?: boolean }) {
    const label = progress?.label || "셔틀 상태 확인 필요";
    if (!detailed) return <span className="text-xs font-bold text-[var(--color-academy-primary)]" title={progress?.detail}>{label}</span>;
    return <section aria-label="셔틀 진행 상태" className="min-w-0 space-y-2 rounded-xl border border-[var(--color-academy-line)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-black">셔틀 · {label}</h3>{progress && progress.totalCount > 0 && <span className="text-xs tabular-nums">{progress.confirmedCount}/{progress.totalCount} 배차 확정</span>}</div>
        <p className="text-xs text-[var(--color-academy-muted)]">{progress?.serviceMonth && `${progress.serviceMonth} · `}{progress?.detail || "상태를 다시 조회해 주세요. 확인되지 않은 배차와 안내는 완료로 표시하지 않습니다."}</p>
        {progress?.legs?.map(leg => <div key={`${leg.dayOfWeek}-${leg.direction}`} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 border-t border-[var(--color-academy-line)] pt-2 text-xs"><span className="font-bold">{({ Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" } as Record<string,string>)[leg.dayOfWeek] || leg.dayOfWeek} · {leg.direction === "PICKUP" ? "등원" : "하원"}{leg.timeLabel ? ` ${leg.timeLabel}` : ""}</span><span>{leg.label.split(" · ").at(-1)}</span><p className="basis-full text-[var(--color-academy-muted)]">{leg.detail}</p></div>)}
        {progress && <div className="flex flex-wrap gap-2"><Link prefetch={false} href={progress.rosterHref} className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-academy-soft)] px-3 text-sm font-bold text-[var(--color-academy-primary)]">셔틀 명단 확인</Link><Link prefetch={false} href={progress.dispatchHref} className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-academy-soft)] px-3 text-sm font-bold text-[var(--color-academy-primary)]">배차 확인</Link></div>}
    </section>;
}
