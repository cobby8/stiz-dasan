/**
 * 방학특강 셔틀 확정본 "수정" 규칙 — 의존성이 하나도 없는 순수 모듈.
 *
 * 왜 게이트웨이에서 떼어냈나:
 *   확정본 수정은 SET 절을 손으로 조립한다. 여기서 나는 사고(같은 컬럼 두 번 지정, $n 번호 어긋남,
 *   쓰지도 않는 파라미터 남기기)는 **소스 문자열을 아무리 검사해도 잡히지 않는다**. 실제로 돌려 봐야 한다.
 *   prisma를 import 하는 파일은 테스트에서 실행할 수 없으므로, 규칙만 여기로 옮겨 실행 테스트 대상으로 만든다.
 *
 * ⚠️ 이 파일에는 import를 추가하지 마라. 추가하는 순간 실행 테스트가 죽는다.
 */

/** 지도 핀 한 벌. 원본 편집(shuttle-roster.ts의 PinInput)과 같은 모양이라 화면이 그대로 보내면 된다. */
export type ConfirmedRosterPin = {
  latitude: number;
  longitude: number;
  address?: string | null;
  roadAddress?: string | null;
  source?: string | null;
  placeId?: string | null;
  accuracyMeters?: number | null;
};

export type ConfirmedRosterPatch = {
  ride?: boolean;
  pickupLocation?: string | null;
  pickupTime?: string | null;
  dropoffLocation?: string | null;
  dropoffSameAsPickup?: boolean;
  note?: string | null;
  /** 등원/하원 정밀 좌표. 확정 후에도 원장이 직접 찍어야 노선 편성이 굴러간다. */
  pickupPin?: ConfirmedRosterPin;
  dropoffPin?: ConfirmedRosterPin;
};

/** 길이 제한 있는 문자열 정리. 원본 편집(shuttle-roster.ts의 clean)과 같은 기준으로 맞춘다. */
export function clipText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export const VALID_PIN_SOURCES = ["MAP_PIN", "SEARCH", "CURRENT_LOCATION"];

/**
 * 좌표 하나를 숫자로 바꾼다. 못 바꾸면 null.
 *
 * ⚠️ `Number(v)`만 쓰면 안 된다. `Number(null)`·`Number("")`·`Number(false)`가 전부 **0**이라
 *    좌표가 비었는데 "위도 0, 경도 0"(대서양 한가운데)으로 조용히 저장된다.
 *    그 학생은 배차 계산에서 지구 반대편으로 튕겨 나간다.
 */
