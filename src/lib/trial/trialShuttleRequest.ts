/**
 * 체험 수업 «셔틀 요청» 규칙 한 곳 — 순수 모듈(DB·next 의존 0) (2026-11-19 원장 결정).
 *
 * ■ 왜 한 곳인가
 *   같은 요청을 ① 학부모 체험 신청서 ② 관리자 체험 상세(전화로 받은 경우·사후 요청) 두 길로 넣는다.
 *   화면 검사와 서버 검사가 갈라지면 한쪽 길로 «위치 없는 요청»이 들어오므로 여기서만 정한다.
 *
 * ■ 저장 칸(TrialLead) — 이름은 셔틀 배정 쪽과 맺은 약속 그대로
 *   shuttleNeeded · shuttleDirection(BOTH|PICKUP|DROPOFF) · shuttlePickup{Name,Address,Lat,Lng}
 *   · shuttleDropoff{Name,Address,Lat,Lng}(전부 NULL = 등원과 같은 곳) · shuttleStatus(NONE|REQUESTED|ASSIGNED|UNAVAILABLE)
 *   ⚠️ «하원만»을 골라도 아이가 내리는 곳은 shuttlePickup* 칸에 담는다(하원 칸이 전부 NULL = 같은 곳 약속).
 *   이 모듈은 상태를 NONE ↔ REQUESTED 로만 만든다. ASSIGNED·UNAVAILABLE 은 배정 쪽이 쓴다.
 */
import { isKoreanCoordinate, parseCoordinate } from "@/lib/shuttle/academyLocation";
import { SHUTTLE_PLACE_NAME_MAX, hasShuttlePlaceName } from "@/lib/shuttle/placeNameRule";
import { isPlaceNameSameAsAddress } from "@/lib/enrollment/shuttle-place-name";
// 풀기 이유 값은 셔틀 배정 쪽이 정한 것만 쓴다(RESCHEDULED·CANCELLED·LOST·REQUEST_CHANGED …)
import type { TrialShuttleReleaseReason } from "@/lib/shuttle/trialShuttleRules";

/** 신청서 질문 문구(원장 지정 — 글자 그대로) */
export const TRIAL_SHUTTLE_QUESTION = "셔틀이 필요하신가요?";

/** «필요»를 고르면 보이는 안내 두 줄(원장 지정 — 글자 그대로). 체험 셔틀은 무료라 요금 문구는 없다 */
export const TRIAL_SHUTTLE_NOTICES = [
    "셔틀은 요청이며, 노선·자리에 따라 어려울 수 있고 확정되면 문자로 안내합니다.",
    "거리가 멀면 배정이 어려울 수 있습니다.",
] as const;

/** 신청서에만 보이는 한 줄 — 이미 낸 신청의 셔틀은 신청서로 바꾸거나 취소하지 못한다(배정을 조용히 풀지 않게) */
export const TRIAL_SHUTTLE_CHANGE_NOTICE = "셔틀 변경·취소는 전화로 알려 주세요.";

export const TRIAL_SHUTTLE_DIRECTIONS = ["BOTH", "PICKUP", "DROPOFF"] as const;
export type TrialShuttleDirection = (typeof TRIAL_SHUTTLE_DIRECTIONS)[number];

export const TRIAL_SHUTTLE_DIRECTION_LABEL: Record<TrialShuttleDirection, string> = {
    BOTH: "둘 다",
    PICKUP: "등원만",
    DROPOFF: "하원만",
};

/** 주소 최대 길이(지도에서 온 값이라 넘치면 잘라 저장한다) */
export const TRIAL_SHUTTLE_ADDRESS_MAX = 300;

/** 지도에서 고른 한 곳 + 학부모(관리자)가 적은 이름 */
export interface TrialShuttlePlace {
    name: string;
    address: string;
    latitude: number;
    longitude: number;
}

/** 화면(신청서·관리자)이 들고 있는 입력값 */
export interface TrialShuttleFormValue {
    needed: boolean;
    direction: TrialShuttleDirection;
    pickup: TrialShuttlePlace | null;
    /** «하원 위치가 다릅니다» 체크 — 둘 다(BOTH)일 때만 뜻이 있다 */
    dropoffDifferent: boolean;
    dropoff: TrialShuttlePlace | null;
}

/** 기본값 = «필요 없음» */
export const EMPTY_TRIAL_SHUTTLE_FORM: TrialShuttleFormValue = {
    needed: false,
    direction: "BOTH",
    pickup: null,
    dropoffDifferent: false,
    dropoff: null,
};

