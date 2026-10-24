export type AssignedDriverRow = {
  direction: string;
  driverUserId: string | null;
  validDriverId: string | null;
};

export type AssignedDriverResolution = {
  driverIds: string[];
  needsConfirmation: boolean;
};

const DAY_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function buildDriverLookupContext(serviceDate: string, direction?: "PICKUP" | "DROPOFF" | "BOTH") {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ? new Date(`${serviceDate}T12:00:00+09:00`) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return {
    serviceMonth: serviceDate.slice(0, 7),
    dayOfWeek: DAY_OF_WEEK[date.getUTCDay()],
    directions: direction && direction !== "BOTH" ? [direction] : ["PICKUP", "DROPOFF"],
  };
}

/**
 * 학생이 실제 포함된 차량 행만 받아 담당 기사를 확정한다.
 * 한 방향에서 미배정·권한 오류·복수 기사가 나오면 오발송을 막기 위해 전체를 보류한다.
 */
export function selectAssignedDriverIds(rows: AssignedDriverRow[]): AssignedDriverResolution {
  if (rows.length === 0) return { driverIds: [], needsConfirmation: true };
  for (const direction of new Set(rows.map((row) => row.direction))) {
    const directionRows = rows.filter((row) => row.direction === direction);
    if (directionRows.some((row) => !row.driverUserId || !row.validDriverId)) {
      return { driverIds: [], needsConfirmation: true };
    }
    if (new Set(directionRows.map((row) => row.validDriverId)).size !== 1) {
      return { driverIds: [], needsConfirmation: true };
    }
  }
  return {
    driverIds: [...new Set(rows.map((row) => row.validDriverId).filter((id): id is string => Boolean(id)))],
    needsConfirmation: false,
  };
}
