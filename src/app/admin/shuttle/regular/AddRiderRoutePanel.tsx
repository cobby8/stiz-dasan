"use client";

import { useState } from "react";
import type { RegularShuttleStop } from "@/lib/shuttle/regularSheet";
import { placementKey, WEEKDAY_LABELS, type RosterClassSlot } from "@/lib/shuttle/regularRosterEditLogic";
// ⚠️ 운행표는 기사님 화면과 같은 함수(findRouteCell → buildFallbackClasses·selectDriverDayRows)로 그린다.
//    추천·시각·저장 요청도 resolveCellPlacement 한 곳에서 계산한다(화면과 저장이 어긋나지 않게).
import { resolveCellPlacement, type GeoPoint, type PlacementChoice, type PlacementOverride } from "@/lib/shuttle/regularRosterPlacementLogic";

// 학생 추가 모달 안의 「현재 운행표 대조 · 넣을 자리」 패널.
// 고른 수업(요일·수업시간)마다 등원·하원 운행 순서를 보여 주고, 추천 자리(합류/중간 삽입)를 기본으로 고른다.
// 원장은 「여기에 새 정차」(정차 사이) 또는 「합류」(기존 정차)를 눌러 바꿀 수 있다.

type Dir = "BOARD" | "ALIGHT";
/** pointLabel: 추천에 쓴 학생 위치의 출처(예: 「월요일에 타는 정류장 「X」 기준」). */
export type PanelDirection = { dir: Dir; stopName: string; point: GeoPoint | null; pointLabel?: string };

