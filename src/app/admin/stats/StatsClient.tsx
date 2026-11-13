"use client";

// 통계 화면 — 2026-11-13 대시보드·통계 개편(원장 결정표 6칸 «추천대로» 승인)
// 구성: 머리 한 줄(제목 «통계» + «필터(n)» 버튼) → 탭 5개(원생|유입·전환|수업·출결|수납|유니폼) → 그 탭 내용.
//   - 탭·지점·기간은 주소(?tab=&branch=&period=)에 있다. 바꾸면 주소가 바뀌고 서버가 그 탭만 다시 읽는다.
//   - 히어로 없음, 필터는 버튼 하나 + 창(모바일은 아래 시트) — 전역 «컴팩트 UI 규칙».
//   - 숫자는 명/건/정수%, 분모 0 → «–», 금액 1만원 이상 «42.5만원», 칸 아래에 «무엇을 세었는지» 한 줄.
import { useMemo, useState, useTransition, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LineChart from "@/components/charts/LineChart";
import DonutChart from "@/components/charts/DonutChart";
import StackedBar from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/chartColors";
import AdminModal from "@/components/admin/AdminModal";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { GENDER_COLORS, HBarList, KpiCell, StatPanel, UNIFORM_COLORS } from "@/components/admin/stats/StatsBits";
import {
    STATS_BRANCHES,
    STATS_PERIODS,
    STATS_TABS,
    UNIFORM_GROUPS,
    formatKRW,
    formatPoint,
    formatRate,
    rate,
    type StatsBranchKey,
    type StatsTabKey,
} from "@/lib/stats/statsRules";
import { sourceLabel } from "@/lib/stats/sourceLabels";
import type {
    StatsAttendanceTab,
    StatsBillingTab,
    StatsFunnelTab,
    StatsStudentsTab,
    StatsTabPayload,
    StatsUniformTab,
} from "@/lib/stats/statsTypes";

/** 주소 만들기 — 기본값(전체 지점·탭 첫 기간)은 주소에서 뺀다 */
function statsHref(tab: StatsTabKey, branch: StatsBranchKey, period: string) {
    const params = new URLSearchParams({ tab });
    if (branch !== "all") params.set("branch", branch);
    const defaultPeriod = STATS_PERIODS[tab][0]?.key ?? "";
    if (period && period !== defaultPeriod) params.set("period", period);
    return `/admin/stats?${params.toString()}`;
}

export default function StatsClient({
    tab,
    branch,
    period,
    data,
}: {
    tab: StatsTabKey;
    branch: StatsBranchKey;
    period: string;
    data: StatsTabPayload | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [filterOpen, setFilterOpen] = useState(false);
    const defaultPeriod = STATS_PERIODS[tab][0]?.key ?? "";
    // 필터 버튼 숫자 = 기본값과 다른 항목 수
    const filterCount = (branch !== "all" ? 1 : 0) + (period && period !== defaultPeriod ? 1 : 0);
    const branchName = STATS_BRANCHES.find((b) => b.key === branch)?.label ?? "전체";
    const periodName = STATS_PERIODS[tab].find((p) => p.key === period)?.label ?? "";

    // 탭·필터를 바꿀 때 «불러오는 중»을 보이려고 router.push 를 transition 안에서 부른다(가운데 클릭은 그대로 새 탭)
    function go(href: string, event?: MouseEvent) {
        if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)) return;
        event?.preventDefault();
        startTransition(() => router.push(href));
    }

    return (
        <div className="mx-auto max-w-7xl space-y-3">
            {/* 머리 한 줄 — 제목 + 지금 거른 조건 + 필터 버튼 */}
            <AdminPageHeader
                title="통계"
                description={(
                    <>
                        {branchName}{periodName ? ` · ${periodName}` : ""}
                        {pending && <span role="status" className="ml-2 font-medium text-[var(--color-academy-info)]">불러오는 중…</span>}
                    </>
                )}
                actions={(
                    <button type="button" onClick={() => setFilterOpen(true)} className="academy-button-secondary" aria-haspopup="dialog">
                        필터{filterCount > 0 ? ` ${filterCount}` : ""}
                    </button>
                )}
            />

            <nav aria-label="통계 탭" className="flex gap-2 overflow-x-auto">
                {STATS_TABS.map((t) => {
                    const on = t.key === tab;
                    // 탭을 바꾸면 기간은 그 탭의 기본값으로(탭마다 기간의 뜻이 다르다), 지점은 유지
                    const href = statsHref(t.key, branch, "");
                    return (
                        <Link
                            key={t.key}
                            href={href}
                            prefetch={false}
                            onClick={(e) => go(href, e)}
                            aria-current={on ? "page" : undefined}
                            className={`academy-choice is-tab shrink-0 whitespace-nowrap${on ? " is-selected" : ""}`}
                        >
                            {t.label}
                        </Link>
                    );
                })}
            </nav>

            <div className={pending ? "opacity-60 transition-opacity" : ""}>
                {!data ? (
                    <div role="alert" className="academy-panel p-6 text-center text-sm font-medium text-[var(--color-academy-danger)]">
                        통계를 불러오지 못했습니다.
                        <button type="button" onClick={() => go(statsHref(tab, branch, period))} className="academy-button-secondary ml-3">다시 시도</button>
                    </div>
                ) : data.tab === "students" ? (
                    <StudentsView d={data} />
                ) : data.tab === "funnel" ? (
                    <FunnelView d={data} branchFiltered={branch !== "all"} />
                ) : data.tab === "attendance" ? (
                    <AttendanceView d={data} branchFiltered={branch !== "all"} />
                ) : data.tab === "billing" ? (
                    <BillingView d={data} />
                ) : (
                    <UniformView d={data} />
                )}
            </div>

            {filterOpen && (
                <FilterSheet
                    tab={tab}
                    branch={branch}
                    period={period}
                    onClose={() => setFilterOpen(false)}
                    onApply={(nextBranch, nextPeriod) => {
                        setFilterOpen(false);
                        go(statsHref(tab, nextBranch, nextPeriod));
                    }}
                />
            )}
        </div>
    );
}