/** DB 에 그대로 쓰는 칸 묶음(상태·요청 시각은 저장하는 쪽이 정한다) */
export interface TrialShuttleRequestColumns {
    shuttleNeeded: boolean;
    shuttleDirection: TrialShuttleDirection | null;
    shuttlePickupName: string | null;
    shuttlePickupAddress: string | null;
    shuttlePickupLat: number | null;
    shuttlePickupLng: number | null;
    shuttleDropoffName: string | null;
    shuttleDropoffAddress: string | null;
    shuttleDropoffLat: number | null;
    shuttleDropoffLng: number | null;
}

/** «필요 없음» = 모든 칸 비움 */
export const EMPTY_TRIAL_SHUTTLE_COLUMNS: TrialShuttleRequestColumns = {
    shuttleNeeded: false,
    shuttleDirection: null,
    shuttlePickupName: null,
    shuttlePickupAddress: null,
    shuttlePickupLat: null,
    shuttlePickupLng: null,
    shuttleDropoffName: null,
    shuttleDropoffAddress: null,
    shuttleDropoffLat: null,
    shuttleDropoffLng: null,
};

export type TrialShuttleField = "direction" | "pickupLocation" | "pickupName" | "dropoffLocation" | "dropoffName";
export type TrialShuttleErrors = Partial<Record<TrialShuttleField, string>>;

/** 방향에 따라 «그 곳»을 부르는 이름 — 하원만이면 내리는 곳, 둘 다인데 하원이 같으면 타고 내리는 곳 */
export function trialShuttlePlaceLabels(direction: TrialShuttleDirection, dropoffDifferent: boolean): { main: string; dropoff: string } {
    if (direction === "DROPOFF") return { main: "내리는 곳", dropoff: "내리는 곳" };
    if (direction === "BOTH" && !dropoffDifferent) return { main: "타고 내리는 곳", dropoff: "내리는 곳" };
    return { main: "타는 곳", dropoff: "내리는 곳" };
}

