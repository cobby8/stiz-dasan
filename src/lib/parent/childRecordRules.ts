// 학부모 «아이 기록» 화면(/mypage/record) 규칙 — 순수 함수(DB·시계·React 의존 0)
//
// 왜 따로 두는가: 이 화면은 여러 표(청구·출결·수강 변경·특강·유니폼)를 한 장에 모은다.
// 합계·출석률·월 묶음·타임라인 정렬처럼 «숫자가 틀리면 학부모가 바로 전화하는» 계산을
// 화면과 떼어 node --test 로 실행 검증한다(tests/parent-child-record-rules.test.mjs).
//
// 날짜 규칙: 달력 값은 전부 "YYYY-MM-DD"/"YYYY-MM" 문자열이다. SQL 이 KST 로 바꿔서 넘긴다.
// 이 파일에서는 Date 객체를 만들지 않는다(달 더하기만 @/lib/datetime/kst 의 addMonthsYm).
import { addMonthsYm } from "@/lib/datetime/kst";

// ── 청구 ────────────────────────────────────────────────────────────────────

/** 화면에서 묶는 청구 종류 — DB type 값(MONTHLY·TUITION·SHUTTLE·SPECIAL·UNIFORM·OTHER)을 다섯 갈래로 */
export type RecordPaymentKind = "TUITION" | "SHUTTLE" | "SPECIAL" | "UNIFORM" | "OTHER";
export const RECORD_PAYMENT_KINDS: readonly RecordPaymentKind[] = ["TUITION", "SHUTTLE", "SPECIAL", "UNIFORM", "OTHER"];
export const PAYMENT_KIND_LABEL: Record<RecordPaymentKind, string> = {
  TUITION: "수강료",
  SHUTTLE: "셔틀",
  SPECIAL: "특강",
  UNIFORM: "유니폼",
  OTHER: "기타",
};

/** DB type → 화면 종류. 모르는 값은 «기타»(영어 코드를 그대로 보이지 않는다) */
export function paymentKind(type: string | null | undefined): RecordPaymentKind {
  switch (type) {
    case "MONTHLY":
    case "TUITION":
      return "TUITION";
    case "SHUTTLE":
      return "SHUTTLE";
    case "SPECIAL":
    case "SEASONAL":
      return "SPECIAL";
    case "UNIFORM":
      return "UNIFORM";
    default:
      return "OTHER";
  }
}

/** 청구 상태 글자 — 청구 탭(PaymentRequestClient)과 같은 말 */
export const RECORD_PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "미납",
  OVERDUE: "연체",
  PAID: "납부 완료",
  REFUNDED: "환불",
};
export function paymentStatusLabel(status: string): string {
  return RECORD_PAYMENT_STATUS_LABEL[status] ?? "확인 중";
}

/** 미납 = PENDING·OVERDUE(청구·수납 화면과 같은 값) */
export function isUnpaid(status: string): boolean {
  return status === "PENDING" || status === "OVERDUE";
}

/** 취소된 청구는 이 화면에 아예 보이지 않는다(청구 탭과 같은 기준) */
export function isShownPayment(status: string): boolean {
  return status !== "CANCELED" && status !== "CANCELLED";
}

export type RecordPaymentRow = {
  id: string;
  type: string;
  status: string;
  /** 결제 권한이 없으면 null(금액을 보이지 않는다) */
  amount: number | null;
  /** 청구 대상 연·월(비어 있을 수 있다 — 그때는 납기일의 달로) */
  year: number | null;
  month: number | null;
  /** KST 달력 날짜 "YYYY-MM-DD" (SQL 에서 두 번 변환해 온다) */
  dueYmd: string | null;
  paidYmd: string | null;
  description: string | null;
  receiptUrl: string | null;
  /** 결제수단(납부 완료 건 세부 시트) — 없으면 안 보인다 */
  method?: string | null;
  paidProvider?: string | null;
};

/** 청구가 속한 달 "YYYY-MM": 청구 대상 연·월이 맞으면 그것, 아니면 납기일의 달, 둘 다 없으면 null */
export function billingYm(row: Pick<RecordPaymentRow, "year" | "month" | "dueYmd">): string | null {
  const y = Number(row.year);
  const m = Number(row.month);
  if (Number.isInteger(y) && y >= 2000 && y <= 2100 && Number.isInteger(m) && m >= 1 && m <= 12) {
    return `${y}-${String(m).padStart(2, "0")}`;
  }
  const due = typeof row.dueYmd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.dueYmd) ? row.dueYmd : null;
  return due ? due.slice(0, 7) : null;
}

