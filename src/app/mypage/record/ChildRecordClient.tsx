"use client";

import { useState } from "react";
import Link from "next/link";
import BarChart from "@/components/charts/BarChart";
import StackedBar from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/chartColors";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
// 청구 이력 = 청구 탭과 같은 «월 카드 + 세부 시트» 부품(2026-11-14 원장 지시 — 청구 관련 모든 화면에 똑같이)
import MonthBillCard from "@/components/parent/billing/MonthBillCard";
import BillDetailSheet from "@/components/parent/billing/BillDetailSheet";
import { groupBillsByMonth } from "@/lib/payments/monthBills";
import type { ChildRecord } from "@/lib/parent/childRecordQuery";
// 아이 정보·수강 반·셔틀 칸(2026-11-14 «아이 정보 + 기록» 한 장)
import { ChildClassesSection, ChildInfoSection, ChildShuttleSection } from "./ChildProfileSections";
// 프로필 사진(2026-11-15) — 제목 왼쪽 64px · 형제 칩 28px
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";
import {
  EMPTY_PAYMENT_FILTER,
  PAYMENT_KIND_LABEL,
  RECORD_PAYMENT_KINDS,
  TIMELINE_LABEL,
  activeFilterCount,
  buildTimeline,
  filterPayments,
  freeUniformText,
  missingMonthsText,
  paymentsOfYear,
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
  /** photoVersion = 프로필 사진 캐시 버전(사진 없으면 null → 이름 첫 글자) */
  childList: { id: string; name: string; photoVersion?: string | null }[];
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
  // 열려 있는 청구 세부 시트의 달 "YYYY-MM"
  const [openYm, setOpenYm] = useState<string | null>(null);

  const summary = summarizePayments(payments, year);
  const yearAtt = yearAttendance(months, year);
  // 그해 청구(필터 적용)를 청구 달 하나에 카드 하나로 — 연도 칩으로 해를 고르므로 달 이름은 «12월»처럼 짧게
  //  (계산이 가벼워 그냥 매번 — React Compiler 가 알아서 기억한다)
  const monthBills = groupBillsByMonth(
    paymentsOfYear(filterPayments(payments, filter), year, currentYm).map((p) => ({ ...p, studentId: record.student.id, studentName: record.student.name })),
    String(year),
  );
  const openBill = openYm === null ? null : monthBills.find((bill) => bill.ym === openYm) ?? null;
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
    setOpenYm(null);
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
        {/* 아이 사진(64px) + 제목 — 사진이 없으면 이름 첫 글자. 올리기·바꾸기는 바로 아래 «아이 정보» 칸에서 */}
        <div className="flex items-center gap-3">
          <ProfileAvatar decorative name={record.student.name} size={64} src={profilePhotoUrl({ kind: "student", id: childId }, record.student.photoVersion, true)} />
          <h1 className="academy-heading min-w-0 flex-1 break-keep">{record.student.name} 기록</h1>
        </div>
        {childList.length > 1 && (
          <div role="group" aria-label="자녀 선택" className="mt-2 flex flex-wrap gap-1.5">
            {childList.map((c) => (
              <Link
                key={c.id}
                href={`/mypage/record?child=${encodeURIComponent(c.id)}`}
                aria-current={c.id === childId ? "page" : undefined}
                className={`academy-choice ${c.id === childId ? "is-selected" : ""}`}
              >
                {/* 형제 칩 사진 28px */}
                <ProfileAvatar decorative name={c.name} size={28} src={profilePhotoUrl({ kind: "student", id: c.id }, c.photoVersion, true)} />
                {c.name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 아이 정보 — 관리자 원생 상세 중 학부모에게 보여도 되는 것만(맨 위) */}
      {/* key = 아이 id — 형제로 바꾸면 사진 올리기 칸의 진행·확인 상태를 새로 시작한다 */}
      <ChildInfoSection key={childId} profile={record.profile} today={today} studentId={childId} photo={{ name: record.student.name, version: record.student.photoVersion ?? null }} />

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
            {monthBills.length === 0 ? (
              <p className="border-t border-[var(--color-academy-line)] px-3 py-3 text-sm text-[var(--color-academy-muted)]">
                {filterCount > 0 ? "고른 조건에 맞는 청구가 없어요." : `${year}년 청구가 없어요.`}
              </p>
            ) : (
              // 한 달 = 한 줄(청구월 · 합계 · 상태) — 청구 탭과 같은 부품. 누르면 세부 시트(항목·할인·영수증)
              <ul aria-label={`${year}년 월별 청구`} className="divide-y divide-[var(--color-academy-line)] border-t border-[var(--color-academy-line)]">
                {monthBills.map((bill) => (
                  <MonthBillCard key={bill.ym || "none"} bill={bill} onOpen={setOpenYm} />
                ))}
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
            <button type="button" onClick={() => { setFilter(draft); setOpenYm(null); setSheetOpen(false); }} className="academy-button-primary">적용</button>
          </div>
        </ListDetailPanel>
      )}

      {/* 청구 세부 시트 — 항목·원래 금액·할인·낼 금액·상태·납기·납부일·결제수단·영수증. 결제는 청구 탭에서(기존 결제 흐름 한 곳) */}
      {openBill && (
        <BillDetailSheet
          bill={openBill}
          onClose={() => setOpenYm(null)}
          footer={
            record.student.canPay && openBill.unpaidCount > 0 ? (
              <Link href="/mypage/payments" className="academy-button-primary w-full">청구 탭에서 결제</Link>
            ) : null
          }
        />
      )}
    </div>
  );
}