function isDirection(value: unknown): value is TrialShuttleDirection {
    return typeof value === "string" && (TRIAL_SHUTTLE_DIRECTIONS as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * 한 줄 글자로 다듬는다: 줄바꿈·탭·제어문자를 공백으로 바꾸고 앞뒤 공백을 지운다.
 * 위치명·주소는 기사님 운행표·문자·관리 메모의 «한 줄»에 그대로 들어가므로, 줄을 나눠 다른 글처럼 보이게 하는 입력을 막는다.
 */
export function cleanTrialShuttleText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
}

type PlaceCheck =
    | { ok: true; place: TrialShuttlePlace }
    | { ok: false; locationError?: string; nameError?: string };

/** 한 곳 검사: 좌표(대한민국 범위) + 이름(필수·주소와 같으면 안 됨·150자 이내). 주소는 넘치면 자른다 */
function checkPlace(raw: unknown, label: string): PlaceCheck {
    const place = asRecord(raw);
    const latitude = parseCoordinate(place.latitude);
    const longitude = parseCoordinate(place.longitude);
    if (latitude === null || longitude === null || !isKoreanCoordinate(latitude, longitude)) {
        // 지도가 안 열리는 휴대폰에서도 신청은 할 수 있게 다른 길을 함께 알려 준다
        return { ok: false, locationError: `지도에서 ${label}을 골라 주세요. 지도가 열리지 않으면 «필요 없음»으로 신청하고 전화로 알려 주세요.` };
    }
    const address = cleanTrialShuttleText(place.address).slice(0, TRIAL_SHUTTLE_ADDRESS_MAX).trim();
    const name = cleanTrialShuttleText(place.name);
    if (!hasShuttlePlaceName(name) || isPlaceNameSameAsAddress(name, { address })) {
        return { ok: false, nameError: `${label} 이름을 적어 주세요(예: OO아파트 후문).` };
    }
    if (name.length > SHUTTLE_PLACE_NAME_MAX) {
        return { ok: false, nameError: `${label} 이름은 ${SHUTTLE_PLACE_NAME_MAX}자 이내로 적어 주세요.` };
    }
    return { ok: true, place: { name, address, latitude, longitude } };
}

export type TrialShuttleNormalizeResult =
    | { ok: true; columns: TrialShuttleRequestColumns }
    | { ok: false; errors: TrialShuttleErrors; message: string };

/**
 * 입력값(화면에서 온 것이든 조작된 것이든)을 검사해 저장 칸으로 바꾼다.
 * - 필요 없음(needed 가 true 가 아님) → 모든 칸 비움
 * - 필요 → 방향 허용값 · 위치(좌표)·이름 필수 · 하원 위치는 «둘 다 + 다릅니다»일 때만 받는다(아니면 비움)
 */
export function normalizeTrialShuttleRequest(input: unknown): TrialShuttleNormalizeResult {
    const value = asRecord(input);
    if (value.needed !== true) return { ok: true, columns: { ...EMPTY_TRIAL_SHUTTLE_COLUMNS } };

    const errors: TrialShuttleErrors = {};
    const direction = isDirection(value.direction) ? value.direction : null;
    if (!direction) errors.direction = "등원·하원 중 어느 쪽인지 골라 주세요.";

    const dropoffDifferent = direction === "BOTH" && value.dropoffDifferent === true;
    const labels = trialShuttlePlaceLabels(direction ?? "BOTH", dropoffDifferent);

    const pickup = checkPlace(value.pickup, labels.main);
    if (!pickup.ok) {
        if (pickup.locationError) errors.pickupLocation = pickup.locationError;
        if (pickup.nameError) errors.pickupName = pickup.nameError;
    }

    let dropoffPlace: TrialShuttlePlace | null = null;
    if (dropoffDifferent) {
        const dropoff = checkPlace(value.dropoff, labels.dropoff);
        if (dropoff.ok) dropoffPlace = dropoff.place;
        else {
            if (dropoff.locationError) errors.dropoffLocation = dropoff.locationError;
            if (dropoff.nameError) errors.dropoffName = dropoff.nameError;
        }
    }

    if (!direction || !pickup.ok || Object.keys(errors).length > 0) {
        const message = errors.direction ?? errors.pickupLocation ?? errors.pickupName ?? errors.dropoffLocation ?? errors.dropoffName
            ?? "셔틀 요청 내용을 확인해 주세요.";
        return { ok: false, errors, message };
    }

    return {
        ok: true,
        columns: {
            shuttleNeeded: true,
            shuttleDirection: direction,
            shuttlePickupName: pickup.place.name,
            shuttlePickupAddress: pickup.place.address || null,
            shuttlePickupLat: pickup.place.latitude,
            shuttlePickupLng: pickup.place.longitude,
            shuttleDropoffName: dropoffPlace?.name ?? null,
            shuttleDropoffAddress: dropoffPlace ? (dropoffPlace.address || null) : null,
            shuttleDropoffLat: dropoffPlace?.latitude ?? null,
            shuttleDropoffLng: dropoffPlace?.longitude ?? null,
        },
    };
}

/** 화면용: 칸별 안내(문제 없으면 빈 객체) */
export function trialShuttleFormErrors(value: unknown): TrialShuttleErrors {
    const result = normalizeTrialShuttleRequest(value);
    return result.ok ? {} : result.errors;
}

/** DB 에서 읽은 줄(칸 이름이 소문자로 올 수도 있다)의 셔틀 칸만 뽑는다. 칸이 없으면 «필요 없음» */
export function trialShuttleColumnsFromRow(row: unknown): TrialShuttleRequestColumns {
    const r = asRecord(row);
    const pick = (key: string) => r[key] ?? r[key.toLowerCase()] ?? null;
    const text = (key: string) => {
        const v = pick(key);
        return typeof v === "string" && v.trim() ? v : null;
    };
    const direction = pick("shuttleDirection");
    return {
        shuttleNeeded: pick("shuttleNeeded") === true,
        shuttleDirection: isDirection(direction) ? direction : null,
        shuttlePickupName: text("shuttlePickupName"),
        shuttlePickupAddress: text("shuttlePickupAddress"),
        shuttlePickupLat: parseCoordinate(pick("shuttlePickupLat")),
        shuttlePickupLng: parseCoordinate(pick("shuttlePickupLng")),
        shuttleDropoffName: text("shuttleDropoffName"),
        shuttleDropoffAddress: text("shuttleDropoffAddress"),
        shuttleDropoffLat: parseCoordinate(pick("shuttleDropoffLat")),
        shuttleDropoffLng: parseCoordinate(pick("shuttleDropoffLng")),
    };
}

/** 저장된 칸 → 화면 입력값(관리자 «고치기»를 열 때 미리 채움). 요청이 없으면 «필요»를 켠 빈 값 */
export function trialShuttleFormFromColumns(columns: TrialShuttleRequestColumns): TrialShuttleFormValue {
    const place = (name: string | null, address: string | null, lat: number | null, lng: number | null): TrialShuttlePlace | null =>
        lat !== null && lng !== null ? { name: name ?? "", address: address ?? "", latitude: lat, longitude: lng } : null;
    const dropoff = place(columns.shuttleDropoffName, columns.shuttleDropoffAddress, columns.shuttleDropoffLat, columns.shuttleDropoffLng);
    const direction = columns.shuttleDirection ?? "BOTH";
    return {
        needed: true,
        direction,
        pickup: place(columns.shuttlePickupName, columns.shuttlePickupAddress, columns.shuttlePickupLat, columns.shuttlePickupLng),
        dropoffDifferent: direction === "BOTH" && dropoff !== null,
        dropoff: direction === "BOTH" ? dropoff : null,
    };
}

function sameNumber(a: number | null, b: number | null): boolean {
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < 1e-7;
}

/** 두 요청이 같은 내용인가 — 같으면 이미 된 배정을 풀 까닭이 없다 */
export function trialShuttleRequestSame(a: TrialShuttleRequestColumns, b: TrialShuttleRequestColumns): boolean {
    return a.shuttleNeeded === b.shuttleNeeded
        && a.shuttleDirection === b.shuttleDirection
        && (a.shuttlePickupName ?? "") === (b.shuttlePickupName ?? "")
        && (a.shuttlePickupAddress ?? "") === (b.shuttlePickupAddress ?? "")
        && sameNumber(a.shuttlePickupLat, b.shuttlePickupLat)
        && sameNumber(a.shuttlePickupLng, b.shuttlePickupLng)
        && (a.shuttleDropoffName ?? "") === (b.shuttleDropoffName ?? "")
        && (a.shuttleDropoffAddress ?? "") === (b.shuttleDropoffAddress ?? "")
        && sameNumber(a.shuttleDropoffLat, b.shuttleDropoffLat)
        && sameNumber(a.shuttleDropoffLng, b.shuttleDropoffLng);
}

/** 관리자 화면에 보일 요청 내용(라벨·값 줄). 요청이 없으면 빈 배열 */
export function trialShuttleSummaryLines(columns: TrialShuttleRequestColumns): Array<{ label: string; value: string }> {
    if (!columns.shuttleNeeded) return [];
    const direction = columns.shuttleDirection ?? "BOTH";
    const hasDropoff = columns.shuttleDropoffLat !== null && columns.shuttleDropoffLng !== null;
    const labels = trialShuttlePlaceLabels(direction, hasDropoff);
    const placeText = (name: string | null, address: string | null) => [name, address].filter(Boolean).join(" · ") || "위치 미입력";
    const lines = [
        { label: "방향", value: TRIAL_SHUTTLE_DIRECTION_LABEL[direction] },
        { label: labels.main, value: placeText(columns.shuttlePickupName, columns.shuttlePickupAddress) },
    ];
    if (hasDropoff) lines.push({ label: labels.dropoff, value: placeText(columns.shuttleDropoffName, columns.shuttleDropoffAddress) });
    return lines;
}

/**
 * 셔틀 칸 저장이 실패했을 때(운영 DB 에 칸이 아직 없을 때 등) 관리 메모에 남길 글.
 * 좌표까지 적어 둔다 — 나중에 관리자가 «셔틀 요청 넣기»로 옮겨 적을 수 있게.
 */
export function trialShuttleMemoText(columns: TrialShuttleRequestColumns, heading = "셔틀 요청"): string {
    if (!columns.shuttleNeeded) return "";
    const placeWithCoord = (name: string | null, address: string | null, lat: number | null, lng: number | null) => {
        const coord = lat !== null && lng !== null ? `좌표 ${lat}, ${lng}` : "";
        const inside = [address, coord].filter(Boolean).join(" / ");
        return `${name ?? "이름 미입력"}${inside ? ` (${inside})` : ""}`;
    };
    const lines = trialShuttleSummaryLines(columns);
    const parts = [
        `${lines[0].label}: ${lines[0].value}`,
        `${lines[1].label}: ${placeWithCoord(columns.shuttlePickupName, columns.shuttlePickupAddress, columns.shuttlePickupLat, columns.shuttlePickupLng)}`,
    ];
    if (lines[2]) {
        parts.push(`${lines[2].label}: ${placeWithCoord(columns.shuttleDropoffName, columns.shuttleDropoffAddress, columns.shuttleDropoffLat, columns.shuttleDropoffLng)}`);
    }
    return `[${heading}] ${parts.join(" · ")}`;
}

/**
 * 이미 배정된(또는 «어려움»으로 정리된) 신청에 다른 셔틀 요청이 다시 들어왔을 때 관리 메모에 남길 한 줄.
 * 요청 칸은 덮어쓰지 않으므로 새 내용은 이 글로만 남는다. ymd = 받은 날 'YYYY-MM-DD'(KST) → «M/D».
 */
export function trialShuttleChangeMemoText(columns: TrialShuttleRequestColumns, ymd: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    const day = match ? ` ${Number(match[2])}/${Number(match[3])}` : "";
    return trialShuttleMemoText(columns, `셔틀 변경 요청${day}`);
}

// ── 다시 낸 신청서의 셔틀 요청 ───────────────────────────────────────────────

/**
 * 다시 낸 신청서(로그인 없음 — 아이 이름+보호자 전화가 같으면 같은 신청)의 셔틀 요청을 어떻게 다룰지.
 *  - KEEP           : 아무것도 하지 않는다 — «필요 없음»으로 다시 냄(전 요청 유지) 또는 전과 같은 내용
 *  - OVERWRITE      : 요청 칸을 새 내용으로 바꾼다 — 아직 배정 전(요청 없음·배정 대기)일 때만
 *  - HOLD_FOR_ADMIN : 요청 칸·상태·배정을 건드리지 않는다 — 이미 배정됐거나 «어려움»으로 정리된 건.
 *                     새 내용은 관리 메모로 남기고 관리자에게 알린다(사람이 확인하고 바꾼다).
 * 왜: 이름·전화를 아는 제3자가 다른 위치로 다시 내는 것만으로 확정된 배정이 조용히 풀리면 안 된다.
 * 모르는 상태 값은 안전한 쪽(HOLD_FOR_ADMIN)으로 본다.
 */
export type TrialShuttleResubmitAction = "KEEP" | "OVERWRITE" | "HOLD_FOR_ADMIN";

export function decideTrialShuttleResubmit(input: {
    previous: TrialShuttleRequestColumns | null;
    previousStatus: unknown;
    next: TrialShuttleRequestColumns;
}): TrialShuttleResubmitAction {
    if (!input.next.shuttleNeeded) return "KEEP";
    if (input.previous && trialShuttleRequestSame(input.previous, input.next)) return "KEEP";
    const status = input.previousStatus;
    const open = status === null || status === undefined || status === "" || status === "NONE" || status === "REQUESTED";
    return open ? "OVERWRITE" : "HOLD_FOR_ADMIN";
}

/**
 * 다시 낸 신청서가 «확정 전 일정»을 비우는가 — 본문 UPDATE 는 상태가 SCHEDULED 가 아니면 scheduledDate 를 NULL 로 만든다.
 * 그때 날짜가 실제로 사라지면 그 날짜에 묶인 셔틀 배정은 풀어야 한다.
 */
export function trialResubmitClearsSchedule(previous: { status?: unknown; scheduledDate?: unknown }): boolean {
    return previous.status !== "SCHEDULED" && timeOf(previous.scheduledDate) !== null;
}

/** 다시 낸 신청서 속도 제한 — 새 신청과 같은 값(전화번호 기준 10분에 5번) */
export const TRIAL_RESUBMIT_LIMIT = 5;

// ── 배정 풀기 판단 ───────────────────────────────────────────────────────────


function timeOf(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isNaN(ms) ? null : ms;
}

function idOf(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * 체험 신청을 고칠 때 셔틀 배정을 풀어야 하는가.
 * - 상태가 취소·이탈로 간다 → 푼다
 * - 확정 날짜(scheduledDate)나 반(scheduledClassId)이 «실제로» 바뀐다 → 푼다(같은 값을 다시 저장한 것은 아님)
 * next 에서 undefined 는 «안 고침»이다.
 */
export function trialShuttleReleaseReasonForLeadUpdate(
    previous: { scheduledDate?: unknown; scheduledClassId?: unknown },
    next: { status?: unknown; scheduledDate?: unknown; scheduledClassId?: unknown },
): TrialShuttleReleaseReason | null {
    if (next.status === "CANCELLED") return "CANCELLED";
    if (next.status === "LOST") return "LOST";
    const dateChanged = next.scheduledDate !== undefined && timeOf(next.scheduledDate) !== timeOf(previous.scheduledDate);
    const classChanged = next.scheduledClassId !== undefined && idOf(next.scheduledClassId) !== idOf(previous.scheduledClassId);
    return dateChanged || classChanged ? "RESCHEDULED" : null;
}