/** 연도 칩 — 청구·출석이 있는 해 + 올해, 최신 해부터 */
export function recordYears(input: { payments: readonly RecordPaymentRow[]; attendanceMonths: readonly { ym: string }[]; currentYear: number }): number[] {
  const set = new Set<number>([input.currentYear]);
  for (const row of input.payments) {
    if (!isShownPayment(row.status)) continue;
    const ym = billingYm(row);
    if (ym) set.add(Number(ym.slice(0, 4)));
  }
  for (const m of input.attendanceMonths) {
    if (/^\d{4}-\d{2}$/.test(m.ym)) set.add(Number(m.ym.slice(0, 4)));
  }
  return [...set].filter((y) => y <= input.currentYear).sort((a, b) => b - a);
}

/** 주소 ?year= → 고를 연도(목록에 없으면 올해) */
export function pickRecordYear(raw: unknown, years: readonly number[], currentYear: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && years.includes(n) ? n : currentYear;
}

export type PaymentFilter = { kinds: RecordPaymentKind[]; statuses: ("PAID" | "UNPAID" | "REFUNDED")[] };
export const EMPTY_PAYMENT_FILTER: PaymentFilter = { kinds: [], statuses: [] };

/** «필터 n» 의 n — 고른 칸 수(아무것도 안 고르면 0 = 전부 보기) */
export function activeFilterCount(filter: PaymentFilter): number {
  return filter.kinds.length + filter.statuses.length;
}

function statusGroup(status: string): "PAID" | "UNPAID" | "REFUNDED" | null {
  if (status === "PAID") return "PAID";
  if (isUnpaid(status)) return "UNPAID";
  if (status === "REFUNDED") return "REFUNDED";
  return null;
}

/** 필터 적용 — 같은 칸 안에서는 «또는», 종류·상태 사이는 «그리고» */
export function filterPayments(rows: readonly RecordPaymentRow[], filter: PaymentFilter): RecordPaymentRow[] {
  return rows.filter((row) => {
    if (!isShownPayment(row.status)) return false;
    if (filter.kinds.length > 0 && !filter.kinds.includes(paymentKind(row.type))) return false;
    if (filter.statuses.length > 0) {
      const group = statusGroup(row.status);
      if (!group || !filter.statuses.includes(group)) return false;
    }
    return true;
  });
}

export type PaymentYearSummary = {
  year: number;
  /** 그해 청구 중 납부 완료 합계·건수(환불·취소 제외) */
  paidTotal: number;
  paidCount: number;
  /** 미납은 «지금» 기준이라 해와 상관없이 전체 */
  unpaidTotal: number;
  unpaidCount: number;
  /** 그해 청구의 종류별 건수(환불·취소 제외) — 비율 막대 1줄 */
  kindCounts: Record<RecordPaymentKind, number>;
};

export function summarizePayments(rows: readonly RecordPaymentRow[], year: number): PaymentYearSummary {
  const kindCounts: Record<RecordPaymentKind, number> = { TUITION: 0, SHUTTLE: 0, SPECIAL: 0, UNIFORM: 0, OTHER: 0 };
  let paidTotal = 0, paidCount = 0, unpaidTotal = 0, unpaidCount = 0;
  for (const row of rows) {
    if (!isShownPayment(row.status) || row.status === "REFUNDED") continue;
    const amount = Number(row.amount ?? 0) || 0;
    if (isUnpaid(row.status)) { unpaidTotal += amount; unpaidCount += 1; }
    const ym = billingYm(row);
    if (!ym || Number(ym.slice(0, 4)) !== year) continue;
    kindCounts[paymentKind(row.type)] += 1;
    if (row.status === "PAID") { paidTotal += amount; paidCount += 1; }
  }
  return { year, paidTotal, paidCount, unpaidTotal, unpaidCount, kindCounts };
}

export type PaymentMonthGroup = {
  /** "YYYY-MM" (청구 달이 없으면 "") */
  ym: string;
  /** «11월» (달이 없으면 «날짜 미정») */
  label: string;
  count: number;
  /** 환불 제외 합계 */
  total: number;
  unpaidCount: number;
  /** 처음에 펼칠지 — 이번 달·미납이 있는 달만 */
  defaultOpen: boolean;
  rows: RecordPaymentRow[];
};

/** 그해 청구만(취소 제외) — 청구 달이 그해인 것, 날짜 없는 청구는 올해 칸에만. 월 카드(groupBillsByMonth)와 옛 월 묶음이 같이 쓴다 */
export function paymentsOfYear<T extends RecordPaymentRow>(rows: readonly T[], year: number, currentYm: string): T[] {
  return rows.filter((row) => {
    if (!isShownPayment(row.status)) return false;
    const ym = billingYm(row) ?? "";
    if (ym) return Number(ym.slice(0, 4)) === year;
    return year === Number(currentYm.slice(0, 4));
  });
}

