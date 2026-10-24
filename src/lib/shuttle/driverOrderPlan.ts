import { assembleRegularDriverClasses } from "./regularDriverRouteLogic";
import { buildUnifiedRun } from "./unifiedDriverRunLogic";
import type { RegularShuttleStop } from "./regularSheet";

export class DriverOrderError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export type DriverOrderUpdate = { rowIds: string[]; sortOrder: number; arriveTime: string | null };
type Direction = "PICKUP" | "DROPOFF";
type JsonObject = Record<string, unknown>;
export type DriverOrderRoute = { id: string; direction: Direction; payload: JsonObject };
const object = (value: unknown): JsonObject => value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const groupKey = (ids: string[]) => [...ids].sort().join("|");

export function parseDriverOrderUpdates(raw: unknown): DriverOrderUpdate[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1000) throw new DriverOrderError("저장할 정차 정보를 확인해 주세요.", 400);
  const seen = new Set<string>();
  const orders = new Set<number>();
  return raw.map((entry) => {
    const item = object(entry);
    if (!Array.isArray(item.rowIds) || item.rowIds.length === 0) throw new DriverOrderError("정차의 저장 행이 없습니다.", 400);
    const rowIds = item.rowIds.map((id) => {
      if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || seen.has(id)) throw new DriverOrderError("정차 행이 중복되거나 올바르지 않습니다.", 400);
      seen.add(id); return id;
    });
    const sortOrder = item.sortOrder;
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder >= raw.length || orders.has(sortOrder)) throw new DriverOrderError("정차 순서를 다시 확인해 주세요.", 400);
    orders.add(sortOrder);
    let arriveTime: string | null = null;
    if (item.arriveTime != null && item.arriveTime !== "") {
      if (typeof item.arriveTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.arriveTime)) throw new DriverOrderError("시간은 HH:MM 형식으로 입력해 주세요.", 400);
      arriveTime = item.arriveTime;
    }
    return { rowIds, sortOrder, arriveTime };
  });
}

