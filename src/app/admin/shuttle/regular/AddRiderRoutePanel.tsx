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
          className={`min-h-9 w-full rounded-lg border border-dashed px-2 py-1 text-left text-[11.5px] font-black ${isSlot(k) ? "border-brand-orange-500 bg-orange-50 text-brand-orange-600 dark:bg-orange-950/30" : "border-gray-300 text-gray-400 dark:border-gray-600"}`}>
          ＋ 여기에 새 정차{sugSlot(k) ? " · 추천" : ""}{isSlot(k) ? " ✓" : ""}
        </button>
      </li>
    );

    return (
      <div key={d.dir} className="rounded-xl border border-gray-200 p-2.5 dark:border-gray-700">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-black ${d.dir === "BOARD" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200" : "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200"}`}>{d.dir === "BOARD" ? "⬆ 등원" : "⬇ 하원"}</span>
          <span className="text-[11.5px] font-bold text-gray-400">현재 {list.length}곳 · {list.reduce((n, s) => n + s.rows.length, 0)}명</span>
        </div>
        <p className="mt-1.5 text-[13px] font-black text-gray-900 dark:text-white">
          {where}
          {res.isSuggested
            ? <span className="ml-1.5 rounded bg-green-50 px-1.5 py-0.5 text-[10.5px] font-black text-green-700 dark:bg-green-950/30 dark:text-green-300">추천</span>
            : <button type="button" onClick={() => onOverride(key, null)} className="ml-1.5 text-[11px] font-black text-gray-500 underline">추천으로 되돌리기</button>}
        </p>
        <p className="mt-0.5 text-[11.5px] text-gray-500 dark:text-gray-400">추천: {res.suggestion.reason}{d.pointLabel ? ` (학생 위치: ${d.pointLabel})` : ""}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {res.choice.kind === "JOIN" ? (
            <span className="text-[12px] font-bold text-gray-600 dark:text-gray-300">{label} 시각 <b className="text-blue-600 dark:text-blue-300">{res.arriveTime ?? "미정"}</b> (합류 정차 시각)</span>
          ) : (
            <label className="flex items-center gap-1.5 text-[12px] font-bold text-gray-600 dark:text-gray-300">{label} 시각
              <input type="time" value={toTimeInput(res.arriveTime)} onChange={(e) => onOverride(key, { choice: res.choice, arriveTime: e.target.value })}
                aria-label={`${WEEKDAY_LABELS[slot.weekday]} ${slot.classTime} ${label} 시각`}
                className="rounded-lg border border-gray-200 px-1.5 py-1 text-[13px] font-black text-blue-600 dark:border-gray-600 dark:bg-gray-900 dark:text-blue-300" />
              {!res.arriveTime && <span className="text-[11px] text-amber-600">앞뒤 시각이 없어 비어 있습니다</span>}
            </label>
          )}
        </div>
        {res.warnings.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[11.5px] font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {res.warnings.map((w) => <li key={w}>⚠ {w}</li>)}
          </ul>
        )}
        {res.suggestion.skippedNoCoord.length > 0 && (
          <p className="mt-1 text-[11px] text-gray-400">좌표 없는 정차 {res.suggestion.skippedNoCoord.length}곳은 거리 계산에서 뺐습니다: {res.suggestion.skippedNoCoord.join(", ")}</p>
        )}
        {/* 현재 운행표 — 기사님 화면 순서 그대로. 정차 사이 「여기에 새 정차」 / 정차 옆 「합류」로 자리를 고른다. */}
        <details open className="mt-2">
          <summary className="cursor-pointer text-[12px] font-black text-gray-600 dark:text-gray-300">현재 운행표 · 넣을 자리 고르기</summary>
          {list.length === 0 && <p className="mt-1 text-[11.5px] text-gray-400">이 수업·방향에 아직 정차가 없습니다. 첫 정차로 들어갑니다.</p>}
          <ol className="mt-1.5 space-y-1">
            {list.length > 0 && slotButton(0)}
            {list.map((s, i) => (
              <li key={`${s.label}-${s.rows[0]?.rowId ?? i}`} className="space-y-1">
                <div className={`flex items-start gap-2 rounded-lg border p-2 ${isJoin(i) ? "border-brand-orange-500 bg-orange-50 dark:bg-orange-950/30" : "border-gray-200 dark:border-gray-700"}`}>
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-gray-700 text-[11px] font-black text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-black text-gray-900 dark:text-white">{s.label}
                      <span className="ml-1.5 text-[12px] font-black text-blue-600 dark:text-blue-300">{s.arriveTime ?? ""}</span>
                      {s.lat == null && <span title="좌표 없음" className="ml-1 text-[11px] font-black text-amber-500">⚠︎</span>}
                    </p>
                    <p className="text-[11.5px] text-gray-500 dark:text-gray-400">{s.rows.length}명 · {s.rows.map((r) => r.name).join(", ")}</p>
                  </div>
                  <button type="button" onClick={() => choose({ kind: "JOIN", stopIndex: i })} aria-pressed={isJoin(i)}
                    className={`min-h-9 shrink-0 rounded-lg px-2.5 py-1 text-[11.5px] font-black ${isJoin(i) ? "bg-brand-orange-500 text-white" : "border border-gray-200 text-gray-600 dark:border-gray-600 dark:text-gray-200"}`}>
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
    <section className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
      <p className="text-sm font-black text-gray-900 dark:text-white">현재 운행표 대조 · 넣을 자리</p>
      <p className="mt-0.5 text-[11.5px] text-gray-500 dark:text-gray-400">기사님 화면 순서 그대로입니다. 추천 자리가 기본으로 골라져 있고, 바꾸려면 아래 운행표에서 누르세요.</p>
      {/* 수업 탭 — 여러 수업을 골랐으면 수업마다 따로 자리를 고른다. */}
      {slots.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="수업 선택">
          {slots.map((s, i) => (
            <button key={`${s.weekday}|${s.classTime}`} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
              className={`min-h-8 rounded-lg px-2.5 text-[12px] font-black ${i === Math.min(tab, slots.length - 1) ? "bg-brand-navy-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-gray-100 text-gray-500 dark:bg-gray-900"}`}>
              {WEEKDAY_LABELS[s.weekday]} {s.classTime}
            </button>
          ))}
        </div>
      )}
      {slots.length === 1 && <p className="mt-2 text-[12.5px] font-black text-gray-700 dark:text-gray-200">{WEEKDAY_LABELS[slot.weekday]}요일 {slot.classTime}</p>}
      <div className="mt-2 space-y-2">{directions.map((d) => card(d))}</div>
    </section>
  );
}