/** 그해 청구를 «청구 달» 묶음으로(최신 달부터). 이번 달·미납 달만 처음에 펼친다 */
export function groupPaymentsByMonth(rows: readonly RecordPaymentRow[], year: number, currentYm: string): PaymentMonthGroup[] {
  const map = new Map<string, RecordPaymentRow[]>();
  for (const row of paymentsOfYear(rows, year, currentYm)) {
    const ym = billingYm(row) ?? "";
    const list = map.get(ym) ?? [];
    list.push(row);
    map.set(ym, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === "" ? 1 : b === "" ? -1 : a < b ? 1 : -1))
    .map(([ym, list]) => {
      // 같은 달 안에서는 미납 먼저, 그다음 납기일 최신순
      const sorted = [...list].sort((x, y) => {
        const ux = isUnpaid(x.status) ? 0 : 1, uy = isUnpaid(y.status) ? 0 : 1;
        if (ux !== uy) return ux - uy;
        return (y.dueYmd ?? "").localeCompare(x.dueYmd ?? "");
      });
      const unpaidCount = sorted.filter((r) => isUnpaid(r.status)).length;
      return {
        ym,
        label: ym ? `${Number(ym.slice(5, 7))}월` : "날짜 미정",
        count: sorted.length,
        total: sorted.reduce((sum, r) => sum + (r.status === "REFUNDED" ? 0 : Number(r.amount ?? 0) || 0), 0),
        unpaidCount,
        defaultOpen: ym === currentYm || unpaidCount > 0,
        rows: sorted,
      };
    });
}

