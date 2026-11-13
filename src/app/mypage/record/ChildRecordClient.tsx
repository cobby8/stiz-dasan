"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import BarChart from "@/components/charts/BarChart";
import StackedBar from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/chartColors";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { PAYMENT_TONE, TONE_BADGE_CLASS, TONE_TEXT_CLASS, toneFor } from "@/lib/ui/statusTones";
import type { ChildRecord } from "@/lib/parent/childRecordQuery";
// 아이 정보·수강 반·셔틀 칸(2026-11-14 «아이 정보 + 기록» 한 장)
import { ChildClassesSection, ChildInfoSection, ChildShuttleSection } from "./ChildProfileSections";
import {
  EMPTY_PAYMENT_FILTER,
  PAYMENT_KIND_LABEL,
  RECORD_PAYMENT_KINDS,
  TIMELINE_LABEL,
  activeFilterCount,
  buildTimeline,
  filterPayments,
  freeUniformText,
  groupPaymentsByMonth,
  isUnpaid,
  missingMonthsText,
  paymentKind,
  paymentStatusLabel,
  pickRecordYear,
  recentAttendanceBars,
  recordYears,
  summarizePayments,
  tenureText,
  uniformStatusText,
  won,
  yearAttendance,
  type PaymentFilter,
  type RecordPaymentKind,
} from "@/lib/parent/childRecordRules";

// 학부모 «아이 기록» 화면 (2026-11-14 원장 결정 w2 · 같은 날 «아이 정보 + 셔틀» 확장) — 컴팩트 UI 규칙(아이콘 없이 글자로 — UI 통일 가드):
//  순서: 아이 정보 → 요약 4칸 → 수강 반 → 셔틀 → 청구 이력 → 출석 → 수강 반 이력 → 특강·유니폼·리포트
//  히어로 없음 · 요약 4칸(2×2) · 한 줄 행(48px) · 필터는 버튼 하나 + 하단 시트 · 터치 44px · 글자 12px 이상.
// 계산은 전부 childRecordRules(순수 함수, 실행 테스트 있음)에서. 여기는 그리기와 펼치기·필터 상태만.

// 종류 비율 막대 색 — 뜻 없는 계열이라 토큰만(하드코딩 색 금지)
const KIND_COLOR: Record<RecordPaymentKind, string> = {
  TUITION: CHART_COLORS.series,
  SHUTTLE: "var(--color-academy-info)",
  SPECIAL: "var(--color-academy-success)",
  UNIFORM: "var(--color-academy-warning)",
  OTHER: CHART_COLORS.bar,
};

const STATUS_FILTERS: { key: PaymentFilter["statuses"][number]; label: string }[] = [
  { key: "PAID", label: "납부 완료" },
  { key: "UNPAID", label: "미납·연체" },
  { key: "REFUNDED", label: "환불" },
];

/** "2026-11-03" → "26.11.03" */
function shortYmd(ymd: string | null): string {
  return ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(2, 4)}.${ymd.slice(5, 7)}.${ymd.slice(8, 10)}` : "";
}

/** 요약 칸 하나 — 이름 / 큰 값 / 보조 한 줄 */
function SummaryCell({ label, value, sub, tone, href }: { label: string; value: string; sub?: string | null; tone?: "warning" | null; href?: string }) {
  const body = (
    <>
      <span className="block text-xs text-[var(--color-academy-muted)]">{label}</span>
      <span className={`block break-keep text-base font-bold tabular-nums ${tone === "warning" ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-ink)]"}`}>{value}</span>
      {sub && <span className="block break-keep text-xs tabular-nums text-[var(--color-academy-muted)]">{sub}</span>}
    </>
  );
  const cls = "block min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-2 ring-1 ring-inset ring-[var(--color-academy-line)]";
  return href ? <Link href={href} className={`${cls} hover:bg-[var(--color-academy-soft)]`}>{body}</Link> : <div className={cls}>{body}</div>;
}