// ── 필터 창(모바일 아래 시트) ────────────────────────────────────────────

function FilterSheet({
    tab,
    branch,
    period,
    onClose,
    onApply,
}: {
    tab: StatsTabKey;
    branch: StatsBranchKey;
    period: string;
    onClose: () => void;
    onApply: (branch: StatsBranchKey, period: string) => void;
}) {
    const [nextBranch, setNextBranch] = useState<StatsBranchKey>(branch);
    const [nextPeriod, setNextPeriod] = useState(period);
    const periods = STATS_PERIODS[tab];
    // 고른 칩 = 보조 색(테마 academy-choice is-tab — 꽉 찬 검정 금지)
    const chip = (on: boolean) => `academy-choice is-tab${on ? " is-selected" : ""}`;

    return (
        <AdminModal onClose={onClose} titleId="stats-filter-title" panelClassName="max-w-md">
            <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-4 py-3">
                <h2 id="stats-filter-title" className="academy-section-title">필터</h2>
                <button type="button" onClick={onClose} className="academy-button-text academy-button-sm">닫기</button>
            </div>
            <div className="space-y-5 px-4 py-4">
                <fieldset>
                    <legend className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">지점</legend>
                    <div className="flex flex-wrap gap-2">
                        {STATS_BRANCHES.map((b) => (
                            <button key={b.key} type="button" aria-pressed={nextBranch === b.key} onClick={() => setNextBranch(b.key)} className={chip(nextBranch === b.key)}>
                                {b.label}
                            </button>
                        ))}
                    </div>
                    {tab === "funnel" && <p className="mt-2 text-xs text-[var(--color-academy-muted)]">체험 문의·신청서에는 지점이 없어, 지점은 «재원생 가입경로»에만 적용돼요.</p>}
                </fieldset>
                {periods.length > 0 && (
                    <fieldset>
                        <legend className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">기간</legend>
                        <div className="flex flex-wrap gap-2">
                            {periods.map((p) => (
                                <button key={p.key} type="button" aria-pressed={nextPeriod === p.key} onClick={() => setNextPeriod(p.key)} className={chip(nextPeriod === p.key)}>
                                    {p.label}
                                </button>
                            ))}
                        </div>
                    </fieldset>
                )}
            </div>
            <div className="flex gap-2 border-t border-[var(--color-academy-line)] px-4 py-3">
                <button type="button" onClick={() => { setNextBranch("all"); setNextPeriod(periods[0]?.key ?? ""); }} className="academy-button-secondary">
                    초기화
                </button>
                <button type="button" onClick={() => onApply(nextBranch, nextPeriod)} className="academy-button-primary flex-1">
                    적용
                </button>
            </div>
        </AdminModal>
    );
}

// ── 작은 그림들 ────────────────────────────────────────────────────────

