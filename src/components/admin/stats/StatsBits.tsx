// 대시보드 카드·통계 탭이 같이 쓰는 작은 화면 부품 — 2026-11-13 대시보드·통계 개편
// 왜 한 곳: 같은 묶음(유니폼 «보유»)이 두 화면에서 다른 색이면 «같은 상태는 같은 색» 규칙(교과서 6장)이 깨진다.
import type { ReactNode } from "react";
import { CHART_COLORS } from "@/components/charts/chartColors";

/** 유니폼 묶음 색 — 보유 초록(정상) · 진행 중 파랑(진행) · 없음 빨강(받을 일) · 확인 필요 주황(주의) · 해당없음 회색 */
export const UNIFORM_COLORS: Record<string, string> = {
    "보유": "var(--color-academy-success)",
    "진행 중": "var(--color-academy-info)",
    "없음": "var(--color-academy-danger)",
    "확인 필요": "var(--color-academy-warning)",
    "해당없음": "var(--color-academy-neutral)",
};

/** 성별 색 — 뜻 없는 계열이라 주 색·중간 회색·옅은 회색 */
export const GENDER_COLORS = {
    male: CHART_COLORS.series,
    female: CHART_COLORS.bar,
    unknown: "var(--color-academy-line)",
};

/** 통계 칸 하나 — 제목 + 내용 + 아래 «기준 한 줄»(무엇을 세었는지) */
export function StatPanel({ title, note, action, children, className = "" }: { title: string; note?: string; action?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={`academy-panel p-3 sm:p-4 ${className}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="academy-section-title">{title}</h2>
                {action}
            </div>
            {children}
            {note && <p className="mt-2 text-xs text-[var(--color-academy-muted)]">{note}</p>}
        </section>
    );
}

/** 숫자 줄의 칸 하나 — 이름(작게) + 숫자(tabular-nums) + 보조 글 */
export function KpiCell({ label, value, sub, tone = "ink" }: { label: string; value: string; sub?: ReactNode; tone?: "ink" | "danger" | "success" }) {
    const color = tone === "danger" ? "text-[var(--color-academy-danger)]" : tone === "success" ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-ink)]";
    return (
        <div className="min-w-0 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2">
            <p className="text-xs font-medium text-[var(--color-academy-muted)]">{label}</p>
            <p className={`text-lg font-semibold tabular-nums ${color}`}>{value}</p>
            {sub && <p className="text-xs text-[var(--color-academy-muted)] tabular-nums">{sub}</p>}
        </div>
    );
}

/** 가로 막대 목록(이름 · 막대 · 숫자) — 학년·지점·프로그램·가입경로처럼 «많고 적음»만 보면 되는 곳 */
export function HBarList({ rows, unit = "명", color = CHART_COLORS.bar, emptyText = "자료가 없습니다" }: { rows: { label: string; count: number; sub?: string }[]; unit?: string; color?: string; emptyText?: string }) {
    if (rows.length === 0) return <p className="py-3 text-sm text-[var(--color-academy-muted)]">{emptyText}</p>;
    const max = Math.max(1, ...rows.map((r) => r.count));
    return (
        <ul className="space-y-1">
            {rows.map((r) => (
                <li key={r.label} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-sm">
                    <span className="break-keep text-[var(--color-academy-ink)]">{r.label}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                        <span className="block h-full rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: color }} />
                    </span>
                    <span className="text-right font-semibold tabular-nums text-[var(--color-academy-ink)]">
                        {r.count}{unit}{r.sub ? <span className="ml-1 text-xs font-normal text-[var(--color-academy-muted)]">{r.sub}</span> : null}
                    </span>
                </li>
            ))}
        </ul>
    );
}