export default function ChildRecordClient({
  record,
  childList,
  initialYear,
}: {
  record: ChildRecord;
  childList: { id: string; name: string }[];
  initialYear: string | null;
}) {
  const today = record.today;
  const currentYm = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));
  const payments = record.payments ?? [];
  const months = record.attendance ?? [];
  const years = recordYears({ payments, attendanceMonths: months, currentYear });
  const [year, setYear] = useState(() => pickRecordYear(initialYear, years, currentYear));
  const [filter, setFilter] = useState<PaymentFilter>(EMPTY_PAYMENT_FILTER);
  const [draft, setDraft] = useState<PaymentFilter>(EMPTY_PAYMENT_FILTER);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  const summary = summarizePayments(payments, year);
  const yearAtt = yearAttendance(months, year);
  const groups = useMemo(() => groupPaymentsByMonth(filterPayments(payments, filter), year, currentYm), [payments, filter, year, currentYm]);
  const bars = recentAttendanceBars(months, currentYm, 12);
  const missing = missingMonthsText(bars);
  const timeline = record.timeline ? buildTimeline({ ...record.timeline, today }) : null;
  const tenure = tenureText(record.tenure, record.student.hasBaseline);
  const yearWord = year === currentYear ? "올해" : `${year}년`;
  const filterCount = activeFilterCount(filter);
  const childId = record.student.id;

  // 연도 칩 — 화면 안에서 바로 바꾸고 주소(?year=)도 고친다(뒤로 가기·새로고침 때 같은 해)
  function chooseYear(y: number) {
    setYear(y);
    setOpenMonths({});
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("year", String(y));
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // 주소를 못 고쳐도 화면은 바뀐다
    }
  }

  const toggle = (draftList: string[], key: string) => (draftList.includes(key) ? draftList.filter((k) => k !== key) : [...draftList, key]);

  return (
    <div className="space-y-3">
      {/* 머리줄 — 제목 + 형제 칩(히어로 없음) */}
      <div>
        <h1 className="academy-heading">{record.student.name} 기록</h1>
        {childList.length > 1 && (
          <div role="group" aria-label="자녀 선택" className="mt-2 flex flex-wrap gap-1.5">
            {childList.map((c) => (
              <Link
                key={c.id}
                href={`/mypage/record?child=${encodeURIComponent(c.id)}`}
                aria-current={c.id === childId ? "page" : undefined}
                className={`academy-choice ${c.id === childId ? "is-selected" : ""}`}
              >
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 아이 정보 — 관리자 원생 상세 중 학부모에게 보여도 되는 것만(맨 위) */}
      <ChildInfoSection profile={record.profile} today={today} studentId={childId} />

      {/* 요약 4칸(2×2) — 다닌 기간 · 출석률 · 납부 · 미납 */}
      <section aria-label="요약" className="grid grid-cols-2 gap-2">
        <SummaryCell label="다닌 기간" value={tenure?.main ?? "기록 없음"} sub={tenure?.sub} />
        <SummaryCell
          label={`${yearWord} 출석률`}
          value={yearAtt.rate === null ? "기록 없음" : `${yearAtt.rate}%`}
          sub={yearAtt.records > 0 ? `출석 ${yearAtt.present + yearAtt.late} · 결석 ${Math.max(0, yearAtt.absent - yearAtt.makeupReplaced)}` : null}
        />
        <SummaryCell
          label={`${yearWord} 납부`}
          value={record.student.canPay ? won(summary.paidTotal) : `${summary.paidCount}건`}
          sub={record.student.canPay ? `${summary.paidCount}건` : null}
        />
        <SummaryCell
          label="미납"
          value={`${summary.unpaidCount}건`}
          sub={summary.unpaidCount > 0 && record.student.canPay ? won(summary.unpaidTotal) : null}
          tone={summary.unpaidCount > 0 ? "warning" : null}
          href={summary.unpaidCount > 0 ? "/mypage/payments" : undefined}
        />
      </section>
      {/* 옛 기록 안내(q4) — 한 줄 */}
      <p className="text-xs text-[var(--color-academy-muted)]">2026년 4월 이전 출석·일부 청구는 기록이 없어요.</p>

      {/* 수강 반 · 셔틀(명단 기준 — 기사님·관리자 운행표와 같은 정본) */}
      <ChildClassesSection profile={record.profile} studentId={childId} />
      <ChildShuttleSection shuttle={record.shuttle} studentId={childId} />

      {/* 청구 이력 */}
      <section aria-labelledby="record-pay-heading" className="academy-panel overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--color-academy-line)] px-3 py-1.5">
          <h2 id="record-pay-heading" className="academy-section-title min-w-0 flex-1">청구 이력</h2>
          <button
            type="button"
            onClick={() => { setDraft(filter); setSheetOpen(true); }}
            className="academy-button-secondary shrink-0 whitespace-nowrap"
          >
            필터{filterCount > 0 ? ` ${filterCount}` : ""}
          </button>
        </div>
        {/* 연도 칩 — 가로 한 줄(넘치면 옆으로 밀기) */}
        <div role="group" aria-label="연도" className="flex gap-1.5 overflow-x-auto px-3 py-2">
          {years.map((y) => (
            <button key={y} type="button" aria-pressed={y === year} onClick={() => chooseYear(y)} className="academy-choice shrink-0 tabular-nums">
              {y}
            </button>
          ))}
        </div>
        {record.payments === null ? (
          <p role="alert" className="px-3 pb-3 text-sm text-[var(--color-academy-muted)]">청구 기록을 불러오지 못했어요.</p>
        ) : (
          <>
            {/* 종류 구성 한 줄 — 그해 청구 건수 */}
            {RECORD_PAYMENT_KINDS.some((k) => summary.kindCounts[k] > 0) && (
              <div className="px-3 pb-2">
                <StackedBar
                  ariaLabel={`${year}년 청구 종류`}
                  unit="건"
                  height={8}
                  segments={RECORD_PAYMENT_KINDS.filter((k) => summary.kindCounts[k] > 0).map((k) => ({ label: PAYMENT_KIND_LABEL[k], value: summary.kindCounts[k], color: KIND_COLOR[k] }))}
                />
              </div>
            )}
            {groups.length === 0 ? (
              <p className="border-t border-[var(--color-academy-line)] px-3 py-3 text-sm text-[var(--color-academy-muted)]">
                {filterCount > 0 ? "고른 조건에 맞는 청구가 없어요." : `${year}년 청구가 없어요.`}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-academy-line)] border-t border-[var(--color-academy-line)]">
                {groups.map((g) => {
                  const open = openMonths[g.ym] ?? g.defaultOpen;
                  return (
                    <li key={g.ym || "none"}>
                      {/* 월 묶음 머리줄 «11월 · 2건 · 255,000원» — 누르면 접기/펼치기 */}
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenMonths((prev) => ({ ...prev, [g.ym]: !open }))}
                        className="flex min-h-11 w-full items-center gap-2 bg-[var(--color-academy-soft)] px-3 py-1.5 text-left"
                      >
                        <span className="min-w-0 flex-1 text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">
                          {g.label} · {g.count}건{record.student.canPay ? ` · ${won(g.total)}` : ""}
                        </span>
                        {g.unpaidCount > 0 && <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS.warning}`}>미납 {g.unpaidCount}</span>}
                        <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-muted)]">{open ? "▴" : "▾"}</span>
                      </button>
                      {open && (
                        <ul className="divide-y divide-[var(--color-academy-line)]">
                          {g.rows.map((p) => {
                            const kind = paymentKind(p.type);
                            const tone = toneFor(PAYMENT_TONE, p.status, isUnpaid(p.status) ? "warning" : "neutral");
                            return (
                              // 한 줄 행(48px) — 종류 배지 · 항목 · 금액 · 상태 · 영수증
                              <li key={p.id} className="flex min-h-12 items-center gap-2 px-3 py-1">
                                <span className="shrink-0 rounded bg-[var(--color-academy-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-muted)]">{PAYMENT_KIND_LABEL[kind]}</span>
                                <span className="min-w-0 flex-1">
                                  <span className="block break-keep text-sm text-[var(--color-academy-ink)]">{p.description || PAYMENT_KIND_LABEL[kind]}</span>
                                  {p.paidYmd && p.status === "PAID" && <span className="block text-xs tabular-nums text-[var(--color-academy-muted)]">{shortYmd(p.paidYmd)} 납부</span>}
                                </span>
                                {p.amount !== null && <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">{won(p.amount)}</span>}
                                <span className={`shrink-0 text-xs font-medium ${TONE_TEXT_CLASS[tone]}`}>{paymentStatusLabel(p.status)}</span>
                                {p.receiptUrl ? (
                                  <a
                                    href={p.receiptUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-outside-link
                                    className="academy-button-text shrink-0 whitespace-nowrap !px-1"
                                  >
                                    영수증
                                  </a>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      {/* 출석 — 최근 12개월 막대(기록 없는 달은 «–», 0% 가 아니다) */}
      <section aria-labelledby="record-att-heading" className="academy-panel p-3">
        <div className="flex items-center gap-2">
          <h2 id="record-att-heading" className="academy-section-title min-w-0 flex-1">출석 · 최근 12개월</h2>
          <Link href={`/mypage/classes?child=${encodeURIComponent(childId)}&month=${currentYm}`} className="academy-button-text shrink-0">
            달력 보기 ▸
          </Link>
        </div>
        {record.attendance === null ? (
          <p role="alert" className="mt-1 text-sm text-[var(--color-academy-muted)]">출석 기록을 불러오지 못했어요.</p>
        ) : bars.every((b) => b.rate === null) ? (
          <p className="mt-1 text-sm text-[var(--color-academy-muted)]">최근 12개월 출석 기록이 없어요.</p>
        ) : (
          <>
            <div className="mt-1" role="img" aria-label={`월별 출석률: ${bars.map((b) => `${b.label} ${b.rate === null ? "기록 없음" : `${b.rate}%`}`).join(", ")}`}>
              <BarChart
                data={bars.map((b) => ({ label: String(Number(b.ym.slice(5, 7))), value: b.rate ?? 0, missing: b.rate === null, valueLabel: b.rate === null ? undefined : String(b.rate) }))}
                color={CHART_COLORS.success}
                height={150}
                viewWidth={300}
                fontSize={13}
                showValues
              />
            </div>
            <p className="text-xs text-[var(--color-academy-muted)]">
              월별 출석률(%) · 출석·지각 ÷ 출석·지각·결석{missing ? ` · 기록 없음(–): ${missing}` : ""}
            </p>
          </>
        )}
      </section>

      {/* 수강 반 이력 — 최신 일부터 */}
      <section aria-labelledby="record-class-heading" className="academy-panel overflow-hidden">
        <h2 id="record-class-heading" className="academy-section-title border-b border-[var(--color-academy-line)] px-3 py-2">수강 반 이력</h2>
        {timeline === null ? (
          <p role="alert" className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">수강 기록을 불러오지 못했어요.</p>
        ) : timeline.length === 0 ? (
          <p className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">수강 기록이 없어요.</p>
        ) : (
          <ol className="divide-y divide-[var(--color-academy-line)]">
            {timeline.map((ev) => (
              <li key={ev.key} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
                <span className="w-16 shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">{shortYmd(ev.ymd)}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[ev.kind === "WITHDRAW" ? "neutral" : ev.kind === "PAUSE" ? "warning" : ev.kind === "JOIN" ? "success" : "info"]}`}>
                  {TIMELINE_LABEL[ev.kind]}
                </span>
                <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{ev.title}</span>
                {ev.scheduled && <span className="shrink-0 text-xs font-medium text-[var(--color-academy-info)]">예정</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* 특강 · 유니폼 · 리포트 — 한 줄씩 */}
      <section aria-label="특강·유니폼·리포트" className="academy-panel overflow-hidden">
        <ul className="divide-y divide-[var(--color-academy-line)]">
          {record.seasonal === null ? (
            <li className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">특강 기록을 불러오지 못했어요.</li>
          ) : record.seasonal.length === 0 ? (
            <li className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-14 shrink-0 text-xs text-[var(--color-academy-muted)]">특강</span>
              <span className="text-[var(--color-academy-muted)]">들은 방학특강이 없어요</span>
            </li>
          ) : (
            record.seasonal.map((s) => (
              <li key={s.seasonId} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-14 shrink-0 text-xs text-[var(--color-academy-muted)]">특강</span>
                <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">{s.title}</span>
                <span className="shrink-0 tabular-nums text-[var(--color-academy-ink)]">{s.total}회 중 {s.attended}회 출석</span>
              </li>
            ))
          )}
          {record.uniform && (
            <li className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-14 shrink-0 text-xs text-[var(--color-academy-muted)]">유니폼</span>
              <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                {[
                  uniformStatusText(record.uniform.status) ?? "기록 없음",
                  record.uniform.receivedYmd ? `${shortYmd(record.uniform.receivedYmd)} 수령` : null,
                  freeUniformText(record.uniform.freeGrant),
                ].filter(Boolean).join(" · ")}
              </span>
            </li>
          )}
          <li>
            <Link href="/mypage/reports" className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--color-academy-soft)]">
              <span className="w-14 shrink-0 text-xs text-[var(--color-academy-muted)]">리포트</span>
              <span className="min-w-0 flex-1 tabular-nums text-[var(--color-academy-ink)]">
                {record.reports ? `리포트 ${record.reports.reports}건 · 피드백 ${record.reports.feedbacks}건` : "소식에서 보기"}
              </span>
              <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">▸</span>
            </Link>
          </li>
        </ul>
      </section>

      {/* 필터 하단 시트(PC 는 오른쪽 칸) — 종류·상태. «적용»을 눌러야 바뀐다 */}
      {sheetOpen && (
        <ListDetailPanel onClose={() => setSheetOpen(false)} titleId="record-filter-title" panelClassName="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <h3 id="record-filter-title" className="academy-section-title mb-2">청구 필터</h3>
          <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">종류</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {RECORD_PAYMENT_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={draft.kinds.includes(k)} onClick={() => setDraft((d) => ({ ...d, kinds: toggle(d.kinds, k) as RecordPaymentKind[] }))} className="academy-choice">
                {PAYMENT_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">상태</p>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((s) => (
              <button key={s.key} type="button" aria-pressed={draft.statuses.includes(s.key)} onClick={() => setDraft((d) => ({ ...d, statuses: toggle(d.statuses, s.key) as PaymentFilter["statuses"] }))} className="academy-choice">
                {s.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setDraft(EMPTY_PAYMENT_FILTER)} className="academy-button-secondary">초기화</button>
            <button type="button" onClick={() => { setFilter(draft); setOpenMonths({}); setSheetOpen(false); }} className="academy-button-primary">적용</button>
          </div>
        </ListDetailPanel>
      )}
    </div>
  );
}