/** 세로 막대(금액 등) — 막대 위에 값 글자. 값이 0이면 글자를 비운다 */
function ColumnChart({ rows, format, color = CHART_COLORS.series, ariaLabel }: { rows: { label: string; value: number }[]; format: (v: number) => string; color?: string; ariaLabel: string }) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return (
        <div role="img" aria-label={`${ariaLabel}: ${rows.map((r) => `${r.label} ${format(r.value)}`).join(", ")}`} className="flex h-36 items-end gap-1">
            {rows.map((r) => (
                <div key={r.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                    <span className="hidden text-xs tabular-nums text-[var(--color-academy-muted)] sm:block">{r.value > 0 ? format(r.value) : ""}</span>
                    <span className="w-full max-w-8 rounded-t" style={{ height: `${(r.value / max) * 100}%`, minHeight: r.value > 0 ? 2 : 0, background: color }} />
                    <span className="whitespace-nowrap text-xs text-[var(--color-academy-muted)]">{r.label}</span>
                </div>
            ))}
        </div>
    );
}

/** 월별 신규·퇴원 겹친 막대(검정 = 신규, 빨강 = 퇴원) */
function FlowChart({ rows }: { rows: { label: string; newCount: number; leftCount: number }[] }) {
    const max = Math.max(1, ...rows.flatMap((r) => [r.newCount, r.leftCount]));
    return (
        <div>
            <div role="img" aria-label={`월별 신규·퇴원: ${rows.map((r) => `${r.label} 신규 ${r.newCount} 퇴원 ${r.leftCount}`).join(", ")}`} className="flex h-32 items-end gap-1">
                {rows.map((r) => (
                    <div key={r.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
                        <span className="flex h-full w-full items-end justify-center gap-0.5">
                            <span className="w-1/2 max-w-3 rounded-t" style={{ height: `${(r.newCount / max) * 100}%`, minHeight: r.newCount > 0 ? 2 : 0, background: CHART_COLORS.series }} title={`${r.label} 신규 ${r.newCount}명`} />
                            <span className="w-1/2 max-w-3 rounded-t" style={{ height: `${(r.leftCount / max) * 100}%`, minHeight: r.leftCount > 0 ? 2 : 0, background: CHART_COLORS.danger }} title={`${r.label} 퇴원 ${r.leftCount}명`} />
                        </span>
                        <span className="whitespace-nowrap text-xs text-[var(--color-academy-muted)]">{r.label}</span>
                    </div>
                ))}
            </div>
            <p className="mt-1 flex gap-3 text-xs text-[var(--color-academy-muted)]">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: CHART_COLORS.series }} aria-hidden="true" />신규</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: CHART_COLORS.danger }} aria-hidden="true" />퇴원</span>
            </p>
        </div>
    );
}

/** 비율 줄(이름 · 막대 · 정수% (분자/분모)) — 지점별·학년별 보유율 */
function RateRows({ rows }: { rows: { label: string; owned: number; total: number; rate: number | null }[] }) {
    if (rows.length === 0) return <p className="py-3 text-sm text-[var(--color-academy-muted)]">자료가 없습니다</p>;
    return (
        <ul className="space-y-1">
            {rows.map((r) => (
                <li key={r.label} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-sm">
                    <span className="text-[var(--color-academy-ink)]">{r.label}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                        <span className="block h-full rounded-full" style={{ width: `${r.rate ?? 0}%`, background: CHART_COLORS.success }} />
                    </span>
                    <span className="text-right tabular-nums">
                        <span className="font-semibold text-[var(--color-academy-ink)]">{formatRate(r.rate)}</span>
                        <span className="ml-1 text-xs text-[var(--color-academy-muted)]">{r.owned}/{r.total}</span>
                    </span>
                </li>
            ))}
        </ul>
    );
}

const ymText = (ym: string | null) => (ym ? `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월` : "");

// ── 원생 ──────────────────────────────────────────────────────────────

