"use client";

import { useState } from "react";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import type { AdminCreditOverview } from "@/lib/makeup/admin-credits";

/** 만료 임박도에 따른 색. 원장이 목록을 훑을 때 눈으로 먼저 걸러진다. (CSS 변수 토큰) */
function urgency(daysLeft: number) {
  if (daysLeft < 0) return "text-[var(--color-academy-danger)]";
  if (daysLeft <= 7) return "text-[var(--color-academy-danger)]";
  if (daysLeft <= 14) return "text-[var(--color-academy-warning)]";
  return "text-[var(--color-academy-muted)]";
}

function daysText(d: number) {
  if (d < 0) return "기간 지남";
  if (d === 0) return "오늘까지";
  return `${d}일 남음`;
}

export default function CreditPanel({ data }: { data: AdminCreditOverview }) {
  // 행 클릭 상세 패널 대상(예전엔 행 아래로 펼쳤다 — 이제 오른쪽 패널/모바일 시트로)
  const [openId, setOpenId] = useState("");
  const { totals, students } = data;
  const detail = openId ? students.find((s) => s.studentId === openId) ?? null : null;

  // 행 키보드(Enter·Space) = 상세 패널. 안쪽 요소에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpenId(id);
    }
  }

  return (
    <div className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-black text-[var(--color-academy-ink)]">보강권 현황</h2>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-[var(--color-academy-muted)]">
            대상 <strong className="tabular-nums text-[var(--color-academy-ink)]">{totals.students}</strong>명
          </span>
          <span className="text-[var(--color-academy-muted)]">
            미사용 <strong className="tabular-nums text-[var(--color-academy-success)]">{totals.available}</strong>장
          </span>
          <span className="text-[var(--color-academy-muted)]">
            예약됨 <strong className="tabular-nums text-[var(--color-academy-primary)]">{totals.reserved}</strong>장
          </span>
          {totals.expiringSoon > 0 && (
            <span className="rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 font-black text-[var(--color-academy-warning)]">
              2주 내 소멸 <span className="tabular-nums">{totals.expiringSoon}</span>장
            </span>
          )}
        </div>
      </div>

      {totals.expiringSoon > 0 && (
        <p className="mb-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-ink)]">
          아직 예약하지 않은 보강권이 곧 소멸합니다. 미리 안내하면 분쟁을 막을 수 있습니다.
        </p>
      )}

      {students.length === 0 ? (
        <p className="py-3 text-center text-sm text-[var(--color-academy-muted)]">
          남아 있는 보강권이 없습니다.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-academy-line)]">
          <div className="overflow-x-auto">
            {/* 한 줄 행: 원생 | 학년 | 학부모 연락처 | 미사용 | 예약 | 가장 빠른 소멸. 장별 내역은 상세 패널에서 */}
            <table className="admin-list-table w-full border-collapse text-sm">
              <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                <tr>
                  <th className="px-2 py-2">원생</th>
                  <th className="hidden px-2 py-2 sm:table-cell">학년</th>
                  <th className="admin-cell-num hidden px-2 py-2 md:table-cell">학부모 연락처</th>
                  <th className="admin-cell-num px-2 py-2">미사용</th>
                  <th className="admin-cell-num px-2 py-2">예약</th>
                  <th className="admin-cell-num px-2 py-2">소멸</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-academy-line)]">
                {students.map((s) => (
                  <tr
                    key={s.studentId}
                    tabIndex={0}
                    aria-label={`${s.studentName} 보강권 내역 보기`}
                    onClick={() => setOpenId(s.studentId)}
                    onKeyDown={(event) => handleRowKeyDown(event, s.studentId)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">{s.studentName}</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{s.studentGrade || "-"}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{s.parentPhone || "-"}</td>
                    {/* 장 수·남은 일수는 오른쪽 + 자릿수 폭 고정 */}
                    <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-success)]">{s.available > 0 ? `${s.available}장` : "-"}</td>
                    <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-primary)]">{s.reserved > 0 ? `${s.reserved}장` : "-"}</td>
                    <td className={`admin-cell-num px-2 py-1.5 font-black ${urgency(s.soonestDaysLeft)}`}>{daysText(s.soonestDaysLeft)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 행 클릭 상세 패널 — 이미 받아온 값만 보여 준다(새 조회 없음). 장별 결석일·출처·원래 반·예약·만료 전부 */}
      {detail && (
        <ListDetailPanel onClose={() => setOpenId("")} titleId="credit-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center gap-2">
            <h3 id="credit-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">
              {detail.studentName}
              {detail.studentGrade && <span className="ml-1.5 text-sm font-bold text-[var(--color-academy-muted)]">{detail.studentGrade}</span>}
            </h3>
            <button
              type="button"
              onClick={() => setOpenId("")}
              aria-label="닫기"
              className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
            >
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="font-bold text-[var(--color-academy-muted)]">학부모</dt>
            <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{detail.parentName || "-"}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">연락처</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">{detail.parentPhone || "-"}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">보강권</dt>
            <dd className="text-[var(--color-academy-ink)]">
              미사용 <span className="tabular-nums">{detail.available}</span>장 · 예약 <span className="tabular-nums">{detail.reserved}</span>장
            </dd>
          </dl>
          <ul className="mt-4 divide-y divide-[var(--color-academy-line)] rounded-lg border border-[var(--color-academy-line)]">
            {detail.credits.map((c) => (
              <li key={c.id} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="font-bold text-[var(--color-academy-ink)]">{c.absenceLabel} 결석</span>
                  <span className={`tabular-nums text-xs font-bold ${urgency(c.daysLeft)}`}>
                    {c.expiresLabel}까지 · {daysText(c.daysLeft)}
                  </span>
                </div>
                <p className="mt-0.5 break-keep break-words text-xs text-[var(--color-academy-muted)]">
                  {c.sourceLabel}
                  {c.originClassName ? ` · ${c.originClassName}` : ""}
                </p>
                {c.booking && (
                  <p className="mt-0.5 break-keep break-words text-xs text-[var(--color-academy-primary)]">→ {c.booking}</p>
                )}
              </li>
            ))}
          </ul>
        </ListDetailPanel>
      )}
    </div>
  );
}
