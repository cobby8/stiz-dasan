// 대시보드 맨 위 카드 6개 — 2026-11-13 대시보드·통계 개편(원장 결정표 승인)
// 배치: PC 3열×2줄, 모바일 2열. 카드 높이 ~120px 이하. 큰 숫자는 «재원생» 하나만(주인공 하나 — 컴팩트 UI 규칙).
// 각 카드를 누르면 같은 숫자의 자세한 판(통계 탭)으로 간다.
import Link from "next/link";
import Sparkline, { MiniPairBars } from "@/components/charts/Sparkline";
import StackedBar from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/chartColors";
import { UNIFORM_COLORS } from "@/components/admin/stats/StatsBits";
import { formatKRW, formatPoint, formatRate } from "@/lib/stats/statsRules";
import type { DashboardSummary } from "@/lib/stats/statsTypes";

function Card({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
    return (
        <Link
            href={href}
            prefetch={false}
            className="academy-panel flex min-h-[104px] min-w-0 flex-col gap-1 p-3 transition-colors hover:border-[var(--color-academy-primary)]"
        >
            <span className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--color-academy-muted)]">
                <span>{title}</span>
                <span className="shrink-0 text-[var(--color-academy-primary)]">자세히 →</span>
            </span>
            {children}
        </Link>
    );
}

export default function DashboardSummaryCards({ summary }: { summary: DashboardSummary }) {
    const { students, billing, attendance, flow, funnel, uniform } = summary;
    return (
        <section aria-label="학원 현황 요약" className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {/* ① 재원생 — 이 화면의 주인공(유일한 큰 숫자) */}
            <Card title="재원생" href="/admin/stats?tab=students">
                <span className="text-3xl font-bold leading-tight tabular-nums text-[var(--color-academy-ink)]">{students.active}<span className="ml-0.5 text-base font-semibold">명</span></span>
            </Card>

            {/* ② 이번 달 수납률 — 금액 기준, 미납은 빨강 */}
            <Card title="이번 달 수강료 수납률" href="/admin/stats?tab=billing">
                <span className="text-xl font-semibold tabular-nums text-[var(--color-academy-ink)]">{formatRate(billing.rateAmount)}</span>
                <StackedBar
                    height={6}
                    showLegend={false}
                    unit="원"
                    ariaLabel="이번 달 수강료 수납"
                    segments={[
                        { label: "수납", value: billing.paidAmount, color: CHART_COLORS.success },
                        { label: "미납", value: billing.unpaidAmount, color: CHART_COLORS.danger },
                    ]}
                />
                <span className={`text-xs tabular-nums ${billing.unpaidCount > 0 ? "font-semibold text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
                    미납 {billing.unpaidCount}건 · {formatKRW(billing.unpaidAmount)}
                </span>
            </Card>

            {/* ③ 이번 달 출석률 — 6개월 추이선 + 전월 대비 */}
            <Card title="이번 달 출석률" href="/admin/stats?tab=attendance">
                <span className="flex items-baseline gap-2">
                    <span className="text-xl font-semibold tabular-nums text-[var(--color-academy-ink)]">{formatRate(attendance.rate)}</span>
                    <span className={`text-xs tabular-nums ${attendance.diff !== null && attendance.diff < 0 ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>전월 대비 {formatPoint(attendance.diff)}</span>
                </span>
                <Sparkline values={attendance.series.map((m) => m.rate)} labels={attendance.series.map((m) => m.label)} ariaLabel="최근 6개월 출석률" />
            </Card>

            {/* ④ 이번 달 신규/퇴원 — 6개월 쌍막대(신규 검정·퇴원 빨강) */}
            <Card title="이번 달 신규·퇴원" href="/admin/stats?tab=students">
                <span className="text-xl font-semibold tabular-nums text-[var(--color-academy-ink)]">
                    +{flow.newCount} <span className="text-[var(--color-academy-danger)]">−{flow.leftCount}</span>
                </span>
                <MiniPairBars pairs={flow.series.map((m) => ({ label: m.label, a: m.newCount, b: m.leftCount }))} ariaLabel="최근 6개월 신규·퇴원" />
            </Card>

            {/* ⑤ 체험 → 등록(최근 30일) */}
            <Card title="체험 → 등록 (30일)" href="/admin/stats?tab=funnel">
                <span className="text-xl font-semibold tabular-nums text-[var(--color-academy-ink)]">{formatRate(funnel.rate)}</span>
                <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
                    문의 {funnel.inquiries} → 체험 {funnel.attended} → 등록 <span className="font-semibold text-[var(--color-academy-ink)]">{funnel.converted}</span>
                </span>
            </Card>

            {/* ⑥ 유니폼 보유율 — 분모 = 재원생 전체(원장 결정) */}
            <Card title="유니폼 보유율" href="/admin/stats?tab=uniform">
                <span className="flex items-baseline gap-2">
                    <span className="text-xl font-semibold tabular-nums text-[var(--color-academy-ink)]">{formatRate(uniform.rate)}</span>
                    {uniform.needsCheck > 0 && <span className="text-xs font-medium text-[var(--color-academy-warning)] tabular-nums">확인 필요 {uniform.needsCheck}명</span>}
                </span>
                <StackedBar
                    height={6}
                    showLegend={false}
                    ariaLabel="재원생 유니폼 상태"
                    segments={uniform.segments.map((s) => ({ label: s.label, value: s.count, color: UNIFORM_COLORS[s.label] ?? CHART_COLORS.bar }))}
                />
            </Card>
        </section>
    );
}