/** 원 단위 글자 «255,000원» */
export function won(n: number): string {
  return `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
}

// ── 출석 ────────────────────────────────────────────────────────────────────

/** SQL 이 달(KST)·상태별로 센 출결 — 한 줄 = 한 달 */
export type AttendanceMonthCount = {
  ym: string;
  present: number;
  late: number;
  absent: number;
  /** 미리 알린 결석인데 보강을 들어 대체된 횟수 — 분모에서 뺀다 */
  makeupReplaced: number;
};

/**
 * 출석률 = (출석+지각) ÷ (출석+지각+결석 − 보강으로 대체된 미리 알린 결석).
 * 분모가 0 이면 null(«기록 없음» — 0% 로 보이지 않게).
 */
export function attendanceRate(c: Pick<AttendanceMonthCount, "present" | "late" | "absent" | "makeupReplaced">): number | null {
  const ok = Math.max(0, Number(c.present) || 0) + Math.max(0, Number(c.late) || 0);
  const absent = Math.max(0, (Number(c.absent) || 0) - Math.max(0, Number(c.makeupReplaced) || 0));
  const total = ok + absent;
  return total > 0 ? Math.round((ok / total) * 100) : null;
}

/** 여러 달 합치기 */
export function sumAttendance(rows: readonly AttendanceMonthCount[]): AttendanceMonthCount {
  return rows.reduce<AttendanceMonthCount>(
    (acc, r) => ({
      ym: "",
      present: acc.present + (Number(r.present) || 0),
      late: acc.late + (Number(r.late) || 0),
      absent: acc.absent + (Number(r.absent) || 0),
      makeupReplaced: acc.makeupReplaced + (Number(r.makeupReplaced) || 0),
    }),
    { ym: "", present: 0, late: 0, absent: 0, makeupReplaced: 0 },
  );
}

/** 그해 출석률(그해 달만 합쳐서) */
export function yearAttendance(rows: readonly AttendanceMonthCount[], year: number) {
  const sum = sumAttendance(rows.filter((r) => r.ym.startsWith(`${year}-`)));
  return { ...sum, rate: attendanceRate(sum), records: sum.present + sum.late + sum.absent };
}

export type AttendanceBar = { ym: string; label: string; rate: number | null; ok: number; total: number };

/** 최근 n개월(이번 달 포함, 오래된 달부터) — 기록 없는 달은 rate null */
export function recentAttendanceBars(rows: readonly AttendanceMonthCount[], currentYm: string, months = 12): AttendanceBar[] {
  const byYm = new Map(rows.map((r) => [r.ym, r]));
  const out: AttendanceBar[] = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const ym = addMonthsYm(currentYm, -i);
    if (!ym) continue;
    const r = byYm.get(ym);
    const ok = r ? (Number(r.present) || 0) + (Number(r.late) || 0) : 0;
    const total = r ? ok + Math.max(0, (Number(r.absent) || 0) - (Number(r.makeupReplaced) || 0)) : 0;
    out.push({ ym, label: `${Number(ym.slice(5, 7))}월`, rate: r ? attendanceRate(r) : null, ok, total });
  }
  return out;
}

/** «기록 없음» 달을 사람 말로 묶기: ["2025-12","2026-01","2026-02"] → «25년 12월~26년 2월» */
export function missingMonthsText(bars: readonly AttendanceBar[]): string | null {
  const missing = bars.filter((b) => b.rate === null).map((b) => b.ym);
  if (missing.length === 0) return null;
  const ranges: string[][] = [];
  for (const ym of missing) {
    const last = ranges[ranges.length - 1];
    if (last && addMonthsYm(last[last.length - 1], 1) === ym) last.push(ym);
    else ranges.push([ym]);
  }
  const fmt = (ym: string) => `${ym.slice(2, 4)}년 ${Number(ym.slice(5, 7))}월`;
  return ranges.map((r) => (r.length === 1 ? fmt(r[0]) : `${fmt(r[0])}~${fmt(r[r.length - 1])}`)).join(", ");
}

// ── 다닌 기간 ────────────────────────────────────────────────────────────────

/**
 * «n개월 · 첫 등록 YYYY.MM» — 옛 기록 기준값이 있는 학생.
 * 기준값이 없으면 «n개월 · 첫 기록 YYYY.MM»(옛 구글시트 시절이 빠져 있을 수 있다는 뜻).
 */
export function tenureText(
  tenure: { label: string; firstMonth: string | null } | null,
  hasBaseline: boolean,
): { main: string; sub: string | null } | null {
  if (!tenure) return null;
  const first = tenure.firstMonth && /^\d{4}-\d{2}$/.test(tenure.firstMonth) ? tenure.firstMonth.replace("-", ".") : null;
  // 2026-11-14 문구 정리: 칸 이름이 이미 «다닌 기간»이라 값 앞 꼬리표(«실제 수강»·«사이트 기록 기준»)를 뺐다.
  // 기준의 차이는 아래 줄(«첫 등록»/«첫 기록»)이 말한다.
  if (hasBaseline) return { main: tenure.label, sub: first ? `첫 등록 ${first}` : null };
  return { main: tenure.label, sub: first ? `첫 기록 ${first}` : null };
}

/** 홈 한 줄 «다닌 지 n년 n개월 · 올해 출석 n%» — 값이 없는 칸은 뺀다. 둘 다 없으면 «전체 기록» */
export function homeRecordLine(input: { tenureLabel: string | null; hasBaseline: boolean; yearRate: number | null }): string {
  const parts: string[] = [];
  if (input.tenureLabel) parts.push(input.hasBaseline ? `다닌 지 ${input.tenureLabel}` : `기록 ${input.tenureLabel}`);
  if (input.yearRate !== null) parts.push(`올해 출석 ${input.yearRate}%`);
  return parts.length > 0 ? parts.join(" · ") : "전체 기록";
}

// ── 수강 반 이력(타임라인) ────────────────────────────────────────────────────

export type TimelineKind = "JOIN" | "CLASS_CHANGE" | "PAUSE" | "RESUME" | "WITHDRAW";
export const TIMELINE_LABEL: Record<TimelineKind, string> = {
  JOIN: "입반",
  CLASS_CHANGE: "반 변경",
  PAUSE: "휴원",
  RESUME: "복귀",
  WITHDRAW: "퇴원",
};
// 같은 날이면 이 순서(입반 → 반 변경 → 휴원 → 복귀 → 퇴원)
const KIND_ORDER: Record<TimelineKind, number> = { JOIN: 0, CLASS_CHANGE: 1, PAUSE: 2, RESUME: 3, WITHDRAW: 4 };

export type TimelineEnrollment = {
  id: string;
  classId: string;
  className: string;
  status: string; // ACTIVE | PAUSED | WITHDRAWN …
  /** 확정 개시일(@db.Date) */
  startsOn: string | null;
  /** KST 로 두 번 변환한 등록일·마지막 변경일 */
  createdYmd: string | null;
  updatedYmd: string | null;
};

export type TimelineChange = {
  id: string;
  enrollmentId: string | null;
  kind: string; // CLASS_CHANGE | MOVE | PAUSE | RESUME | WITHDRAW
  status: string; // APPLIED | APPROVED
  /** 적용일(@db.Date) */
  effectiveFrom: string | null;
  resumeOn: string | null;
  fromClassId: string | null;
  toClassId: string | null;
  fromClassName: string | null;
  toClassName: string | null;
};

export type TimelineEvent = {
  key: string;
  kind: TimelineKind;
  ymd: string;
  title: string;
  /** 아직 적용 전(승인된 예정) */
  scheduled: boolean;
};

function changeKind(kind: string): TimelineKind | null {
  if (kind === "CLASS_CHANGE" || kind === "MOVE") return "CLASS_CHANGE";
  if (kind === "PAUSE" || kind === "RESUME" || kind === "WITHDRAW") return kind;
  return null;
}

/**
 * 수강 반 이력 — 최신 일부터.
 *  - 입반: 수강 등록(개시일, 없으면 등록일). 반 변경으로 생긴 등록은 «반 변경» 한 줄로만 보인다.
 *  - 반 변경·휴원·복귀·퇴원: 적용됐거나(APPLIED) 승인돼 예정인(APPROVED) 수강 변경.
 *  - 변경 기록 없이 상태만 바뀐 등록(관리자가 직접 처리)은 마지막 변경일로 휴원·퇴원 한 줄.
 *  - 부상·질병 «기간 결석»은 휴원이 아니다 — 여기 넣지 않는다(반 자리·셔틀 명단이 그대로다).
 */
export function buildTimeline(input: {
  enrollments: readonly TimelineEnrollment[];
  changes: readonly TimelineChange[];
  today: string;
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const changeTargets = new Set(
    input.changes.filter((c) => changeKind(c.kind) === "CLASS_CHANGE" && c.toClassId).map((c) => c.toClassId as string),
  );
  const touched = new Map<string, Set<TimelineKind>>();
  for (const c of input.changes) {
    const kind = changeKind(c.kind);
    if (!kind || !c.effectiveFrom) continue;
    if (c.enrollmentId) {
      const set = touched.get(c.enrollmentId) ?? new Set<TimelineKind>();
      set.add(kind);
      touched.set(c.enrollmentId, set);
    }
    const scheduled = c.status !== "APPLIED" && c.effectiveFrom > input.today;
    const from = c.fromClassName ?? "";
    const title =
      kind === "CLASS_CHANGE"
        ? [from, c.toClassName ?? ""].filter(Boolean).join(" → ") || "반 변경"
        : kind === "PAUSE" && c.resumeOn
          ? `${from || "수강 반"} · ${Number(c.resumeOn.slice(5, 7))}/${Number(c.resumeOn.slice(8, 10))} 복귀 예정`
          : from || "수강 반";
    events.push({ key: `c-${c.id}`, kind, ymd: c.effectiveFrom, title, scheduled });
  }
  for (const e of input.enrollments) {
    const joined = e.startsOn ?? e.createdYmd;
    if (joined && !changeTargets.has(e.classId)) {
      events.push({ key: `j-${e.id}`, kind: "JOIN", ymd: joined, title: e.className, scheduled: joined > input.today });
    }
    const marks = touched.get(e.id);
    // 변경 기록 없이 상태만 바뀐 등록 — 반 변경으로 빠진 옛 반은 «반 변경» 한 줄이 이미 있다
    if (e.updatedYmd && e.status === "WITHDRAWN" && !marks?.has("WITHDRAW") && !marks?.has("CLASS_CHANGE")) {
      events.push({ key: `w-${e.id}`, kind: "WITHDRAW", ymd: e.updatedYmd, title: e.className, scheduled: false });
    }
    if (e.updatedYmd && e.status === "PAUSED" && !marks?.has("PAUSE")) {
      events.push({ key: `p-${e.id}`, kind: "PAUSE", ymd: e.updatedYmd, title: e.className, scheduled: false });
    }
  }
  return events.sort((a, b) => (a.ymd === b.ymd ? KIND_ORDER[b.kind] - KIND_ORDER[a.kind] : a.ymd < b.ymd ? 1 : -1));
}

// ── 특강·유니폼 ──────────────────────────────────────────────────────────────

/** 3년 무료 유니폼 링크 상태 글자(링크 주소는 보이지 않는다) */
export function freeUniformText(grant: { status: string; expired: boolean } | null): string | null {
  if (!grant) return null;
  if (grant.status === "USED") return "3년 무료 유니폼 신청 완료";
  if (grant.status === "ISSUED") return grant.expired ? "3년 무료 유니폼 링크 기간 지남" : "3년 무료 유니폼 링크 받음";
  return null;
}

/** 유니폼 상태(학생 기록 값 그대로 — 보유·미신청·해당없음 등). 비어 있으면 null */
export function uniformStatusText(status: string | null | undefined): string | null {
  const s = typeof status === "string" ? status.trim() : "";
  return s ? s : null;
}
