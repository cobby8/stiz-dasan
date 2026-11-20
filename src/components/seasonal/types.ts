// 상대 경로(.ts) — 테스트가 이 파일을 node 로 바로 불러와 «@/» 별칭을 못 푼다(admin-delivery-status.ts 와 같은 방식)
// @ts-expect-error Node 의 타입 제거 테스트(tests/seasonal-public-display)에서도 같은 파일을 읽어서 확장자를 붙인다.
import { seatLevel as toSeatLevel, type SeatLevel } from "../../lib/seats/seatLevel.ts";
// @ts-expect-error 같은 이유(Node 타입 제거 테스트가 이 파일을 바로 읽는다) — 날짜는 공용 KST 모듈만 쓴다.
import { toKstYmd } from "../../lib/datetime/kst.ts";
// «반 = 교시 하나» 묶음(2026-11-19 원장) — 공개 목록·상세·신청 화면·관리자·서버가 같은 규칙 하나를 쓴다
// @ts-expect-error 같은 이유(Node 타입 제거 테스트가 이 파일을 바로 읽는다).
import { groupOfferingsByClass, groupPriceRows, type GroupPriceRow, type OfferingFrequencyGroup } from "../../lib/seasonal/offering-groups.ts";
// @ts-expect-error 같은 이유 — 화면이 «./types» 하나로 묶음 규칙을 함께 가져가게 다시 내보낸다.
export { offeringBaseTitle, offeringTitleWithFrequency } from "../../lib/seasonal/offering-groups.ts";
export type { GroupPriceRow } from "../../lib/seasonal/offering-groups";

export type SeasonalSessionDate = {
  /** 회차의 KST 날짜 'YYYY-MM-DD' — 날짜별 신청의 열쇠(서버가 안 보내면 startsAt 으로 만든다) */
  dateKey: string;
  /** 그날 정원이 찼는가(숫자 없이 참/거짓만). 서버가 안 보내면 false */
  full: boolean;
  startsAt: string;
  endsAt: string;
  dateLabel: string;
  dayLabel: string;
  startTime: string;
  endTime: string;
  location?: string;
};

export type SeasonalClass = {
  id: string;
  code?: string;
  name: string;
  linkedClassId?: string | null;
  dayLabel: string;
  dateLabel?: string;
  startTime: string;
  endTime: string;
  location?: string;
  targetGrade?: string;
  coachName?: string;
  capacity: number | null;
  /** 남은 자리 3단계(여유/임박/마감). 정원 미확정·모름이면 null(학원 문의) — 숫자는 공개 응답에 없다(f9) */
  seatLevel: SeatLevel | null;
  price: number;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  shuttleAvailable: boolean;
  shuttleFee?: number | null;
  waitlistEnabled?: boolean;
  sessionDates: SeasonalSessionDate[];
  weekdays: Array<"MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN">;
  /** 기간 상품표(켜진 것만·표시 순서). 비어 있으면 기간 없이 예전처럼 신청한다 */
  periods: SeasonalOfferingPeriod[];
};

/** 반별 기간 상품 한 줄(2026-11-18) — 예: «4주» 1/4~1/29 */
export type SeasonalOfferingPeriod = {
  label: string;
  startDate: string;
  endDate: string;
  price: number;
  newApplicantPrice: number | null;
  existingApplicantPrice: number | null;
  shuttleFee: number | null;
  /** 표시 순서(작을수록 앞) — 여러 반의 기간을 묶어 보여 줄 때 순서를 지킨다 */
  displayOrder: number;
  /** 이 기간의 신청 마감 시각(ISO, 2026-11-18). null = 시즌 마감을 따른다 */
  applicationClosesAt: string | null;
  /** 서버가 응답 시점에 본 마감 여부(화면은 시각으로 한 번 더 본다) */
  closed: boolean;
  /** 마감 표시 «1/1(금) 18:00» */
  closesLabel: string | null;
};