function toCoordinate(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 핀 한 벌을 확정본 UPDATE 문의 `[컬럼, SET 절]` 목록으로 바꾼다.
 *
 * 좌표가 이상하면 **조용히 무시하지 않고 던진다**. 조용히 넘기면 원장은 "저장됐다"고 믿고
 * 다음 날 그 학생만 배차에서 빠진 걸 현장에서 알게 된다.
 *
 * ⚠️ `${kind}ConfirmedAt`(관리자 위치확인 시각)을 반드시 함께 채운다.
 *    노선 편성 화면의 "이 학생 배차 가능" 판정이 이 값을 보기 때문에, 빠뜨리면 확정 후 배차 버튼이 죽는다.
 * ⚠️ `${kind}Location`(표시 라벨)은 **비어 있을 때만** 주소로 채운다. 원장이 적어 둔 건물명을 핀이 덮으면 안 된다.
 */
export function pinSetClauses(
  kind: "pickup" | "dropoff",
  pin: ConfirmedRosterPin,
  arg: (v: unknown) => string,
): [string, string][] {
  const lat = toCoordinate(pin.latitude);
  const lng = toCoordinate(pin.longitude);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error("좌표가 올바르지 않습니다.");
  }
  const src = typeof pin.source === "string" && VALID_PIN_SOURCES.includes(pin.source) ? pin.source : "MAP_PIN";
  const address = clipText(pin.address, 300) ?? clipText(pin.roadAddress, 300) ?? "지도에서 선택한 위치";
  const accuracy = pin.accuracyMeters != null && Number.isFinite(Number(pin.accuracyMeters))
    ? Math.max(0, Number(pin.accuracyMeters))
    : null;

  // 주소와 표시 라벨이 같은 값을 쓰므로 파라미터 하나를 재사용한다(쓰지 않는 파라미터를 남기면 bind 오류가 난다).
  const addressArg = arg(address);
  return [
    [`${kind}Latitude`, `"${kind}Latitude" = ${arg(lat)}`],
    [`${kind}Longitude`, `"${kind}Longitude" = ${arg(lng)}`],
    [`${kind}Address`, `"${kind}Address" = ${addressArg}`],
    [`${kind}RoadAddress`, `"${kind}RoadAddress" = ${arg(clipText(pin.roadAddress, 300))}`],
    [`${kind}LocationSource`, `"${kind}LocationSource" = ${arg(src)}`],
    [`${kind}PlaceId`, `"${kind}PlaceId" = ${arg(clipText(pin.placeId, 200))}`],
    [`${kind}AccuracyMeters`, `"${kind}AccuracyMeters" = ${arg(accuracy)}`],
    [`${kind}ConfirmedAt`, `"${kind}ConfirmedAt" = now()`],
    [`${kind}Location`, `"${kind}Location" = COALESCE(NULLIF(btrim("${kind}Location"), ''), ${addressArg})`],
  ];
}

/**
 * 확정본 한 행 UPDATE의 SET 절과 파라미터를 만든다. `args[0]`이 rosterId(= `$1`)다.
 *
 * ★ 같은 컬럼이 두 번 들어가면 Postgres가 42701(multiple assignments to same column)로 거절해 500이 난다.
 *   그래서 컬럼별로 한 절만 남긴다(Map). 순서는 "핀 먼저 → 스칼라"인데, 이유가 있다:
 *   스칼라를 먼저 담고 나중에 핀으로 덮으면 스칼라가 만든 파라미터가 어디에도 안 쓰인 채 남아
 *   bind 파라미터 개수가 어긋난다. 살아남을 절만 파라미터를 만들도록 순서를 고정했다.
 */
export function buildConfirmedRosterUpdate(
  rosterId: string,
  patch: ConfirmedRosterPatch,
): { sets: string[]; args: unknown[] } {
  const args: unknown[] = [rosterId];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const byColumn = new Map<string, string>();

  // 1) 핀 — 좌표·정확도·위치확인시각은 핀이 정본이다.
  if (patch.pickupPin) for (const [col, clause] of pinSetClauses("pickup", patch.pickupPin, arg)) byColumn.set(col, clause);
  if (patch.dropoffPin) for (const [col, clause] of pinSetClauses("dropoff", patch.dropoffPin, arg)) byColumn.set(col, clause);

  // 2) 스칼라 — 핀이 이미 정한 컬럼은 건너뛴다.
  //    단 표시 라벨(`${kind}Location`)만은 사람이 직접 친 값이 이긴다(overridePin).
  //    핀의 라벨 절은 "비어 있을 때만 채우기"라, 새로 친 이름을 버리면 "저장했는데 안 바뀐다"가 된다.
  const put = (col: string, value: unknown, overridePin = false) => {
    if (byColumn.has(col) && !overridePin) return;
    byColumn.set(col, `"${col}" = ${arg(value)}`);
  };
  if (patch.ride !== undefined) put("ride", patch.ride === true);
  if (patch.pickupLocation !== undefined) put("pickupLocation", clipText(patch.pickupLocation, 200), true);
  if (patch.pickupTime !== undefined) put("pickupTime", clipText(patch.pickupTime, 30));
  if (patch.dropoffLocation !== undefined) put("dropoffLocation", clipText(patch.dropoffLocation, 200), true);
  if (patch.dropoffSameAsPickup !== undefined) put("dropoffSameAsPickup", patch.dropoffSameAsPickup === true);
  if (patch.note !== undefined) put("note", clipText(patch.note, 2000));

  return { sets: [...byColumn.values()], args };
}

