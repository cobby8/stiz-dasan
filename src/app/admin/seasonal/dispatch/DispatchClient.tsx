"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useState } from "react";
import RouteSection from "@/components/seasonal/RouteSection";
import { firstDateOfSameWeekday, weekdayOptions } from "@/lib/seasonal/weekday";
import type { DispatchSuggestion } from "@/lib/seasonal/shuttle-optimize";

// 방학특강 셔틀 배차 — 요일별로 관리한다. 요일 탭을 고르면 그 요일의 등원 → 하원 노선을 함께 보여준다.
// 같은 요일은 같은 학생이 오므로, 노선은 요일당 한 번만 짜서 저장하면 모든 같은 요일에 적용된다.
// 기준 위치(학원·차고지·거점) 편집은 '차량 관리'로 옮겼다.

export default function DispatchClient({ initialPickup, initialDropoff }: { initialPickup: DispatchSuggestion; initialDropoff: DispatchSuggestion }) {
  const availableDates = initialPickup.availableDates;
  const weekdays = weekdayOptions(availableDates); // 요일 탭(월→금) + 각 요일의 대표 날짜
  // 노선 관리용 날짜 = 선택한 요일의 '대표 날짜'(그 요일 첫 운행일). 초기값은 첫 운행일의 요일.
  const [date, setDate] = useState<string>(initialPickup.date ? firstDateOfSameWeekday(availableDates, initialPickup.date) : "");
  const [pickupDirty, setPickupDirty] = useState(false);
  const [dropoffDirty, setDropoffDirty] = useState(false);
  const onPickupDirty = useCallback((dirty: boolean) => setPickupDirty(dirty), []);
  const onDropoffDirty = useCallback((dirty: boolean) => setDropoffDirty(dirty), []);
  const refreshKey = 0; // 기준위치 편집이 이 화면에서 빠져 재계산 트리거가 없다(날짜 변경만으로 재조회).
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 기사 폰/태블릿에 고정하는 링크 — 매일 열면 '오늘' 운행이 뜬다.
  async function copyRollingLink() {
    setErr(null); setMsg(null);
    try {
      const r = await fetch("/api/admin/seasonal/dispatch/run-link", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rolling: true }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "링크 생성 실패");
      const url = `${window.location.origin}${j.path}`;
      try { await navigator.clipboard.writeText(url); setMsg("기사 고정 링크를 복사했습니다(매일 열면 오늘 운행)"); }
      catch { setMsg(`기사 고정 링크: ${url}`); }
    } catch (e: unknown) { setErr((adminErrorText(e, "")) || "링크를 만들지 못했습니다."); }
  }

  const activeWeekdayLabel = weekdays.find((w) => w.canonicalDate === date)?.label ?? "";

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
        <h3 className="academy-section-title">셔틀 배차 · 하루 타임라인</h3>
        {/* 조작 설명(요일 탭·드래그·기사 링크)은 화면에서 바로 보이므로 뺐다.
            "요일당 한 번만" 문장은 데이터 모델 설명(요일 단위 저장)이라 반드시 남긴다. */}
        <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">
          같은 요일은 같은 학생이 오므로 <b>요일당 한 번만</b> 짜서 저장하면 모든 같은 요일에 적용됩니다.
        </p>

        {/* 요일 탭 — 노선 관리 단위 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {weekdays.length === 0 && <span className="px-2 py-1 text-sm text-[var(--color-academy-faint)]">운행 요일이 없습니다.</span>}
          {weekdays.map((w) => (
            <button key={w.weekday} type="button" aria-current={date === w.canonicalDate ? "true" : undefined} onClick={() => { if (date === w.canonicalDate || (!(pickupDirty || dropoffDirty) || window.confirm("저장하지 않은 변경이 있습니다. 이동할까요?"))) setDate(w.canonicalDate); }}
              // 지금 보는 요일 = 탭 칩(보조 색, 체크 표시 없음)
              className={`academy-choice is-tab ${date === w.canonicalDate ? "is-selected" : ""}`}>
              {w.label}
            </button>
          ))}
        </div>

        {/* 기사님 링크 — 하나만 전달하면 매일 '오늘 운행'이 자동으로 뜬다(날짜별 생성 불필요). */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* 링크 설명문 제거 — 버튼 라벨과 복사 성공 토스트("매일 열면 오늘 운행")로 이미 두 번 안내된다 */}
          <button type="button" onClick={copyRollingLink} className="academy-button-secondary">기사님 운행 링크 복사</button>
        </div>

        {err && <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs text-[var(--color-academy-danger)]">{err}</p>}
        {msg && <p className="mt-2 rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-xs text-[var(--color-academy-success)]">{msg}</p>}

        <p className="mt-3 text-sm font-semibold text-[var(--color-academy-ink)]">{activeWeekdayLabel || "-"} 노선</p>

        {/* 하루 타임라인: 등원 → 하원 */}
        <div className="mt-2 space-y-3">
          <RouteSection initial={initialPickup} date={date} refreshKey={refreshKey} onDirtyChange={onPickupDirty} />
          <RouteSection initial={initialDropoff} date={date} refreshKey={refreshKey} onDirtyChange={onDropoffDirty} />
        </div>
      </div>
    </div>
  );
}