// 같은 화면을 만드는 기존 조립 함수를 재사용하여 이름 추측 없이 명단 행과 확정 정차를 연결한다.
export function planDriverOrder(input: {
  rows: RegularShuttleStop[]; routes: DriverOrderRoute[]; updates: DriverOrderUpdate[]; baseline: DriverOrderUpdate[];
  rowIdsByStudentId: Record<Direction, Map<string, string[]>>;
}): { routes: DriverOrderRoute[] } {
  const { rows, updates } = input;
  const wantedIds = new Set(rows.map(row => row.id!));
  const receivedIds = updates.flatMap(update => update.rowIds);
  if (wantedIds.size === 0 || receivedIds.length !== wantedIds.size || receivedIds.some(id => !wantedIds.has(id))) throw new DriverOrderError("명단이 변경되었거나 다른 날짜의 정차가 포함되어 있습니다. 새로고침 후 다시 저장해 주세요.");
  const saved = { PICKUP: null, DROPOFF: null } as Record<Direction, { vehicles?: unknown } | null>;
  for (const route of input.routes) saved[route.direction] = route.payload;
  const classes = assembleRegularDriverClasses({ dayRows: rows, saved, rowIdsByStudentId: input.rowIdsByStudentId, isAbsent: () => false });
  const current = buildUnifiedRun({ regular: classes }).filter(row => row.riders.some(rider => wantedIds.has(rider.checkId)));
  const baseline = [...input.baseline].sort((a, b) => a.sortOrder - b.sortOrder);
  if (current.length !== baseline.length || current.some((row, index) => groupKey(row.riders.map(rider => rider.checkId)) !== groupKey(baseline[index].rowIds) || row.time !== baseline[index].arriveTime)) {
    throw new DriverOrderError("다른 화면에서 순서나 시간이 변경되었습니다. 새로고침 후 다시 수정해 주세요.");
  }
  const byGroup = new Map(updates.map(update => [groupKey(update.rowIds), update]));
  const accepted = new Set<string>();
  const bindings = new Map<string, DriverOrderUpdate[]>();
  for (const section of classes) {
    const stops = [...section.board, ...section.alight];
    const linked: DriverOrderUpdate[] = [];
    for (const stop of stops) {
      const ids = stop.rows.map(row => row.rowId);
      // 명단에 없는 확정 승객은 추측해 수정하지 않는다. 관리자가 연결을 정리한 뒤 재시도한다.
      if (ids.some(id => id.startsWith("route:"))) throw new DriverOrderError("확정 노선의 학생 연결을 확인하지 못했습니다. 관리자에게 명단 확인을 요청해 주세요.");
      const key = groupKey(ids);
      const update = byGroup.get(key);
      if (!update || accepted.has(key)) throw new DriverOrderError("정차별 학생 구성이 달라졌습니다. 새로고침 후 다시 저장해 주세요.");
      accepted.add(key); linked.push(update);
    }
    bindings.set(section.classTime, linked);
  }
  if (accepted.size !== updates.length) throw new DriverOrderError("일부 정차가 누락되거나 다른 차량의 정차와 합쳐져 있습니다.");
  const routes = input.routes.map(route => {
    const vehicles = array(route.payload.vehicles).map((vehicle, vehicleIndex) => {
      const record = object(vehicle);
      const bound = bindings.get(`${route.direction}#${vehicleIndex}`);
      if (!bound) return vehicle;
      let activeIndex = 0;
      const slots: number[] = [];
      const changed: { stop: JsonObject; order: number }[] = [];
      const stops = [...array(record.stops)];
      stops.forEach((stop, slot) => {
        const current = object(stop);
        if (!array(current.students).some(student => typeof object(student).requestId === "string" && String(object(student).requestId).trim())) return;
        const update = bound[activeIndex++];
        if (!update) return;
        const minutes = update.arriveTime == null ? null : Number(update.arriveTime.slice(0, 2)) * 60 + Number(update.arriveTime.slice(3));
        slots.push(slot);
        changed.push({ order: update.sortOrder, stop: { ...current, etaLabel: update.arriveTime == null ? null : `${update.arriveTime} ${route.direction === "PICKUP" ? "승차" : "하차"}`, etaManual: minutes, etaMinutes: minutes } });
      });
      changed.sort((a, b) => a.order - b.order);
      slots.forEach((slot, index) => { stops[slot] = changed[index].stop; });
      return { ...record, stops };
    });
    return { ...route, payload: { ...route.payload, vehicles } };
  });
  const updateById = new Map(updates.flatMap(update => update.rowIds.map(id => [id, update] as const)));
  const reloadedRows = rows.map(row => ({ ...row, sortOrder: updateById.get(row.id!)!.sortOrder, arriveTime: updateById.get(row.id!)!.arriveTime })).sort((a, b) => a.sortOrder - b.sortOrder);
  const reloadedSaved = { ...saved };
  for (const route of routes) reloadedSaved[route.direction] = route.payload;
  const reloadedMaps = { PICKUP: new Map<string, string[]>(), DROPOFF: new Map<string, string[]>() };
  for (const direction of ["PICKUP", "DROPOFF"] as const) for (const [student, ids] of input.rowIdsByStudentId[direction]) {
    reloadedMaps[direction].set(student, [...ids].sort((a, b) => updateById.get(a)!.sortOrder - updateById.get(b)!.sortOrder));
  }
  const reloaded = buildUnifiedRun({ regular: assembleRegularDriverClasses({ dayRows: reloadedRows, saved: reloadedSaved, rowIdsByStudentId: reloadedMaps, isAbsent: () => false }) })
    .filter(row => row.riders.some(rider => wantedIds.has(rider.checkId)));
  const expected = [...updates].sort((a, b) => a.sortOrder - b.sortOrder);
  if (reloaded.length !== expected.length || reloaded.some((row, index) => groupKey(row.riders.map(rider => rider.checkId)) !== groupKey(expected[index].rowIds) || row.time !== expected[index].arriveTime)) {
    throw new DriverOrderError("순서와 도착 시간이 맞지 않습니다. 도착 시간도 함께 조정한 뒤 다시 저장해 주세요.");
  }
  return { routes };
}