// ────────────────────────────────────────────────────────────────
// «뺀 학생» 목록의 문구 규칙 — 화면(ShuttleRosterClient)이 그대로 쓴다.
// 문구가 갈리는 조건(수강 취소 여부)을 실제로 돌려 확인하려고 화면에서 떼어 여기에 둔다.
// ────────────────────────────────────────────────────────────────

/** 뺀 학생 한 줄에서 문구를 고르는 데 필요한 값만. */
export type RemovedRosterView = {
  studentName: string;
  removedReason?: string | null;
  /** 수강 항목이 취소·거절 상태인가(서버가 판정해서 내려준다). */
  enrollmentCancelled?: boolean;
};

const ENROLLMENT_CANCEL_REASON = /수강\s*취소/;

/** 수강 취소 계열로 빠진 학생인가 — 지금 수강이 취소 상태이거나, 이유 글에 «수강 취소»가 적혀 있을 때. */
export function isEnrollmentCancelRemoval(row: RemovedRosterView): boolean {
  return row.enrollmentCancelled === true || ENROLLMENT_CANCEL_REASON.test(row.removedReason ?? "");
}

/**
 * 빠진 이유 표시 글. 이 화면의 «명단에서 빼기»는 이유를 남기지 않으므로(null) 그때는 «명단에서 뺌»으로 보인다.
 * 수강이 취소된 학생이면 이유 뒤에 «수강 취소»를 덧붙인다(되돌리기 전에 눈에 띄어야 한다).
 */
export function removedReasonLabel(row: RemovedRosterView): string {
  const reason = (row.removedReason ?? "").trim() || "명단에서 뺌";
  if (row.enrollmentCancelled === true && !ENROLLMENT_CANCEL_REASON.test(reason)) return `${reason} · 수강 취소`;
  return reason;
}

/**
 * 수강이 취소된 학생 줄에 «되돌리기» 버튼 대신 보이는 안내.
 * 이런 학생은 되돌려도 명단 조회가 숨기므로, 화면은 버튼을 그리지 않고 서버도 되돌리기를 거부한다.
 */
export const RESTORE_BLOCKED_HINT = "수강을 되살린 뒤 다시 넣을 수 있습니다";

/**
 * 되돌리기 확인 문구. 수강이 실제로 취소된 학생(enrollmentCancelled)은 버튼이 없어 여기로 오지 않는다.
 * 이유 글에만 «수강 취소»가 있고 수강 항목은 살아 있는 학생(신청서 단위 취소 등)이면 그 사실을 먼저 알린다.
 */
export function restoreConfirmMessage(row: RemovedRosterView): string {
  if (isEnrollmentCancelRemoval(row)) {
    return `${row.studentName} 학생은 수강 취소로 빠진 학생입니다. 그래도 셔틀 명단에 다시 넣을까요?`;
  }
  return `${row.studentName} 학생을 확정 명단에 다시 넣을까요?`;
}

/**
 * 명단 한 줄을 어디로 저장할지 고른다.
 *   확정본 행(rosterId)이 있으면 확정본으로, 없으면 기존처럼 원본 신청서로.
 *
 * ⚠️ 이건 **화면 편의용 1차 판단**일 뿐이다. 최종 판단은 서버가 확정본을 조회해서 한다.
 *    (오래 열어 둔 탭은 확정 전 상태를 들고 있어서 rosterId가 없다 — 그 탭을 믿으면 원본이 수정된다.)
 */
export function rosterPatchTarget(
  row: { rosterId?: string | null; requestId: string },
): { rosterId: string } | { requestId: string } {
  return row.rosterId ? { rosterId: row.rosterId } : { requestId: row.requestId };
}
