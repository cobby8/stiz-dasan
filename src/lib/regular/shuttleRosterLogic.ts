// 정규 수업 셔틀 "라이더 명단"의 순수 로직 — prisma 등 서버 의존성 절대 금지.
// ─────────────────────────────────────────────────────────────────────────
// 왜 순수 모듈로 떼어 놓는가?
//   방향(등원/하원)별 좌표 선택, 좌표 없는 학생(unassigned) 분리, 정렬, 요일 매핑은
//   "요일·좌표 계산"이라 실수하기 쉽다. 실제 DB 없이 유닛 테스트로 고정해 두려는 것.
//   (방학특강 seasonal/shuttleRoster.ts 의 placeForDirection 규칙을 그대로 따른다 — 엔진 재사용 대비.)
//
// ⚠️ 이 명단은 "신청서(EnrollmentApplication)의 지오코딩 좌표 + Student 연결"이 정본(SSOT)이다.
//    셔틀 명단(RegularShuttleStop)과는 별개의 정합 소스다(병행 존재).

export type RegularShuttleDirection = "PICKUP" | "DROPOFF";

/** 한 사람의 한 방향 위치 한 벌. 신청서 컬럼 이름을 그대로 따라간다(옮겨 담다 흘리는 실수 방지). */
export type RegularShuttlePlace = {
  location: string | null;
  address: string | null;
  roadAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
};

/** 서버가 SQL로 뽑아 넘겨 주는 원시 라이더 1행(등원/하원 위치를 둘 다 들고 있다). */
export type RegularShuttleRawRider = {
  studentId: string;
  /** 이 라이더를 만든 명단 정차행 id(RegularShuttleStop.id). 정규 셔틀 탑승체크 키와 같은 값이라,
   *  저장 배차 노선(식별키=studentId)을 탑승체크 키로 되돌릴 때 쓴다. 소스가 셔틀 명단이 아니면 null. */
  stopRowId?: string | null;
  studentName: string;
  childGrade: string | null;
  childPhone: string | null;
  parentName: string | null;
  parentPhone: string | null;
  classId: string;
  className: string | null;
  dayOfWeek: string;
  classStart: string | null; // 'HH:MM'
  classEnd: string | null;
  /** 좌표 출처 신청서 id(학생 상세 모달을 여는 키). 이용자인데 좌표만 없을 수도 있다. */
  applicationId: string | null;
  /** 신청서의 셔틀 이용 플래그. 좌표가 없어도 true면 "이용자"로 본다. */
  shuttleNeeded: boolean;
  /** 학부모가 적어 낸 희망시간. 형식이 제각각이라 참고값(계산에 쓰지 않는다). */
  pickupTime: string | null;
  pickup: RegularShuttlePlace;
  dropoff: RegularShuttlePlace;
};

/** 방향에 맞춰 이미 위치 한 벌을 고른 라이더(방학특강 ShuttleRosterRider와 유사 shape). */
export type RegularShuttleRider = RegularShuttleRawRider & {
  direction: RegularShuttleDirection;
  place: RegularShuttlePlace;
  placeLabel: string;
};

export type RegularShuttleRosterResult = {
  direction: RegularShuttleDirection;
  dayOfWeek: string;
  /** 좌표 정합 완료 = 배차 가능한 라이더. */
  riders: RegularShuttleRider[];
  /** 이용자로 판정됐지만 그 방향 좌표가 없어 배차 못하는 학생(경고로 분리). */
  unassigned: RegularShuttleRider[];
};

// 요일 인덱스(0=일 … 6=토) → Class.dayOfWeek 문자열. Class는 "Mon"~"Sun" 3글자로 저장한다.
export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** 'YYYY-MM-DD' → Class.dayOfWeek 문자열("Mon" 등). 서버 타임존과 무관하게 그 달력 날짜의 요일. */
export function weekdayNameFromDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const idx = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1)).getUTCDay();
  return DOW_NAMES[idx];
}

/** 그 방향으로 실제 태울 수 있는가 = 위경도가 둘 다 있는가. */
export function hasCoords(p: RegularShuttlePlace): boolean {
  return p.latitude != null && p.longitude != null;
}

/**
 * 방향에 맞는 위치 한 벌을 고른다.
 *   등원(PICKUP)  → 등원 좌표 그대로.
 *   하원(DROPOFF) → 하원 좌표가 있으면 하원, 없으면 등원 좌표로 폴백(라벨만 하원 우선).
 * (방학특강 placeForDirection 과 같은 규칙 — 하원 미기재 시 등원지로 데려다 주는 기존 관행.)
 */
export function pickPlaceForDirection(
  r: RegularShuttleRawRider,
  direction: RegularShuttleDirection,
): RegularShuttlePlace {
  if (direction === "PICKUP") return r.pickup;
  if (hasCoords(r.dropoff)) return r.dropoff;
  // 하원 좌표가 비었으면 등원 좌표로 폴백하되, 라벨은 하원 표기가 있으면 그걸 우선한다.
  return { ...r.pickup, location: r.dropoff.location ?? r.pickup.location };
}

// 명단 정렬: 수업 시작 시각 → 이름(한글). 방학특강 배차 화면 정렬과 같은 기준.
function sortRiders(a: RegularShuttleRider, b: RegularShuttleRider): number {
  return (
    (a.classStart ?? "").localeCompare(b.classStart ?? "") ||
    a.studentName.localeCompare(b.studentName, "ko")
  );
}

/**
 * 원시 라이더 목록을 방향에 맞춰 정합하고, 좌표 없는 사람은 unassigned로 분리한다.
 * 배차 엔진(Phase 1)은 riders 만 입력으로 받고, unassigned 는 화면 경고로만 쓴다.
 */
export function buildRegularShuttleRoster(
  raw: RegularShuttleRawRider[],
  direction: RegularShuttleDirection,
  dayOfWeek: string,
): RegularShuttleRosterResult {
  const riders: RegularShuttleRider[] = [];
  const unassigned: RegularShuttleRider[] = [];
  for (const r of raw) {
    const place = pickPlaceForDirection(r, direction);
    const rider: RegularShuttleRider = {
      ...r,
      direction,
      place,
      placeLabel: place.location ?? r.pickup.location ?? "(위치 미지정)",
    };
    (hasCoords(place) ? riders : unassigned).push(rider);
  }
  riders.sort(sortRiders);
  unassigned.sort(sortRiders);
  return { direction, dayOfWeek, riders, unassigned };
}