function StudentsView({ d }: { d: StatsStudentsTab }) {
    const genderSegments = (g: { male: number; female: number; unknown: number }) => [
        { label: "남", value: g.male, color: GENDER_COLORS.male },
        { label: "여", value: g.female, color: GENDER_COLORS.female },
        { label: "미입력", value: g.unknown, color: GENDER_COLORS.unknown },
    ];
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
                <KpiCell label="재원생" value={`${d.active}명`} />
                <KpiCell label="이번 달 신규" value={`${d.newThisMonth}명`} />
                <KpiCell label="이번 달 퇴원" value={`${d.leftThisMonth}명`} tone={d.leftThisMonth > 0 ? "danger" : "ink"} />
            </div>
            <div className="grid items-start gap-2 lg:grid-cols-2">
                <StatPanel
                    title="학년 구성"
                    note="학년 = 생년월일·3월 학년도 기준(1·2월은 전년도) · 재원생"
                    action={d.gradeNeedsCheck > 0 ? (
                        <span className="rounded px-2 py-0.5 text-xs text-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)]" title="원생 칸에 적힌 학년과 생년월일로 계산한 학년이 다른 원생">
                            학년 확인 필요 {d.gradeNeedsCheck}명
                        </span>
                    ) : undefined}
                >
                    <HBarList rows={d.grades} />
                </StatPanel>
                <StatPanel title="성비" note="재원생 · 원생 칸 «성별» 기준(남자·남·MALE 등 표기는 하나로 모음)">
                    <StackedBar segments={genderSegments(d.genderTotal)} ariaLabel="전체 성비" />
                    <ul className="mt-3 space-y-1.5">
                        {d.genderByBand.map((row) => (
                            <li key={row.band} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2 text-sm">
                                <span className="text-[var(--color-academy-ink)]">{row.band}</span>
                                <StackedBar height={8} showLegend={false} segments={genderSegments(row)} ariaLabel={`${row.band} 성비`} />
                                <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">남 {row.male} · 여 {row.female}{row.unknown ? ` · ? ${row.unknown}` : ""}</span>
                            </li>
                        ))}
                    </ul>
                </StatPanel>
                <StatPanel title="지점별 재원생" note="지점 = 원생 칸 «지점» → 비어 있으면 수강 반 장소 → 그래도 없으면 미지정">
                    <StackedBar
                        segments={d.branches.map((b, i) => ({ label: `${b.label} ${formatRate(rate(b.count, d.active))}`, value: b.count, color: [CHART_COLORS.series, CHART_COLORS.bar, "var(--color-academy-line)", "var(--color-academy-faint)"][i] ?? CHART_COLORS.bar }))}
                        ariaLabel="지점별 재원생"
                    />
                </StatPanel>
                <StatPanel title="신규·퇴원 (월별)" note={`원생 단위 · 신규 = 첫 수강 달, 퇴원 = 수강이 모두 끝난 달 · 사이트 기록 시작${d.flowSince ? `(${ymText(d.flowSince)})` : ""} 이후`}>
                    <FlowChart rows={d.flow} />
                </StatPanel>
                <StatPanel title="프로그램별 원생" note="재원생의 수강 중인 프로그램(두 프로그램을 들으면 양쪽에 셈)">
                    <HBarList rows={d.programs} emptyText="수강 중인 프로그램이 없습니다" />
                </StatPanel>
                <StatPanel title="최근 7일 신규 원생" note="원생 등록일 기준 · 최대 10명">
                    {d.recent.length === 0 ? (
                        <p className="py-2 text-sm text-[var(--color-academy-muted)]">최근 등록된 원생이 없습니다.</p>
                    ) : (
                        <ul className="divide-y divide-[var(--color-academy-line)]">
                            {d.recent.map((s) => (
                                <li key={s.id}>
                                    <Link href={`/admin/students/${s.id}`} prefetch={false} className="flex min-h-11 items-center gap-3 rounded-lg px-1 text-sm hover:bg-[var(--color-academy-soft)]">
                                        <span className="font-semibold text-[var(--color-academy-ink)]">{s.name}</span>
                                        <span className="min-w-0 flex-1 text-xs text-[var(--color-academy-muted)]">학부모 {s.parentName ?? "-"}</span>
                                        <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">{s.createdLabel.replace("-", "/")}</span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </StatPanel>
            </div>
        </div>
    );
}

// ── 유입·전환 ─────────────────────────────────────────────────────────

const TRIAL_STATUS_CELLS: { key: keyof StatsFunnelTab["trialStatus"]; label: string }[] = [
    { key: "NEW", label: "신규" },
    { key: "CONTACTED", label: "연락완료" },
    { key: "SCHEDULED", label: "체험예정" },
    { key: "ATTENDED", label: "체험완료" },
    { key: "CONVERTED", label: "등록전환" },
    { key: "LOST", label: "이탈" },
];

function FunnelView({ d, branchFiltered }: { d: StatsFunnelTab; branchFiltered: boolean }) {
    const maxTotal = d.sources.reduce((max, row) => Math.max(max, row.total), 0);
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiCell label="체험 문의" value={`${d.inquiries}건`} />
                <KpiCell label="체험 참석" value={`${d.attended}건`} sub={formatRate(rate(d.attended, d.inquiries))} />
                <KpiCell label="등록" value={`${d.converted}건`} />
                <KpiCell label="전환율" value={formatRate(d.conversionRate)} sub="등록 ÷ 문의" />
            </div>
            <div className="grid items-start gap-2 lg:grid-cols-2">
                <StatPanel title="단계" note={`체험 참석 = 체험완료·등록전환 · 같은 기간 수강신청 ${d.applications}건(승인 ${d.approved}건)`}>
                    <HBarList
                        unit="건"
                        color={CHART_COLORS.series}
                        rows={[
                            { label: "문의", count: d.inquiries },
                            { label: "체험 참석", count: d.attended, sub: formatRate(rate(d.attended, d.inquiries)) },
                            { label: "등록", count: d.converted, sub: formatRate(rate(d.converted, d.inquiries)) },
                        ]}
                    />
                </StatPanel>
                <StatPanel title="체험 상태" note={d.trialStatus.CANCELLED > 0 ? `취소 ${d.trialStatus.CANCELLED}건은 따로 셈` : "기간 안에 접수된 체험 문의의 지금 상태"}>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                        {TRIAL_STATUS_CELLS.map((c) => (
                            <div key={c.key} className="rounded-lg bg-[var(--color-academy-soft)] px-2 py-1.5 text-center">
                                <p className="text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{d.trialStatus[c.key]}</p>
                                <p className="text-xs text-[var(--color-academy-muted)]">{c.label}</p>
                            </div>
                        ))}
                    </div>
                </StatPanel>
            </div>
            {/* 신청 화면 «유입 통계» 탭에 있던 표를 옮겨 왔다(같은 쿼리·같은 라벨) */}
            <StatPanel title="유입경로별" note="체험 문의 + 수강신청 · 등록 = 등록전환 + 승인 · 신청서에 고른 경로 기준">
                <div className="-mx-3 overflow-x-auto sm:-mx-4">
                    <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                        <thead className="bg-[var(--color-academy-soft)] text-xs font-medium text-[var(--color-academy-muted)]">
                            <tr>
                                <th className="px-3 py-2">유입경로</th>
                                <th className="px-3 py-2 text-right">전체</th>
                                <th className="px-3 py-2 text-right">체험</th>
                                <th className="px-3 py-2 text-right">수강신청</th>
                                <th className="px-3 py-2 text-right">등록</th>
                                <th className="px-3 py-2 text-right">전환율</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-academy-line)] tabular-nums">
                            {d.sources.length === 0 ? (
                                <tr><td colSpan={6} className="px-3 py-6 text-center text-[var(--color-academy-muted)]">선택한 기간에 접수된 신청이 없습니다.</td></tr>
                            ) : d.sources.map((row) => (
                                <tr key={row.source}>
                                    <td className="px-3 py-2">
                                        <span className="font-semibold text-[var(--color-academy-ink)]">{sourceLabel(row.source)}</span>
                                        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                                            <span className="block h-full rounded-full bg-[var(--color-academy-secondary-strong)]" style={{ width: `${maxTotal > 0 ? Math.max(8, Math.round((row.total / maxTotal) * 100)) : 0}%` }} />
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-right font-semibold">{row.total}</td>
                                    <td className="px-3 py-2 text-right">{row.trialTotal}<span className="ml-1 text-xs text-[var(--color-academy-muted)]">완료 {row.trialAttended}</span></td>
                                    <td className="px-3 py-2 text-right">{row.enrollTotal}<span className="ml-1 text-xs text-[var(--color-academy-muted)]">대기 {row.enrollPending}</span></td>
                                    <td className="px-3 py-2 text-right">{row.trialConverted + row.enrollApproved}</td>
                                    <td className="px-3 py-2 text-right font-semibold">{row.total > 0 ? `${row.conversionRate}%` : "–"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </StatPanel>
            <StatPanel title="재원생 가입경로" note={`재원생 ${d.referralTotal}명 · 원생 칸 «가입경로» 기준(옛 시트 문장은 같은 이름으로 모음)${branchFiltered ? " · 지점 필터 적용" : ""}`}>
                <HBarList rows={d.referral} />
            </StatPanel>
        </div>
    );
}

// ── 수업·출결 ─────────────────────────────────────────────────────────

const DAY_KO: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

function AttendanceView({ d, branchFiltered }: { d: StatsAttendanceTab; branchFiltered: boolean }) {
    // 꽉 찬 반이 먼저 보이게 채움 비율이 높은 순
    const classes = useMemo(
        () => [...d.classes].sort((a, b) => (b.capacity > 0 ? b.enrolled / b.capacity : 0) - (a.capacity > 0 ? a.enrolled / a.capacity : 0) || a.name.localeCompare(b.name, "ko")),
        [d.classes],
    );
    const trend = d.series.filter((m) => m.rate !== null).map((m) => ({ label: m.label, value: m.rate ?? 0 }));
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiCell label="이번 달 출석률" value={formatRate(d.rate)} sub={`전월 대비 ${formatPoint(d.diff)}`} />
                <KpiCell label="결석" value={`${d.absent}건`} sub={`출결 기록 ${d.total}건 중`} />
                <KpiCell label="지각" value={`${d.late}건`} sub="출석으로 셈" />
                <KpiCell label="대기자" value={`${d.waiting}명`} sub="반 대기 명단" />
            </div>
            <div className="grid items-start gap-2 lg:grid-cols-2">
                <StatPanel title="출석률 추이" note={`출석률 = (출석 + 지각) ÷ 출결 기록 전체(결석·사유결석 포함) · 수업 날짜(KST) 기준${branchFiltered ? " · 지점 필터 = 원생 지점" : ""}`}>
                    <LineChart data={trend} unit="%" color={CHART_COLORS.success} height={180} />
                </StatPanel>
                <StatPanel title="운영 규모" note="지점 구분 없음 · 프로그램은 삭제한 것 제외">
                    <div className="grid grid-cols-3 gap-2">
                        <KpiCell label="운영 프로그램" value={`${d.scale.programs}개`} />
                        <KpiCell label="개설 반" value={`${d.scale.classes}개`} />
                        <KpiCell label="코치/강사진" value={`${d.scale.coaches}명`} />
                    </div>
                </StatPanel>
                <StatPanel title="반별 정원 대비 인원" note="수강 중 인원 ÷ 반 정원 · 꽉 찬 반은 빨강 · 지점 = 반 장소">
                    {classes.length === 0 ? <p className="py-2 text-sm text-[var(--color-academy-muted)]">반이 없습니다.</p> : (
                        <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                            {classes.map((c) => {
                                const full = c.capacity > 0 && c.enrolled >= c.capacity;
                                return (
                                    <li key={c.id} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm">
                                        <span className="min-w-0">
                                            <span className="block truncate font-semibold text-[var(--color-academy-ink)]" title={c.name}>{c.name}</span>
                                            <span className="text-xs text-[var(--color-academy-muted)]">{DAY_KO[c.dayOfWeek] ?? c.dayOfWeek} {c.startTime}</span>
                                        </span>
                                        <span className="h-2 overflow-hidden rounded-full bg-[var(--color-academy-soft)]">
                                            <span className="block h-full rounded-full" style={{ width: `${c.capacity > 0 ? Math.min(100, (c.enrolled / c.capacity) * 100) : 0}%`, background: full ? CHART_COLORS.danger : "var(--color-academy-secondary-strong)" }} />
                                        </span>
                                        <span className={`text-right tabular-nums ${full ? "font-semibold text-[var(--color-academy-danger)]" : "text-[var(--color-academy-ink)]"}`}>
                                            {c.enrolled}/{c.capacity}명{c.waiting > 0 ? <span className="ml-1 text-xs text-[var(--color-academy-muted)]">대기 {c.waiting}</span> : null}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </StatPanel>
                <StatPanel title="코치별 담당" note="시간표에 배정된 반·그 반의 수강 중 원생 · 지점 구분 없음">
                    {d.coaches.length === 0 ? <p className="py-2 text-sm text-[var(--color-academy-muted)]">코치가 없습니다.</p> : (
                        <ul className="divide-y divide-[var(--color-academy-line)] text-sm">
                            {d.coaches.map((c) => (
                                <li key={c.id} className="flex min-h-11 items-center gap-3">
                                    <span className="min-w-0 flex-1 font-semibold text-[var(--color-academy-ink)]">{c.name}</span>
                                    <span className="tabular-nums text-[var(--color-academy-muted)]">반 <span className="font-semibold text-[var(--color-academy-ink)]">{c.classCount}</span></span>
                                    <span className="w-16 text-right tabular-nums text-[var(--color-academy-muted)]">원생 <span className="font-semibold text-[var(--color-academy-ink)]">{c.studentCount}</span></span>
                                </li>
                            ))}
                        </ul>
                    )}
                </StatPanel>
            </div>
        </div>
    );
}

// ── 수납 ──────────────────────────────────────────────────────────────

function BillingView({ d }: { d: StatsBillingTab }) {
    const monthName = `${Number(d.ym.slice(5, 7))}월`;
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiCell label={`${monthName} 수납률`} value={formatRate(d.rateAmount)} sub={`금액 기준 · 건 기준 ${formatRate(d.rateCount)}`} />
                <KpiCell label={`${monthName} 미납`} value={`${d.unpaidCount}건`} sub={formatKRW(d.unpaidAmount)} tone={d.unpaidCount > 0 ? "danger" : "ink"} />
                <KpiCell
                    label={`${monthName} 매출`}
                    value={formatKRW(d.revenue)}
                    sub={d.revenueDiffPct === null ? "전월 대비 –" : `전월 대비 ${d.revenueDiffPct > 0 ? "+" : ""}${d.revenueDiffPct}%`}
                />
                <KpiCell label="전월 매출" value={formatKRW(d.prevRevenue)} />
            </div>
            <div className="grid items-start gap-2 lg:grid-cols-2">
                <StatPanel title={`${monthName} 수강료 수납`} note="수강료 청구 기준(청구 달 = 이번 달) · 취소·환불 제외 · 미납 = 대기·연체">
                    <div className="flex flex-wrap items-center gap-4">
                        <DonutChart value={d.paidAmount} max={d.billedAmount} label="금액 기준" color={CHART_COLORS.success} size={120} />
                        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm tabular-nums">
                            <dt className="text-[var(--color-academy-muted)]">청구</dt><dd className="text-right">{d.billedCount}건 · {formatKRW(d.billedAmount)}</dd>
                            <dt className="text-[var(--color-academy-muted)]">수납</dt><dd className="text-right text-[var(--color-academy-success)]">{d.paidCount}건 · {formatKRW(d.paidAmount)}</dd>
                            <dt className="text-[var(--color-academy-muted)]">미납</dt><dd className="text-right font-semibold text-[var(--color-academy-danger)]">{d.unpaidCount}건 · {formatKRW(d.unpaidAmount)}</dd>
                        </dl>
                    </div>
                </StatPanel>
                <StatPanel title="매출 추이" note="매출 = 그 달(입금일 KST)에 수납 완료된 금액 · 수강료·셔틀·유니폼 등 모든 종류">
                    <ColumnChart rows={d.revenueSeries.map((m) => ({ label: m.label, value: m.amount }))} format={formatKRW} ariaLabel="월별 매출" />
                </StatPanel>
            </div>
            <StatPanel
                title="미납 상위"
                note={`누적 미납 ${d.overdue.count}건 · ${formatKRW(d.overdue.amount)} — 이번 달까지 청구분 중 대기·연체, 모든 종류`}
                action={<Link href="/admin/finance" prefetch={false} className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-academy-primary)]">청구·수납 열기 →</Link>}
            >
                {d.topUnpaid.length === 0 ? <p className="py-2 text-sm text-[var(--color-academy-muted)]">미납이 없습니다.</p> : (
                    <ul className="divide-y divide-[var(--color-academy-line)] text-sm">
                        {d.topUnpaid.map((u) => (
                            <li key={u.studentId}>
                                <Link href={`/admin/students/${u.studentId}`} prefetch={false} className="flex min-h-11 items-center gap-3 rounded-lg px-1 hover:bg-[var(--color-academy-soft)]">
                                    <span className="min-w-0 flex-1 font-semibold text-[var(--color-academy-ink)]">{u.name}</span>
                                    <span className="tabular-nums text-[var(--color-academy-muted)]">{u.count}건</span>
                                    <span className="w-20 text-right font-semibold tabular-nums text-[var(--color-academy-danger)]">{formatKRW(u.amount)}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </StatPanel>
        </div>
    );
}

// ── 유니폼 ────────────────────────────────────────────────────────────

function UniformView({ d }: { d: StatsUniformTab }) {
    const [group, setGroup] = useState<string>("전체");
    const count = (label: string) => d.segments.find((s) => s.label === label)?.count ?? 0;
    const list = group === "전체" ? d.list : d.list.filter((s) => s.group === group);
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiCell label="보유율" value={formatRate(d.rate)} sub={`재원생 ${d.total}명 중`} tone="success" />
                <KpiCell label="보유" value={`${d.owned}명`} sub="보유·수령완료" />
                <KpiCell label="진행 중" value={`${count("진행 중")}명`} sub="신청·주문·미수령" />
                <KpiCell label="확인 필요" value={`${count("확인 필요")}명`} sub="확인보류·빈칸" />
            </div>
            <div className="grid items-start gap-2 lg:grid-cols-2">
                <StatPanel title="상태 비율" note="분모 = 재원생 전체(확인 필요·해당없음 포함) · 없음 = 미보유·미신청">
                    <StackedBar segments={d.segments.map((s) => ({ label: s.label, value: s.count, color: UNIFORM_COLORS[s.label] ?? CHART_COLORS.bar }))} ariaLabel="유니폼 상태 비율" />
                </StatPanel>
                <StatPanel title="3년 무료 증정" note="수강 3년 이상 원생에게 발급한 무료 쿠폰(발급 = 아직 안 씀)">
                    <div className="grid grid-cols-3 gap-2">
                        <KpiCell label="발급(미사용)" value={`${d.grants.issued}건`} />
                        <KpiCell label="사용" value={`${d.grants.used}건`} />
                        <KpiCell label="회수" value={`${d.grants.revoked}건`} />
                    </div>
                </StatPanel>
                <StatPanel title="지점별 보유율">
                    <RateRows rows={d.byBranch} />
                </StatPanel>
                <StatPanel title="학년별 보유율" note="학년 = 생년월일·3월 학년도 기준">
                    <RateRows rows={d.byGrade} />
                </StatPanel>
            </div>
            <StatPanel title="원생별 명단" note="누르면 그 원생의 유니폼 칸으로 갑니다 · 수령일 = 학원 수령일">
                {/* 상태 칩으로 거르기(알약 = 누르는 칩, 줄의 상태 표시는 4px 모서리) */}
                <div role="group" aria-label="유니폼 상태로 거르기" className="mb-2 flex flex-wrap gap-1.5">
                    {["전체", ...UNIFORM_GROUPS].map((g) => {
                        const n = g === "전체" ? d.list.length : count(g);
                        const on = group === g;
                        return (
                            <button key={g} type="button" aria-pressed={on} onClick={() => setGroup(g)}
                                className={`academy-choice is-tab${on ? " is-selected" : ""}`}>
                                {g} <span className="tabular-nums">{n}</span>
                            </button>
                        );
                    })}
                </div>
                {list.length === 0 ? <p className="py-2 text-sm text-[var(--color-academy-muted)]">해당 원생이 없습니다.</p> : (
                    <ul className="max-h-[32rem] divide-y divide-[var(--color-academy-line)] overflow-y-auto text-sm">
                        {list.map((s) => (
                            <li key={s.id}>
                                <Link href={`/admin/students/${s.id}#student-uniform`} prefetch={false} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-1 py-1 hover:bg-[var(--color-academy-soft)]">
                                    <span className="w-20 shrink-0 font-semibold text-[var(--color-academy-ink)]">{s.name}</span>
                                    <span className="rounded px-1.5 py-0.5 text-xs" style={{ color: UNIFORM_COLORS[s.group] ?? "var(--color-academy-muted)", background: "var(--color-academy-soft)" }}>{s.status}</span>
                                    <span className="min-w-0 flex-1 text-xs text-[var(--color-academy-muted)]">{s.classes || "반 없음"} · {s.branch}</span>
                                    <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">{s.receivedYmd ? `수령 ${s.receivedYmd.slice(2).replace(/-/g, ".")}` : ""}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </StatPanel>
            <StatPanel title="주문 사이즈 분포" note={`주문 기준 — 유니폼 주문서의 학생 이름이 재원생 이름과 같은 ${d.sizes.matchedStudents}명의 주문 수량(취소 제외)`}>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                        <h3 className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">상의</h3>
                        <HBarList rows={d.sizes.top} unit="벌" emptyText="주문 기록이 없습니다" />
                    </div>
                    <div>
                        <h3 className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">하의</h3>
                        <HBarList rows={d.sizes.bottom} unit="벌" emptyText="주문 기록이 없습니다" />
                    </div>
                </div>
            </StatPanel>
        </div>
    );
}