/** 시즌의 날짜별 신청 설정(2026-11-18). enabled=false 면 «요일로 고르기»만 보인다 */
export type SeasonalDateSelect = {
  enabled: boolean;
  perSessionNewPrice: number | null;
  perSessionExistingPrice: number | null;
  minSessionCount: number;
};

export type SeasonalProgram = {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  status: "UPCOMING" | "OPEN" | "CLOSED" | "ENDED" | "CANCELLED" | "UNAVAILABLE";
  isAccepting?: boolean;
  applicationStart?: string;
  applicationEnd?: string;
  operationStart?: string;
  operationEnd?: string;
  location?: string;
  shuttleNotice?: string;
  refundPolicy?: string;
  classes: SeasonalClass[];
  offerings?: SeasonalClass[];
  shuttleHub?: ShuttleHubInfo;
  dateSelect?: SeasonalDateSelect;
  /** 모집은 마감됐지만 «날짜로 고르기»로 남은 수업에 중간 합류할 수 있다(서버 판정, 2026-11-18) */
  lateJoinOpen?: boolean;
};

export type ShuttleHubPoint = { name: string; lat: number; lng: number };
export type ShuttleHubInfo = { pickup: ShuttleHubPoint | null; dropoff: ShuttleHubPoint | null };

export type SeasonalListResponse = { programs?: unknown[]; seasons?: unknown[] } | unknown[];

export function extractPrograms(payload: SeasonalListResponse): SeasonalProgram[] {
  const rows = Array.isArray(payload) ? payload : payload.programs ?? payload.seasons ?? [];
  return rows.map((row) => normalizeProgram(row));
}