/** time 입력칸은 'HH:MM' 두 자리만 받는다. */
function toTimeInput(v: string | null): string {
  const m = (v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

export default function AddRiderRoutePanel({ stops, slots, directions, academy, depot, studentId, overrides, onOverride }: {
  stops: RegularShuttleStop[];
  slots: RosterClassSlot[];
  directions: PanelDirection[];
  academy: GeoPoint | null;
  depot: GeoPoint | null;
  studentId: string | null;
  overrides: Record<string, PlacementOverride>;
  onOverride: (key: string, next: PlacementOverride | null) => void;
}) {
  const [tab, setTab] = useState(0);
  if (slots.length === 0 || directions.length === 0) return null;
  const slot = slots[Math.min(tab, slots.length - 1)];

  // 한 방향 카드 — 함수로 호출한다(컴포넌트로 만들면 렌더마다 새로 만들어져 시각 입력 포커스가 풀린다).
  function card(d: PanelDirection) {
    const key = placementKey(slot.weekday, slot.classTime, d.dir);
    const ov = overrides[key];
    const res = resolveCellPlacement({
      stops, weekday: slot.weekday, classTime: slot.classTime, direction: d.dir, stopName: d.stopName,
      student: d.point, academy, depot, studentId, override: ov,
    });
    const list = res.stops;
    const label = d.dir === "BOARD" ? "등원" : "하원";
    const choose = (choice: PlacementChoice) => onOverride(key, { choice }); // 자리를 바꾸면 시각은 그 자리 기준으로 다시 계산
    const isJoin = (i: number) => res.choice.kind === "JOIN" && res.choice.stopIndex === i;
    const isSlot = (k: number) => res.choice.kind === "INSERT" && res.choice.position === k;
    const sugJoin = (i: number) => res.suggestion.choice.kind === "JOIN" && res.suggestion.choice.stopIndex === i;
    const sugSlot = (k: number) => res.suggestion.choice.kind === "INSERT" && res.suggestion.choice.position === k;
    const where = res.choice.kind === "JOIN"
      ? `「${list[res.choice.stopIndex]?.label}」 정차에 합류`
      : list.length === 0 ? "첫 정차로"
        : res.choice.position === 0 ? "맨 앞에 새 정차"
          : res.choice.position >= list.length ? "맨 뒤에 새 정차" : `${res.choice.position}번 「${list[res.choice.position - 1].label}」 다음에 새 정차`;

    const slotButton = (k: number) => (
      <li key={`slot-${k}`}>
        <button type="button" onClick={() => choose({ kind: "INSERT", position: k })} aria-pressed={isSlot(k)}
          className={`min-h-9 w-full rounded-lg border border-dashed px-2 py-1 text-left text-xs font-medium ${isSlot(k) ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]" : "border-[var(--color-academy-line-input)] text-[var(--color-academy-faint)]"}`}>
          ＋ 여기에 새 정차{sugSlot(k) ? " · 추천" : ""}{isSlot(k) ? " ✓" : ""}
        </button>
      </li>
    );

    return (
      <div key={d.dir} className="rounded-xl border border-[var(--color-academy-line)] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs ${d.dir === "BOARD" ? "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]" : "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]"}`}>{d.dir === "BOARD" ? "등원" : "하원"}</span>
          <span className="text-xs text-[var(--color-academy-faint)]">현재 {list.length}곳 · {list.reduce((n, s) => n + s.rows.length, 0)}명</span>
        </div>
        <p className="mt-1.5 text-sm font-semibold text-[var(--color-academy-ink)]">
          {where}
          {res.isSuggested
            ? <span className="ml-1.5 rounded bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-success)]">추천</span>
            : <button type="button" onClick={() => onOverride(key, null)} className="ml-1.5 text-xs font-medium text-[var(--color-academy-muted)] underline">추천으로 되돌리기</button>}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">추천: {res.suggestion.reason}{d.pointLabel ? ` (학생 위치: ${d.pointLabel})` : ""}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {res.choice.kind === "JOIN" ? (
            <span className="text-xs text-[var(--color-academy-muted)]">{label} 시각 <b className="text-[var(--color-academy-muted)]">{res.arriveTime ?? "미정"}</b> (합류 정차 시각)</span>
          ) : (
            <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-academy-muted)]">{label} 시각
              <input type="time" value={toTimeInput(res.arriveTime)} onChange={(e) => onOverride(key, { choice: res.choice, arriveTime: e.target.value })}
                aria-label={`${WEEKDAY_LABELS[slot.weekday]} ${slot.classTime} ${label} 시각`}
                className="rounded-lg border border-[var(--color-academy-line)] px-1.5 py-1 text-sm font-semibold text-[var(--color-academy-muted)]" />
              {!res.arriveTime && <span className="text-xs text-[var(--color-academy-warning)]">앞뒤 시각이 없어 비어 있습니다</span>}
            </label>
          )}
        </div>
        {res.warnings.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 rounded-lg bg-[var(--color-academy-warning-soft)] px-2 py-1.5 text-xs text-[var(--color-academy-warning)]">
            {res.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        {res.suggestion.skippedNoCoord.length > 0 && (
          <p className="mt-1 text-xs text-[var(--color-academy-faint)]">좌표 없는 정차 {res.suggestion.skippedNoCoord.length}곳은 거리 계산에서 뺐습니다: {res.suggestion.skippedNoCoord.join(", ")}</p>
        )}
        {/* 현재 운행표 — 기사님 화면 순서 그대로. 정차 사이 「여기에 새 정차」 / 정차 옆 「합류」로 자리를 고른다. */}
        <details open className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--color-academy-muted)]">현재 운행표 · 넣을 자리 고르기</summary>
          {list.length === 0 && <p className="mt-1 text-xs text-[var(--color-academy-faint)]">이 수업·방향에 아직 정차가 없습니다. 첫 정차로 들어갑니다.</p>}
          <ol className="mt-1.5 space-y-1">
            {list.length > 0 && slotButton(0)}
            {list.map((s, i) => (
              <li key={`${s.label}-${s.rows[0]?.rowId ?? i}`} className="space-y-1">
                <div className={`flex items-start gap-2 rounded-lg border p-2 ${isJoin(i) ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)]" : "border-[var(--color-academy-line)]"}`}>
                  {/* 순번은 버튼이 아니다 — 꽉 찬 주 색 대신 옅은 바탕(기사님 화면 순번과 같은 모양) */}
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-academy-primary-soft)] text-xs font-semibold tabular-nums text-[var(--color-academy-ink)]">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[var(--color-academy-ink)]">{s.label}
                      <span className="ml-1.5 text-xs font-semibold text-[var(--color-academy-muted)]">{s.arriveTime ?? ""}</span>
                      {s.lat == null && <span className="ml-1 text-xs font-normal text-[var(--color-academy-warning)]">좌표 없음</span>}
                    </p>
                    <p className="text-xs text-[var(--color-academy-muted)]">{s.rows.length}명 · {s.rows.map((r) => r.name).join(", ")}</p>
                  </div>
                  <button type="button" onClick={() => choose({ kind: "JOIN", stopIndex: i })} aria-pressed={isJoin(i)}
                    className={`min-h-9 shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium ${isJoin(i) ? "bg-[var(--color-academy-surface)] text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]" : "border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] text-[var(--color-academy-muted)]"}`}>
                    {isJoin(i) ? "합류 ✓" : "합류"}{sugJoin(i) && !isJoin(i) ? " · 추천" : ""}
                  </button>
                </div>
                {slotButton(i + 1)}
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-academy-line)] p-3">
      <p className="text-sm font-semibold text-[var(--color-academy-ink)]">현재 운행표 대조 · 넣을 자리</p>
      <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">기사님 화면 순서 그대로입니다. 추천 자리가 기본으로 골라져 있고, 바꾸려면 아래 운행표에서 누르세요.</p>
      {/* 수업 탭 — 여러 수업을 골랐으면 수업마다 따로 자리를 고른다. */}
      {slots.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="수업 선택">
          {slots.map((s, i) => (
            <button key={`${s.weekday}|${s.classTime}`} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
              className={`min-h-8 rounded-lg px-2.5 text-xs font-medium ${i === Math.min(tab, slots.length - 1) ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>
              {WEEKDAY_LABELS[s.weekday]} {s.classTime}
            </button>
          ))}
        </div>
      )}
      {slots.length === 1 && <p className="mt-2 text-xs font-semibold text-[var(--color-academy-muted)]">{WEEKDAY_LABELS[slot.weekday]}요일 {slot.classTime}</p>}
      <div className="mt-2 space-y-2">{directions.map((d) => card(d))}</div>
    </section>
  );
}
