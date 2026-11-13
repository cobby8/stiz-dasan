"use client";

import { useCallback, useRef, useState } from "react";
import {
  classWindowOfGroupKey,
  legKey,
  neededLegs,
  parseHHMM,
  retimeRun,
  type RetimePoint,
  type RetimeStop,
} from "@/lib/shuttle/routeRetime";
import type { UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";

// 순서를 옮겼을 때 그 묶음 시각을 다시 계산하는 화면 부품 — 관리자 운행표 편집·기사님 화면이 함께 쓴다.
// 흐름: ① 바로 직선 추정으로 계산해 화면에 반영 → ② 지도(T맵) 구간 시간을 받아 오면 한 번 더 계산해 덮어쓴다.
//       ②가 오기 전에 또 옮기거나 시각을 손으로 고치면(버전이 바뀌면) ②의 결과는 버린다.
// 받은 구간 시간은 화면에 머무는 동안 기억해(같은 쌍을 다시 묻지 않는다) T맵 호출을 줄인다.

export type RetimeNote = { groupKey: string; text: string; warn: boolean };
export type RetimeApply = (times: Record<string, string>) => void;

function rowPoint(r: UnifiedRow): RetimePoint | null {
  return r.lat != null && r.lng != null && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { lat: r.lat, lng: r.lng } : null;
}

export function useRouteRetime({ academy, token }: { academy: RetimePoint | null; token?: string }) {
  const cache = useRef(new Map<string, number | null>());
  // 버전은 묶음마다 따로 센다(기사님 화면은 여러 묶음을 한꺼번에 편집 — 다른 묶음을 옮겨도 앞 묶음 지도 보정은 살린다).
  // epoch 는 전체 무효화(손 수정·저장·편집 끝)용.
  const versions = useRef(new Map<string, number>());
  const epoch = useRef(0);
  const [notes, setNotes] = useState<Record<string, RetimeNote>>({});
  const setNote = (n: RetimeNote) => setNotes((cur) => ({ ...cur, [n.groupKey]: n }));

  /**
   * saved   = 그 묶음의 저장된(편집 시작 때) 순서·시각 — «기사님 속도» 배율과 하원 학원 출발 시각의 기준.
   * current = 이번에 옮기기 직전 화면 순서 · after = 옮긴 뒤 순서.
   * timeOf  = 지금 화면 시각(원장이 고친 첫 탑승 시각을 기준으로 쓰기 위해).
   * apply   = 새 시각을 화면에 넣는 함수. 계산할 수 없으면 false 를 돌려준다(호출부가 옛 방식으로 처리).
   */
  const retime = useCallback((groupKey: string, saved: UnifiedRow[], current: UnifiedRow[], after: UnifiedRow[], timeOf: (r: UnifiedRow) => string | null, apply: RetimeApply): boolean => {
    const direction = after[0]?.direction === "DROPOFF" ? "ALIGHT" : "BOARD";
    const toStop = (r: UnifiedRow, time: string | null): RetimeStop => ({ key: r.key, label: r.label, time, point: rowPoint(r) });
    const beforeStops = saved.map((r) => toStop(r, r.time));
    const afterStops = after.map((r) => toStop(r, timeOf(r)));
    // 등원 기준 = 옮기기 직전 화면 맨 앞 칸의 시각(첫 탑승 — 원장이 고쳤으면 그 값).
    const anchorTime = direction === "BOARD" && current[0] ? timeOf(current[0]) : null;
    const { start: classStart } = classWindowOfGroupKey(groupKey);

    const compute = (final: boolean) => {
      const r = retimeRun({
        direction, before: beforeStops, after: afterStops, anchorTime, academy,
        legMinutes: (a, b) => cache.current.get(legKey(a, b)) ?? null,
      });
      if (!r.ok) { setNote({ groupKey, text: r.reason, warn: true }); return false; }
      apply(r.times);
      const late = direction === "BOARD" && r.arrival && classStart && (parseHHMM(r.arrival) ?? 0) > (parseHHMM(classStart) ?? 0);
      const how = r.estimated ? (final ? "직선거리 추정" : "지도 계산 중…") : "지도 기준";
      const tail = direction === "BOARD"
        ? (r.arrival ? ` · 학원 도착 예상 ${r.arrival}${classStart ? `(수업 ${classStart})` : ""}${late ? " — 수업 시작보다 늦어요" : ""}` : "")
        : (r.departure ? ` · 학원 출발 ${r.departure}` : "");
      setNote({ groupKey, text: `시각 자동 계산(${how})${tail}`, warn: Boolean(late) });
      return true;
    };

    const v = (versions.current.get(groupKey) ?? 0) + 1;
    versions.current.set(groupKey, v);
    const e = epoch.current;
    if (!compute(false)) return false;

    // 아직 모르는 구간만 지도에 묻는다.
    const missing = neededLegs({ direction, before: beforeStops, after: afterStops, academy })
      .filter(([a, b]) => !cache.current.has(legKey(a, b)))
      .slice(0, 24);
    if (missing.length === 0) { compute(true); return true; }
    fetch("/api/shuttle/leg-minutes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, pairs: missing.map(([a, b]) => ({ a, b })) }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((j: { minutes?: (number | null)[] } | null) => {
        missing.forEach(([a, b], i) => cache.current.set(legKey(a, b), j?.minutes?.[i] ?? null));
      })
      .catch(() => { missing.forEach(([a, b]) => cache.current.set(legKey(a, b), null)); })
      .finally(() => { if (v === versions.current.get(groupKey) && e === epoch.current) compute(true); });
    return true;
  }, [academy, token]);

  /** 손으로 시각을 고쳤거나 저장을 시작했을 때 — 늦게 도착한 지도 계산이 덮어쓰지 않게(전체). */
  const cancelPending = useCallback(() => { epoch.current++; }, []);
  const clearNote = useCallback(() => { epoch.current++; setNotes({}); }, []);
  // 가장 최근 안내 하나(기사님 화면) — 묶음별 안내는 notes 로 꺼내 쓴다.
  const noteList = Object.values(notes);
  const note = noteList.length > 0 ? noteList[noteList.length - 1] : null;

  return { retime, note, notes, cancelPending, clearNote };
}
