// @ts-expect-error Node 순수 계산 검사에서 직접 실행한다.
import { isClockMinute } from "./confirmedEta.ts";
import type { PlanPoint, PlanRun, PlanStop, PlanIssue, PlanDeliveredSnapshot, PlanImpact, PlanTimeEntry } from "./routePlanningTypes";

const distance = (a: PlanPoint, b: PlanPoint) => {
  const rad = Math.PI / 180;
  const h = Math.sin((a.lat - b.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((a.lng - b.lng) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
};
const validPoint = (p: PlanPoint) => !!p.id && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
const clone = (run: PlanRun): PlanRun => ({ ...run, stops: run.stops.map(s => ({ ...s, students: s.students.map(p => ({ ...p })) })), legs: run.legs.map(l => ({ ...l })) });
function road(run: PlanRun, a: PlanPoint, b: PlanPoint) {
  if (distance(a, b) < 0.001) return { minutes: 0, verified: true };
  const leg = run.legs.find(l => l.fromId === a.id && l.toId === b.id);
  if (leg && Number.isInteger(leg.minutes) && leg.minutes > 0 && leg.minutes < 1440) return { minutes: leg.minutes, verified: leg.verified && leg.provider !== "ESTIMATE" };
  return { minutes: Math.max(1, Math.ceil(distance(a, b) * 3)), verified: false };
}

/** 출발·도착 기준과 개별 도로 구간 시간을 사용한다. 총 시간을 임의 비율로 나누지 않는다. */
export function recalculatePlan(input: PlanRun[]): { runs: PlanRun[]; issues: PlanIssue[]; canConfirm: boolean } {
  const issues: PlanIssue[] = [];
  const runIds = new Set<string>();
  const serviceKeys = new Set<string>();
  const runs = input.map(original => {
    const run = clone(original);
    const issue = (code: string, message: string, stopId?: string) => issues.push({ code, message, runId: run.id, ...(stopId ? { stopId } : {}) });
    if (!run.id || runIds.has(run.id)) issue("DUPLICATE_RUN", "운행 식별값을 확인해 주세요.");
    runIds.add(run.id);
    if (!["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(run.dayOfWeek)) issue("INVALID_DAY", "운행 요일을 확인해 주세요.");
    if (![run.anchorMin, run.classStartMin, run.classEndMin].every(isClockMinute) || run.classEndMin <= run.classStartMin) issue("INVALID_TIME", "수업·기준 시각을 확인해 주세요.");
    if (!Number.isInteger(run.capacity) || run.capacity < 1) issue("CAPACITY", "차량 정원을 확인해 주세요.");
    const ids = new Set<string>(); const students = new Set<string>();
    for (const stop of run.stops) {
      if (!validPoint(stop) || ids.has(stop.id) || stop.id === run.start.id || stop.id === run.end.id) issue("INVALID_STOP", "정류장 위치와 식별값을 확인해 주세요.", stop.id);
      ids.add(stop.id);
      for (const rider of stop.students) {
        if (!rider.studentId || students.has(rider.studentId)) issue("DUPLICATE_STUDENT", "같은 운행에 학생이 중복됐습니다.", stop.id);
        students.add(rider.studentId);
        const serviceKey = `${rider.studentId}/${run.dayOfWeek}/${run.direction}`;
        if (serviceKeys.has(serviceKey)) issue("DUPLICATE_SERVICE", "같은 요일·방향에 학생이 중복 배정됐습니다.", stop.id);
        serviceKeys.add(serviceKey);
      }
      if (stop.locked && !isClockMinute(stop.etaMin)) issue("LOCKED_TIME_REQUIRED", "이미 운행한 정류장의 확정 시각을 확인해 주세요.", stop.id);
      if (stop.manualMin != null && !isClockMinute(stop.manualMin)) issue("INVALID_TIME", "수동 시각은 하루 안의 분 단위여야 합니다.", stop.id);
      if (!Number.isInteger(stop.dwellMin ?? 1) || (stop.dwellMin ?? 1) < 0 || (stop.dwellMin ?? 1) > 60) issue("INVALID_DWELL", "정차 시간을 확인해 주세요.", stop.id);
    }
    if (!validPoint(run.start) || !validPoint(run.end)) issue("INVALID_POINT", "운행 시작·도착 위치를 확인해 주세요.");
    if (students.size > run.capacity) issue("CAPACITY", "차량 정원을 초과했습니다.");
    const points = [run.start, ...run.stops, run.end];
    const legs = points.slice(1).map((p, i) => {
      const leg = road(run, points[i], p);
      if (!leg.verified) issue("ROAD_REQUIRED", "도로 구간 시간을 확인해야 확정할 수 있습니다.", p.id);
      return leg.minutes;
    });
    const dwell = (stop: PlanStop) => Number.isInteger(stop.dwellMin ?? 1) && (stop.dwellMin ?? 1) >= 0 ? stop.dwellMin ?? 1 : 1;
    if (run.direction === "PICKUP") {
      if (run.anchorMin > run.classStartMin) issue("CLASS_ARRIVAL", "수업 시작 전 학원에 도착해야 합니다.");
      let cursor = run.anchorMin;
      for (let i = run.stops.length - 1; i >= 0; i--) {
        const stop = run.stops[i]; const latest = cursor - legs[i + 1] - dwell(stop);
        const pin = stop.manualMin ?? (stop.locked ? stop.etaMin : null);
        if (pin != null && pin > latest) issue("MANUAL_CONFLICT", "고정 시각으로 다음 정류장에 도착할 수 없습니다.", stop.id);
        stop.etaMin = pin ?? latest; cursor = stop.etaMin;
      }
      run.departMin = cursor - legs[0]; run.arriveMin = run.anchorMin;
    } else if (run.direction === "DROPOFF") {
      const cleanup = run.cleanupMin ?? 5;
      if (!Number.isInteger(cleanup) || cleanup < 5 || run.anchorMin < run.classEndMin + cleanup) issue("CLEANUP", "수업 후 정리 시간 5분 이상을 확보해 주세요.");
      let cursor = run.anchorMin;
      for (let i = 0; i < run.stops.length; i++) {
        const stop = run.stops[i]; const earliest = cursor + legs[i];
        const pin = stop.manualMin ?? (stop.locked ? stop.etaMin : null);
        if (pin != null && pin < earliest) issue("MANUAL_CONFLICT", "고정 시각까지 도착할 수 없습니다.", stop.id);
        stop.etaMin = pin ?? earliest; cursor = stop.etaMin + dwell(stop);
      }
      run.departMin = run.anchorMin; run.arriveMin = cursor + legs[legs.length - 1];
    } else issue("DIRECTION", "운행 방향을 확인해 주세요.");
    if (![run.departMin, run.arriveMin, ...run.stops.map(s => s.etaMin)].every(isClockMinute)) issue("DAY_BOUNDARY", "운행 시각이 하루 범위를 벗어났습니다.");
    if (run.nextRunDepartMin != null && (!isClockMinute(run.nextRunDepartMin) || (run.arriveMin ?? Infinity) > run.nextRunDepartMin)) issue("NEXT_RUN", "다음 운행 출발 시각과 겹칩니다.");
    return run;
  });
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.dayOfWeek !== b.dayOfWeek || (a.vehicleId !== b.vehicleId && a.driverUserId !== b.driverUserId)) continue;
    if (![a.departMin, a.arriveMin, b.departMin, b.arriveMin].every(isClockMinute)) continue;
    const [first, second] = a.departMin! <= b.departMin! ? [a, b] : [b, a];
    const transfer = road(first, first.end, second.start);
    if (!transfer.verified) issues.push({ code: "TRANSFER_REQUIRED", message: "다음 운행 시작점까지 이동 시간을 확인해 주세요.", runId: first.id });
    if (first.arriveMin! + transfer.minutes > second.departMin!) issues.push({ code: "RUN_OVERLAP", message: "같은 차량·기사님의 다른 운행 시각과 겹칩니다.", runId: second.id });
  }
  return { runs, issues, canConfirm: issues.length === 0 };
}

export function reorderPlanStop(input: PlanRun, stopId: string, toIndex: number): PlanRun {
  const run = clone(input); const from = run.stops.findIndex(s => s.id === stopId);
  if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= run.stops.length) throw new Error("정류장 순서를 확인해 주세요.");
  if (run.stops.slice(Math.min(from, toIndex), Math.max(from, toIndex) + 1).some(s => s.locked)) throw new Error("이미 운행한 정류장은 이동할 수 없습니다.");
  const [stop] = run.stops.splice(from, 1); run.stops.splice(toIndex, 0, stop); return run;
}

export function recommendInsertion(input: PlanRun, incoming: PlanStop): { run: PlanRun; index: number; estimated: boolean; addedMinutes: number } {
  const run = clone(input);
  if (!validPoint(incoming)) throw new Error("새 정류장 위치를 확인해 주세요.");
  const same = run.stops.findIndex(s => !s.locked && distance(s, incoming) <= 0.03);
  if (same >= 0) {
    const existing = new Set(run.stops.flatMap(s => s.students.map(p => p.studentId)));
    if (incoming.students.some(p => existing.has(p.studentId))) throw new Error("이미 배정된 학생입니다.");
    run.stops[same].students.push(...incoming.students.map(p => ({ ...p })));
    run.stops[same].recommended = true;
    return { run, index: same, estimated: false, addedMinutes: 0 };
  }
  const points = [run.start, ...run.stops, run.end];
  const firstAllowed = run.stops.reduce((n, s, i) => s.locked ? i + 1 : n, 0);
  const options = points.slice(0, -1).flatMap((a, index) => {
    if (index < firstAllowed) return [];
    const b = points[index + 1]; const left = road(run, a, incoming); const right = road(run, incoming, b); const prior = road(run, a, b);
    return [{ index, estimated: !left.verified || !right.verified || !prior.verified, addedMinutes: left.minutes + right.minutes - prior.minutes, addedDistance: distance(a, incoming) + distance(incoming, b) - distance(a, b) }];
  });
  const verified = options.filter(o => !o.estimated);
  const best = (verified.length ? verified : options).sort((a, b) => verified.length ? a.addedMinutes - b.addedMinutes : a.addedDistance - b.addedDistance)[0];
  if (!best) throw new Error("삽입할 운행 구간이 없습니다.");
  run.stops.splice(best.index, 0, { ...incoming, students: incoming.students.map(p => ({ ...p })), recommended: true });
  return { run, index: best.index, estimated: best.estimated, addedMinutes: best.addedMinutes };
}

export function planLocationKey(point: PlanPoint): string {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || typeof point.label !== "string") return "INVALID_LOCATION";
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}:${point.label.trim().replace(/\s+/g, " ")}`;
}
function entries(runs: PlanRun[]): PlanTimeEntry[] {
  return runs.flatMap(r => r.stops.flatMap(s => validPoint(s) && isClockMinute(s.etaMin) ? s.students.map(p => ({ studentId: p.studentId, dayOfWeek: r.dayOfWeek, direction: r.direction, timeMin: s.etaMin as number, locationKey: planLocationKey(s), locationLabel: s.label })) : []));
}
const key = (e: PlanTimeEntry) => `${e.dayOfWeek}/${e.direction}`;
/** 발송 성공 기준만 누적 비교한다. 기존 학생의 기준 누락은 첫 안내로 오인하지 않는다. */
export function computePlanImpacts(beforeRuns: PlanRun[], afterRuns: PlanRun[], snapshots: PlanDeliveredSnapshot[]): PlanImpact[] {
  const before = entries(beforeRuns); const after = entries(afterRuns);
  const riders = afterRuns.flatMap(r => r.stops.flatMap(s => s.students));
  return [...new Set(after.map(e => e.studentId))].map(studentId => {
    const rider = riders.find(p => p.studentId === studentId)!;
    const old = before.filter(e => e.studentId === studentId); const next = after.filter(e => e.studentId === studentId);
    const snapshot = snapshots.find(s => s.studentId === studentId && (s.delivered || (s.source === "ADMIN_CONFIRMED" && s.confirmed))
      && s.entries.length > 0 && s.entries.every(e => e.studentId === studentId && isClockMinute(e.timeMin) && !!e.locationKey)
      && new Set(s.entries.map(key)).size === s.entries.length);
    const serviceScope = new Set([...old, ...next].map(e => `${e.dayOfWeek}/${e.direction}`));
    const baseline = snapshot?.entries.filter(e => e.studentId === studentId && serviceScope.has(`${e.dayOfWeek}/${e.direction}`));
    const source = baseline ?? old;
    const reasons: PlanImpact["reasons"] = [];
    const changed = JSON.stringify(old.map(e => [key(e), e.timeMin, e.locationKey]).sort()) !== JSON.stringify(next.map(e => [key(e), e.timeMin, e.locationKey]).sort());
    const isNew = riders.some(p => p.studentId === studentId && p.isNew === true) && old.length === 0;
    const incomplete = !snapshot || old.some(e => !baseline?.some(b => key(b) === key(e)));
    const baselineRequired = incomplete && !isNew && changed;
    if (isNew) reasons.push("FIRST_NOTICE");
    if (baselineRequired) reasons.push("BASELINE_REQUIRED");
    const legs = next.map(e => {
      const prior = source.find(p => key(p) === key(e)); const delta = prior ? e.timeMin - prior.timeMin : null;
      if (snapshot) {
        if (!prior && !reasons.includes("SERVICE_CHANGED")) reasons.push("SERVICE_CHANGED");
        if (prior && Math.abs(delta!) >= 5 && !reasons.includes("TIME_5_MIN")) reasons.push("TIME_5_MIN");
        if (prior && prior.locationKey !== e.locationKey && !reasons.includes("LOCATION_CHANGED")) reasons.push("LOCATION_CHANGED");
      }
      return { dayOfWeek: e.dayOfWeek, direction: e.direction, beforeMin: prior?.timeMin ?? null, afterMin: e.timeMin, deltaMin: delta, beforeLocation: prior?.locationLabel ?? null, afterLocation: e.locationLabel };
    });
    if (snapshot && source.some(e => !next.some(n => key(n) === key(e))) && !reasons.includes("SERVICE_CHANGED")) reasons.push("SERVICE_CHANGED");
    return { studentId, studentName: rider.name, legs, notify: !baselineRequired && reasons.length > 0, baselineRequired, reasons };
  });
}
