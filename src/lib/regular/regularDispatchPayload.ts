const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const inRangeOrMissing = (value: unknown, min: number, max: number) => value == null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
const timeOrMissing = (value: unknown) => value == null || (typeof value === "string" && /^\d{2}:\d{2}$/.test(value));

/** 확정 노선 저장에 필요한 최소 구조를 검증하고, 비정상·과대 payload는 저장 전에 차단한다. */
export function validateRegularDispatchVehicles(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("차량 배차 형식이 올바르지 않습니다.");
  const seenStudents = new Set<string>();
  for (const vehicle of value) {
    if (!isPlainObject(vehicle) || !Array.isArray(vehicle.stops) || vehicle.stops.length > 100) {
      throw new Error("차량 또는 정차 목록 형식이 올바르지 않습니다.");
    }
    if (vehicle.driverUserId != null
      && (typeof vehicle.driverUserId !== "string" || !vehicle.driverUserId.trim()
        || vehicle.driverUserId !== vehicle.driverUserId.trim() || vehicle.driverUserId.length > 120)) {
      throw new Error("담당 기사 식별값이 올바르지 않습니다.");
    }
    if (!timeOrMissing(vehicle.classStart) || !timeOrMissing(vehicle.classEnd)) throw new Error("차량 실행의 수업시간 형식이 올바르지 않습니다.");
    for (const stop of vehicle.stops) {
      if (!isPlainObject(stop) || typeof stop.label !== "string" || stop.label.trim().length === 0 || stop.label.length > 200) {
        throw new Error("정차 위치 형식이 올바르지 않습니다.");
      }
      if (!inRangeOrMissing(stop.lat, -90, 90) || !inRangeOrMissing(stop.lng, -180, 180)
        || !inRangeOrMissing(stop.etaMinutes, 0, 1439) || !inRangeOrMissing(stop.etaManual, 0, 1439)) {
        throw new Error("정차 좌표 또는 시각 형식이 올바르지 않습니다.");
      }
      if (!Array.isArray(stop.students) || stop.students.length > 100) throw new Error("정차 학생 목록 형식이 올바르지 않습니다.");
      for (const student of stop.students) {
        if (!isPlainObject(student) || typeof student.requestId !== "string" || !student.requestId.trim() || student.requestId.length > 120) {
          throw new Error("배차 학생 식별값이 올바르지 않습니다.");
        }
        if (seenStudents.has(student.requestId)) throw new Error("같은 학생이 확정 노선에 중복 배정되었습니다.");
        seenStudents.add(student.requestId);
      }
    }
  }
  return value;
}
