export type SeasonalSessionDate = {
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
  enrolled: number;
  remaining: number | null;
  price: number;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  shuttleAvailable: boolean;
  shuttleFee?: number | null;
  waitlistEnabled?: boolean;
  sessionDates: SeasonalSessionDate[];
  weekdays: Array<"MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN">;
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
  const periodOpen = status === "OPEN" && program.isAccepting !== false;
  const canApply = periodOpen && offerings.some((item) => item.capacity === null || (item.remaining ?? 0) > 0 || item.waitlistEnabled === true);
  const unavailableCourses = periodOpen && !canApply;
  const label = unavailableCourses ? offerings.length ? "전 수업 마감" : "수업 안내 예정" : statusLabel(status);
  const message = unavailableCourses
    ? offerings.length ? "모든 수업이 마감되어 신청할 수 없습니다." : "신청 가능한 수업을 준비하고 있습니다."
    : {
    UPCOMING: "아직 신청 기간이 아닙니다.", OPEN: "신청할 수 있습니다.", CLOSED: "신청 접수가 마감되었습니다.",
    ENDED: "운영이 종료된 특강입니다.", CANCELLED: "운영이 취소된 특강입니다.", UNAVAILABLE: "신청 일정은 학원에 문의해 주세요.",
  }[status];
  return { status, label, canApply, showSeats: canApply, message, actionLabel: canApply ? "자세히 보고 신청하기" : "특강 내용 보기" };
}

export function seasonalApplicationStatusLabel(status: string) {
  const labels: Record<string, string> = { WAITLISTED: "대기 접수", APPROVED: "승인", PENDING: "접수", PAID: "납부 완료", REGISTERED: "등록 완료", CANCELLED: "취소", REJECTED: "반려", COMPLETED: "수강 완료" };
  return Object.hasOwn(labels, status) ? labels[status] : "접수 상태 확인 중";
}

export function programClasses(program: SeasonalProgram) {
  return program.offerings ?? program.classes ?? [];
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
  };
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
  const enrolledCount = nullableNumber(row.enrolled);
  const rawRemaining = row.remainingCapacity ?? row.remaining;
  const remaining = capacity === null ? null
    : rawRemaining != null ? nullableNumber(rawRemaining)
      : enrolledCount !== null ? Math.max(0, capacity - enrolledCount) : null;
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
    enrolled: enrolledCount !== null ? Math.max(0, enrolledCount) : capacity !== null && remaining !== null ? Math.max(0, capacity - remaining) : 0, remaining, price: Number(row.price ?? 0),
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