export function formatWon(value: number) {
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

export function statusLabel(status: SeasonalProgram["status"]) {
  const labels = { UPCOMING: "모집 예정", OPEN: "신청 가능", CLOSED: "모집 마감", ENDED: "운영 종료", CANCELLED: "운영 취소", UNAVAILABLE: "안내 확인 중" };
  return Object.hasOwn(labels, status) ? labels[status] : "안내 확인 중";
}

type DisplayDate = string | Date | null | undefined;

function publicDate(value: DisplayDate): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string") return null;
  // 날짜만 있거나 시차가 생략된 값은 방문자 기기의 시간대 대신 한국 시간을 따른다.
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text)) return null;
  const civilDay = text.slice(0, 10);
  const civilDate = new Date(`${civilDay}T00:00:00Z`);
  const [year, month, day] = civilDay.split("-").map(Number);
  if (!Number.isFinite(civilDate.getTime()) || civilDate.getUTCFullYear() !== year
    || civilDate.getUTCMonth() + 1 !== month || civilDate.getUTCDate() !== day) return null;
  const input = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+09:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}+09:00` : text;
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

export function formatSeasonalDate(value: DisplayDate, withTime = false): string {
  const date = publicDate(value);
  if (!date) return "일정 안내 예정";
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}) }).formatToParts(date);
  const field = (name: string) => parts.find((part) => part.type === name)?.value;
  return `${field("year")}년 ${field("month")}월 ${field("day")}일${withTime ? ` ${field("hour")}:${field("minute")}` : ""}`;
}

export function formatSeasonalPeriod(start: DisplayDate, end: DisplayDate): string {
  const first = publicDate(start), last = publicDate(end);
  if (!first && !last) return "일정 안내 예정";
  if (!first) return `${formatSeasonalDate(last)}까지 · 시작일 안내 예정`;
  if (!last) return `${formatSeasonalDate(first)}부터 · 종료일 안내 예정`;
  const firstLabel = formatSeasonalDate(first), lastLabel = formatSeasonalDate(last);
  return firstLabel === lastLabel ? firstLabel : `${firstLabel} ~ ${lastLabel}`;
}

function publicDeadline(value: DisplayDate) {
  const date = publicDate(value);
  return date && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1) : date;
}

function resolvePublicStatus(row: Record<string, unknown>, now: number): SeasonalProgram["status"] {
  const raw = String(row.status ?? "PUBLISHED");
  if (raw === "CANCELLED") return "CANCELLED";
  if (raw === "ENDED" || raw === "ARCHIVED") return "ENDED";
  const endValue = row.endsAt ?? row.operationEnd;
  const end = publicDeadline(endValue as DisplayDate);
  if (end && now > end.getTime()) return "ENDED";
  if (!["PUBLISHED", "OPEN", "UPCOMING", "CLOSED"].includes(raw)) return "UNAVAILABLE";
  const startValue = row.applicationOpensAt ?? row.applicationStart;
  const closeValue = row.applicationClosesAt ?? row.applicationEnd;
  const operationStart = row.startsAt ?? row.operationStart;
  const start = publicDate(startValue as DisplayDate), close = publicDeadline(closeValue as DisplayDate);
  if ((startValue && !start) || (closeValue && !close) || (endValue && !end) || (operationStart && !publicDate(operationStart as DisplayDate))) return "UNAVAILABLE";
  // 서버가 닫았다고 판단한 모집을 화면의 날짜 계산으로 다시 열지 않는다.
  if (raw === "CLOSED") return "CLOSED";
  if (close && now > close.getTime()) return "CLOSED";
  if (raw === "UPCOMING" || (start && now < start.getTime())) return "UPCOMING";
  if (row.isAccepting === false) return "CLOSED";
  if (raw === "PUBLISHED" && !start && !close) return "UNAVAILABLE";
  return "OPEN";
}

export function seasonalDisplayState(program: SeasonalProgram, now = Date.now()) {
  const status = resolvePublicStatus(program as unknown as Record<string, unknown>, now);
  const offerings = programClasses(program);
  // 중간 합류(2026-11-18 원장): 모집 마감 뒤라도 서버가 «남은 수업 있음»이라 했고 날짜 선택이 켜졌으면 신청을 살린다.
  //   날짜 선택이 꺼진 시즌은 서버가 lateJoinOpen=false 를 보내 지금처럼 «모집 마감».
  const lateJoin = status === "CLOSED" && program.lateJoinOpen === true && program.dateSelect?.enabled === true;
  const periodOpen = (status === "OPEN" && program.isAccepting !== false) || lateJoin;
  const canApply = periodOpen && offerings.some((item) => item.capacity === null || (item.seatLevel !== null && item.seatLevel !== "FULL") || item.waitlistEnabled === true);
  const unavailableCourses = periodOpen && !canApply;
  const label = unavailableCourses ? offerings.length ? "전 수업 마감" : "수업 안내 예정" : lateJoin ? "중간 합류 가능" : statusLabel(status);
  const message = unavailableCourses
    ? offerings.length ? "모든 수업이 마감되어 신청할 수 없습니다." : "신청 가능한 수업을 준비하고 있습니다."
    : lateJoin ? "중간 합류 신청 가능(날짜로 고르기) — 남은 수업 날짜를 골라 신청하고, 수강료는 남은 회차만큼 받습니다."
    : {
    UPCOMING: "아직 신청 기간이 아닙니다.", OPEN: "신청할 수 있습니다.", CLOSED: "신청 접수가 마감되었습니다.",
    ENDED: "운영이 종료된 특강입니다.", CANCELLED: "운영이 취소된 특강입니다.", UNAVAILABLE: "신청 일정은 학원에 문의해 주세요.",
  }[status];
  const actionLabel = canApply ? lateJoin ? "중간 합류 신청하기" : "자세히 보고 신청하기" : "특강 내용 보기";
  return { status, label, canApply, showSeats: canApply, message, actionLabel, lateJoin: lateJoin && canApply };
}

export function seasonalApplicationStatusLabel(status: string) {
  const labels: Record<string, string> = { WAITLISTED: "대기 접수", APPROVED: "승인", PENDING: "접수", PAID: "납부 완료", REGISTERED: "등록 완료", CANCELLED: "취소", REJECTED: "반려", COMPLETED: "수강 완료" };
  return Object.hasOwn(labels, status) ? labels[status] : "접수 상태 확인 중";
}

export function programClasses(program: SeasonalProgram) {
  return program.offerings ?? program.classes ?? [];
}

/**
 * 공개 화면의 «반 카드» 하나 = 같은 운영 반(교시)의 주2회·주3회·매일(주5회) 반 묶음(2026-11-19 원장).
 *   base     = 카드를 대표하는 반(횟수가 가장 작은 반) — 시간·대상·장소·셔틀은 묶음 공통
 *   seat     = 남은 자리 3단계 — 묶음 안 «가장 여유 없는» 값(숫자 없이 · 재원생 수 비공개)
 *   priceRows= 횟수(·기간)별 신입생·재원생 수강료 표
 *   sessionDates = 묶음 전체 회차(같은 날·같은 시각은 한 줄)
 */
export type SeasonalClassGroup = OfferingFrequencyGroup<SeasonalClass> & {
  base: SeasonalClass;
  seat: Pick<SeasonalClass, "capacity" | "seatLevel" | "waitlistEnabled">;
  priceRows: GroupPriceRow[];
  sessionDates: SeasonalSessionDate[];
};

/**
 * 묶음의 남은 자리 — 정원 없는 반만 있으면 «학원 문의», 하나라도 모르면 null(학원 문의), 아니면 가장 빡빡한 단계.
 *   2026-11-19 검수: 서버가 반마다 «묶음 전체 인원(가장 찬 요일·날짜)» 기준 단계를 내려 준다(service.ts seatStateByOffering).
 *   그래서 여기서는 그 값을 그대로 모을 뿐이다(정원이 반마다 다르면 가장 빡빡한 쪽).
 */
function groupSeat(items: readonly SeasonalClass[]): SeasonalClassGroup["seat"] {
  const limited = items.filter((item) => item.capacity !== null);
  if (limited.length === 0) return { capacity: null, seatLevel: null, waitlistEnabled: items.some((item) => item.waitlistEnabled === true) };
  const levels = limited.map((item) => item.seatLevel);
  const seatLevel: SeatLevel | null = levels.includes(null) ? null
    : levels.includes("FULL") ? "FULL" : levels.includes("LOW") ? "LOW" : "AVAILABLE";
  return { capacity: limited[0].capacity, seatLevel, waitlistEnabled: limited.some((item) => item.waitlistEnabled === true) };
}

/** 시즌의 반들을 «교시 카드»로 묶는다. 묶음 순서 = 관리자 표시 순서(처음 나온 반 기준) */
export function programClassGroups(program: SeasonalProgram): SeasonalClassGroup[] {
  return groupOfferingsByClass(programClasses(program), (item: SeasonalClass) => item.name).map((group: OfferingFrequencyGroup<SeasonalClass>) => {
    const members = group.options.map((option) => option.offering);
    // 회차는 날짜·시작 시각이 같으면 한 줄(주2회·주3회 반이 같은 교실·같은 시각이라 겹친다)
    const sessions = new Map<string, SeasonalSessionDate>();
    for (const member of members) {
      for (const session of member.sessionDates) {
        const key = `${session.dateKey}|${session.startTime}`;
        const prev = sessions.get(key);
        // 같은 회차가 한 반에서라도 «마감»이면 마감으로 보인다(안전한 쪽)
        sessions.set(key, prev ? { ...prev, full: prev.full || session.full } : session);
      }
    }
    return {
      ...group,
      base: members[0],
      seat: groupSeat(members),
      priceRows: groupPriceRows(group),
      sessionDates: [...sessions.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    };
  });
}

type ApiRecord = Record<string, unknown>;

export function normalizeProgram(value: unknown, now = Date.now()): SeasonalProgram {
  const row = value as ApiRecord;
  const opens = publicDateString(row.applicationOpensAt ?? row.applicationStart) ?? "";
  const closes = publicDateString(row.applicationClosesAt ?? row.applicationEnd) ?? "";
  const offerings = ((row.offerings ?? row.classes ?? []) as ApiRecord[]).map(normalizeOffering);
  return {
    id: String(row.id ?? ""), slug: String(row.slug ?? ""), title: String(row.title ?? row.name ?? "방학특강"),
    summary: stringOrUndefined(row.description ?? row.summary),
    status: resolvePublicStatus(row, now),
    isAccepting: typeof row.isAccepting === "boolean" ? row.isAccepting : undefined,
    applicationStart: opens || undefined, applicationEnd: closes || undefined,
    operationStart: publicDateString(row.startsAt ?? row.operationStart), operationEnd: publicDateString(row.endsAt ?? row.operationEnd),
    location: stringOrUndefined(row.location), shuttleNotice: stringOrUndefined(row.shuttleNotice),
    refundPolicy: stringOrUndefined(row.cancellationPolicy ?? row.refundPolicy), classes: offerings, offerings,
    shuttleHub: normalizeHub(row.shuttleHub),
    dateSelect: normalizeDateSelect(row.dateSelect),
    // 서버가 true 라고 보낸 때만 중간 합류(없거나 이상한 값이면 false = 예전 화면)
    lateJoinOpen: row.lateJoinOpen === true,
  };
}

// 날짜별 신청 설정 — 없거나 모양이 이상하면 «꺼짐»(예전 화면 그대로)
function normalizeDateSelect(value: unknown): SeasonalDateSelect | undefined {
  const d = value as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return undefined;
  const min = nullableNumber(d.minSessionCount);
  return {
    enabled: d.enabled === true,
    perSessionNewPrice: nullableNumber(d.perSessionNewPrice),
    perSessionExistingPrice: nullableNumber(d.perSessionExistingPrice),
    minSessionCount: min !== null && min >= 1 ? Math.floor(min) : 1,
  };
}

// 기간 상품표 — 날짜 형식이 맞는 줄만 남긴다(잘못된 줄 하나로 화면이 깨지지 않게)
function normalizePeriods(value: unknown): SeasonalOfferingPeriod[] {
  if (!Array.isArray(value)) return [];
  return (value as ApiRecord[]).flatMap((row, index) => {
    const startDate = String(row?.startDate ?? ""), endDate = String(row?.endDate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return [];
    return [{
      label: String(row.label ?? ""),
      startDate,
      endDate,
      price: Number(row.price ?? 0),
      newApplicantPrice: nullableNumber(row.newApplicantPrice),
      existingApplicantPrice: nullableNumber(row.existingApplicantPrice),
      shuttleFee: nullableNumber(row.shuttleFee),
      // 서버가 안 보내면 받은 순서를 그대로 쓴다
      displayOrder: nullableNumber(row.displayOrder) ?? index,
      // 기간별 신청 마감 — 없거나 모양이 이상하면 «시즌 마감을 따름»
      applicationClosesAt: typeof row.applicationClosesAt === "string" && row.applicationClosesAt ? row.applicationClosesAt : null,
      closed: row.closed === true,
      closesLabel: typeof row.closesLabel === "string" && row.closesLabel ? row.closesLabel : null,
    }];
  });
}

function normalizeHub(value: unknown): SeasonalProgram["shuttleHub"] {
  const h = value as { pickup?: unknown; dropoff?: unknown } | undefined;
  if (!h) return undefined;
  const point = (v: unknown): ShuttleHubPoint | null => {
    const p = v as { name?: unknown; lat?: unknown; lng?: unknown } | null;
    const lat = Number(p?.lat), lng = Number(p?.lng);
    return p && Number.isFinite(lat) && Number.isFinite(lng) ? { name: String(p.name ?? ""), lat, lng } : null;
  };
  return { pickup: point(h.pickup), dropoff: point(h.dropoff) };
}

function normalizeOffering(row: ApiRecord): SeasonalClass {
  const dates = ((row.sessionDates ?? []) as ApiRecord[]).slice().sort((a, b) => {
    const left = new Date(String(a.startsAt ?? "")).getTime();
    const right = new Date(String(b.startsAt ?? "")).getTime();
    return (Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER) - (Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER);
  });
  const first = dates[0];
  const starts = publicDate(first?.startsAt as DisplayDate);
  const ends = publicDate(first?.endsAt as DisplayDate);
  const parsedCapacity = nullableNumber(row.capacity);
  const capacity = parsedCapacity !== null && parsedCapacity >= 0 ? parsedCapacity : null;
  // 서버가 3단계(seatLevel)로 보낸다. 예전 응답(캐시)에 숫자가 남아 있으면 같은 기준으로 3단계로 바꿔 숫자는 버린다
  const levelRaw = row.seatLevel;
  const enrolledCount = nullableNumber(row.enrolled);
  const rawRemaining = row.remainingCapacity ?? row.remaining;
  const legacyRemaining = rawRemaining != null ? nullableNumber(rawRemaining)
    : capacity !== null && enrolledCount !== null ? capacity - enrolledCount : null;
  const seatLevel: SeatLevel | null = capacity === null ? null
    : levelRaw === "AVAILABLE" || levelRaw === "LOW" || levelRaw === "FULL" ? levelRaw
      : legacyRemaining !== null ? toSeatLevel(legacyRemaining) : null;
  const weekdayByLabel = { 월: "MON", 화: "TUE", 수: "WED", 목: "THU", 금: "FRI", 토: "SAT", 일: "SUN" } as const;
  const weekdays = Array.from(new Set(dates.flatMap((date) => {
    const start = publicDate(date.startsAt as DisplayDate);
    if (!start) return [];
    const label = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(start).slice(0, 1);
    return weekdayByLabel[label as keyof typeof weekdayByLabel] ? [weekdayByLabel[label as keyof typeof weekdayByLabel]] : [];
  })));
  return {
    id: String(row.id ?? ""),
    code: stringOrUndefined(row.code),
    name: String(row.title ?? row.name ?? "특강반"),
    linkedClassId: stringOrUndefined(row.linkedClassId) ?? null,
    dayLabel: String(row.dayLabel ?? (starts ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(starts) : "일정")),
    dateLabel: starts ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(starts) : undefined,
    startTime: String(row.startTime ?? (starts ? starts.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }) : "")),
    endTime: String(row.endTime ?? (ends ? ends.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }) : "")),
    location: stringOrUndefined(row.location ?? first?.location), targetGrade: stringOrUndefined(row.targetGrades ?? row.targetGrade),
    coachName: stringOrUndefined(row.instructorName ?? row.coachName), capacity,
    seatLevel, price: Number(row.price ?? 0),
    newApplicantPrice: nullableNumber(row.newApplicantPrice),
    existingApplicantPrice: nullableNumber(row.existingApplicantPrice),
    shuttleAvailable: row.shuttleAvailable === true,
    shuttleFee: nullableNumber(row.shuttleFee),
    waitlistEnabled: row.waitlistEnabled === false ? false : true,
    sessionDates: dates.flatMap((date) => {
      if (!date.startsAt || !date.endsAt) return [];
      const sessionStarts = new Date(String(date.startsAt));
      const sessionEnds = new Date(String(date.endsAt));
      if (Number.isNaN(sessionStarts.getTime()) || Number.isNaN(sessionEnds.getTime())) return [];
      return [{
        // KST 날짜 열쇠 — 서버 값이 형식에 맞으면 그대로, 아니면 시작 시각에서 만든다(공용 KST 모듈)
        dateKey: typeof date.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date.dateKey) ? date.dateKey : toKstYmd(sessionStarts),
        full: date.full === true,
        startsAt: sessionStarts.toISOString(),
        endsAt: sessionEnds.toISOString(),
        dateLabel: String(date.dateLabel ?? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" }).format(sessionStarts)),
        dayLabel: String(date.dayLabel ?? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(sessionStarts)),
        startTime: String(date.startTime ?? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(sessionStarts)),
        endTime: String(date.endTime ?? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(sessionEnds)),
        location: stringOrUndefined(date.location ?? row.location),
      }];
    }),
    weekdays,
    periods: normalizePeriods(row.periods),
  };
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrUndefined(value: unknown) { return value == null || value === "" ? undefined : String(value); }
function publicDateString(value: unknown) {
  return value instanceof Date ? Number.isFinite(value.getTime()) ? value.toISOString() : undefined : stringOrUndefined(value);
}
