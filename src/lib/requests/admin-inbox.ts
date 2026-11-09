/**
 * 관리자 신청함 어댑터 — 14종류의 신청 표를 «공통 한 줄»로 바꿔 모은다 (2026-11-10 설계 A)
 *
 * 왜: 신청이 표 14개·화면 11개에 흩어져 원장이 메뉴를 돌며 확인했다. 여기서 종류마다 «어댑터»(어느 표에서
 * 무엇을 읽어 어떤 상태로 볼지)를 하나씩 두고, 결과를 같은 모양(InboxRow)으로 만들어 코드에서 합쳐 정렬한다.
 *
 * - 상태 → 칸(처리 필요/진행 중/완료)·이름은 catalog.ts 한 곳에서만 정한다(여기서 상태 글자를 새로 만들지 않는다).
 * - 모든 조회는 $queryRawUnsafe(PgBouncer 트랜잭션 모드). 학생 조인은 ON 절에 notMergedStudent —
 *   LEFT JOIN 이라 병합된 학생이어도 신청 행 자체는 사라지지 않는다(이름만 비고, 병합 엔진이 행을 대표 학생으로 옮긴다).
 * - 날짜는 KST: timestamptz 는 AT TIME ZONE 한 번, date 컬럼은 ::text(이미 달력 값). 서버 시계를 믿지 않는다.
 * - 상태 목록은 catalog 의 영문 대문자 상수뿐이라(테스트가 /^[A-Z_]+$/ 확인) SQL 배열 글자로 넣어도 안전하다.
 */
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  bucketFor,
  kindEntry,
  REQUEST_KINDS,
  statusLabel,
  statusesOf,
  type InboxBucket,
  type RequestKind,
} from "@/lib/requests/catalog";

export type InboxFact = [label: string, value: string];

/** 신청함 한 줄 — 종류가 달라도 모양은 같다 */
export type InboxRow = {
  kind: RequestKind;
  id: string;
  studentName: string | null;
  title: string;
  summary: string;
  rawStatus: string;
  bucket: InboxBucket;
  statusLabel: string;
  /** 신청 시각(ISO) — 정렬·«n일 전» 표시 */
  createdAt: string;
  /** 대상 날짜(KST «YYYY-MM-DD») — 결석일·적용일·대관일 등. 없으면 null */
  targetDate: string | null;
  /** 기존 관리자 화면(복잡한 처리는 여기서) */
  detailHref: string;
  /** 상세 칸에 보일 사실들 */
  facts: InboxFact[];
  /** 처리 버튼이 쓰는 추가 값(학부모 계정 id·청구 종류 등) */
  ref?: Record<string, string | null>;
};

export type InboxCounts = {
  /** 처리 필요 합계(메뉴 배지·«오늘 업무» 카드) */
  action: number;
  ongoing: number;
  byKind: Partial<Record<RequestKind, { action: number; ongoing: number }>>;
};

type RawRow = {
  id: string;
  raw: string;
  studentName: string | null;
  createdAt: Date | string;
  targetDate: string | null;
  extra: Record<string, unknown> | null;
};

type Adapter = {
  kind: RequestKind;
  /** FROM … JOIN … (본 표 별칭은 x) */
  from: string;
  /** 원래 상태(파생 포함) SQL 식 */
  rawExpr: string;
  /** 신청함에 올릴 행의 기본 조건(상태 조건 제외) */
  where?: string;
  studentNameExpr: string;
  createdAtExpr: string;
  targetDateExpr: string;
  /** json_build_object(...) 안에 들어갈 «'키', 식» 목록 */
  extra: string;
  format: (row: RawRow, extra: Record<string, unknown>) => { title: string; summary: string; facts: InboxFact[]; ref?: Record<string, string | null> };
};

// ── 표시용 글자 도우미 ──────────────────────────────────────────────────────

const text = (value: unknown): string => (value == null ? "" : String(value).trim());
const join = (...parts: unknown[]) => parts.map(text).filter(Boolean).join(" · ");
const won = (value: unknown) => (value == null || value === "" ? "" : `${Number(value).toLocaleString("ko-KR")}원`);
const fact = (label: string, value: unknown): InboxFact[] => (text(value) ? [[label, text(value)]] : []);
const hm = (minutes: unknown) => {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return "";
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const ABSENCE_REASON: Record<string, string> = {
  ILLNESS_INJURY: "아픔·부상", PERSONAL: "개인 사정", FAMILY_TRIP: "가족 여행", SCHOOL_EVENT: "학교 행사", ETC: "기타",
};
const CHANGE_KIND: Record<string, string> = { CLASS_CHANGE: "반 변경", PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀" };
const REQUEST_TYPE: Record<string, string> = { ABSENCE: "결석", SHUTTLE: "셔틀", EARLY_LEAVE: "조퇴", OTHER: "기타" };
const DIRECTION: Record<string, string> = { PICKUP: "등원", DROPOFF: "하원", BOTH: "등·하원" };
const PAY_METHOD: Record<string, string> = { TRANSFER: "계좌이체", RALLYZ: "랠리즈", CARD: "카드", CASH: "현금", MANUAL: "직접" };
const KAKAO_KIND: Record<string, string> = {
  PAUSE: "휴원", WITHDRAW: "퇴원", RESUME: "복귀", CLASS_CHANGE: "반 변경", CLASS_ADD: "반 추가", SHUTTLE_START_STOP: "셔틀 이용 변경",
  SHUTTLE_CHANGE: "탑승 정보 변경", SHUTTLE_FEE: "셔틀비", CONTACT_CHANGE: "연락처 변경", BILLING_CORRECTION: "청구 정정", MAKEUP: "보강", OTHER: "기타 문의",
};
const ROLE_LABEL: Record<string, string> = { INSTRUCTOR: "선생님", DRIVER: "기사님" };
const CHANNEL_LABEL: Record<string, string> = { GALLERY: "갤러리", INSTAGRAM: "인스타그램" };

/** 학생 이름 LEFT JOIN — 병합 학생 제외 조건을 ON 에 건다(행은 살리고 이름만 비운다) */
const studentJoin = (alias: string, onExpr: string) => `LEFT JOIN "Student" ${alias} ON ${alias}.id = ${onExpr} AND ${notMergedStudent(alias)}`;
const kstYmd = (expr: string) => `to_char((${expr}) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`;

// ── 종류별 어댑터 ──────────────────────────────────────────────────────────

const ADAPTERS: Adapter[] = [
  {
    kind: "ENROLLMENT_CHANGE",
    from: `"EnrollmentChangeRequest" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" fc ON fc.id = x."fromClassId" LEFT JOIN "Class" tc ON tc.id = x."toClassId"`,
    rawExpr: `CASE WHEN x.status = 'APPROVED' AND x."appliedAt" IS NOT NULL THEN 'APPLIED' ELSE x.status END`,
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."effectiveFrom"::text`,
    extra: `'changeKind', x.kind, 'fromClass', fc.name, 'toClass', tc.name, 'resumeOn', x."resumeOn"::text,
            'reason', x.reason, 'waitlisted', x.waitlisted, 'decisionNote', x."decisionNote"`,
    format: (row, e) => {
      const kind = CHANGE_KIND[text(e.changeKind)] ?? "수강 변경";
      const classes = e.toClass ? `${text(e.fromClass) || "?"} → ${text(e.toClass)}` : text(e.fromClass);
      return {
        title: `${kind} 신청`,
        summary: join(classes, row.targetDate ? `${row.targetDate}부터` : "", e.waitlisted ? "희망 반 만석" : ""),
        facts: [["종류", kind], ...fact("반", classes), ...fact("적용일", row.targetDate), ...fact("복귀 예정", e.resumeOn),
          ...fact("사유", e.reason), ...fact("원장 메모", e.decisionNote)],
      };
    },
  },
  {
    kind: "REGULAR_ABSENCE",
    from: `"RegularAbsence" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "Class" c ON c.id = x."classId"`,
    rawExpr: "x.status",
    where: `x."periodId" IS NULL`, // 관리자 «기간 결석»이 만든 행은 신청이 아니다
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x.date::text`,
    extra: `'className', c.name, 'reason', x.reason, 'note', x.note`,
    format: (row, e) => ({
      title: "결석 신고",
      summary: join(row.targetDate, e.className, ABSENCE_REASON[text(e.reason)] ?? ""),
      facts: [...fact("결석일", row.targetDate), ...fact("반", e.className), ...fact("사유", ABSENCE_REASON[text(e.reason)] ?? e.reason), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "MAKEUP",
    from: `"MakeupSession" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" oc ON oc.id = x."originalClassId" LEFT JOIN "Class" mc ON mc.id = x."makeupClassId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`x."makeupDate"`),
    extra: `'originalClass', oc.name, 'makeupClass', mc.name, 'originalDate', ${kstYmd(`x."originalDate"`)}`,
    format: (row, e) => ({
      title: "보강 예약",
      summary: join(row.targetDate, e.makeupClass),
      facts: [...fact("보강일", row.targetDate), ...fact("보강 반", e.makeupClass), ...fact("결석일", e.originalDate), ...fact("원래 반", e.originalClass)],
    }),
  },
  {
    kind: "SHUTTLE_DAY",
    from: `"ShuttleDayException" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: `CASE WHEN x."canceledAt" IS NOT NULL THEN 'CANCELED' ELSE 'ACTIVE' END`,
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."serviceDate"::text`,
    extra: `'direction', x.direction, 'exceptionKind', x.kind, 'location', x.location, 'note', x.note`,
    format: (row, e) => {
      const what = e.exceptionKind === "LOCATION" ? `다른 곳에서 탑승: ${text(e.location)}` : "안 탐";
      return {
        title: "셔틀 오늘만 변경",
        summary: join(row.targetDate, DIRECTION[text(e.direction)] ?? "", what),
        facts: [...fact("날짜", row.targetDate), ...fact("방향", DIRECTION[text(e.direction)]), ["변경", what], ...fact("메모", e.note),
          ["안내", "승인 없이 바로 반영된 알림입니다."]],
      };
    },
  },
  {
    kind: "SEASONAL_ABSENCE",
    from: `"SpecialProgramAbsence" x
           JOIN "SpecialProgramEnrollmentDate" ed ON ed.id = x."enrollmentDateId"
           JOIN "SpecialProgramApplicationItem" it ON it.id = ed."applicationItemId"
           JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
           LEFT JOIN "SpecialProgramSessionDate" sd ON sd.id = ed."sessionDateId"
           LEFT JOIN "SpecialProgramOffering" o ON o.id = ed."offeringId"`,
    rawExpr: "x.status",
    studentNameExpr: `a."childName"`,
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`sd."startsAt"`),
    extra: `'offering', o.title, 'reason', x.reason, 'resolution', x.resolution, 'note', x.note`,
    format: (row, e) => ({
      title: "방학특강 결석",
      summary: join(row.targetDate, e.offering, ABSENCE_REASON[text(e.reason)] ?? ""),
      facts: [...fact("결석일", row.targetDate), ...fact("특강", e.offering), ...fact("사유", ABSENCE_REASON[text(e.reason)] ?? e.reason), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "SEASONAL_MAKEUP",
    from: `"SpecialProgramMakeup" x
           JOIN "SpecialProgramApplicationItem" it ON it.id = x."applicationItemId"
           JOIN "SpecialProgramApplication" a ON a.id = it."applicationId"
           LEFT JOIN "SpecialProgramOffering" o ON o.id = x."offeringId"
           LEFT JOIN "SpecialProgramSessionDate" absd ON absd.id = x."absentSessionDateId"
           LEFT JOIN "SpecialProgramSessionDate" tsd ON tsd.id = x."targetSessionDateId"
           LEFT JOIN "Class" c ON c.id = x."targetClassId"`,
    rawExpr: "x.status",
    studentNameExpr: `a."childName"`,
    createdAtExpr: `x."requestedAt"`,
    targetDateExpr: kstYmd(`COALESCE(tsd."startsAt", x."targetDate")`),
    extra: `'offering', o.title, 'targetType', x."targetType", 'targetClass', c.name, 'absentDate', ${kstYmd(`absd."startsAt"`)}, 'note', x.note`,
    format: (row, e) => ({
      title: "방학특강 보강",
      summary: join(row.targetDate, e.targetType === "REGULAR" ? text(e.targetClass) || "정규 수업" : e.offering),
      facts: [...fact("보강일", row.targetDate), ...fact("결석일", e.absentDate), ...fact("특강", e.offering),
        ...fact("보강 대상", e.targetType === "REGULAR" ? `정규 ${text(e.targetClass)}` : "특강 다른 날"), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "PARENT_REQUEST",
    from: `"ParentRequest" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "User" u ON u.id = x."userId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `CASE WHEN x.date IS NULL THEN NULL ELSE ${kstYmd("x.date")} END`,
    extra: `'type', x.type, 'title', x.title, 'content', x.content, 'parentName', u.name, 'adminNote', x."adminNote"`,
    format: (row, e) => ({
      title: text(e.title) || "학부모 문의",
      summary: join(REQUEST_TYPE[text(e.type)] ?? "", text(e.content).slice(0, 60)),
      facts: [...fact("종류", REQUEST_TYPE[text(e.type)]), ...fact("보호자", e.parentName), ...fact("날짜", row.targetDate),
        ...fact("내용", e.content), ...fact("답변", e.adminNote)],
      ref: { adminNote: text(e.adminNote) || null },
    }),
  },
  {
    kind: "PAYMENT_REQUEST",
    from: `"PaymentParentRequest" x ${studentJoin("s", `x."studentId"`)} LEFT JOIN "Payment" p ON p.id = x."paymentId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."paidOn"::text`,
    extra: `'requestKind', x.kind, 'method', x.method, 'depositorName', x."depositorName", 'note', x.note,
            'amount', p.amount, 'description', p.description, 'receiptType', x."receiptType", 'receiptTarget', x."receiptTarget", 'decisionNote', x."decisionNote"`,
    format: (row, e) => {
      const claim = e.requestKind === "PAYMENT_CLAIM";
      return {
        title: claim ? "입금했어요" : "영수증 요청",
        summary: join(e.description, won(e.amount), claim ? PAY_METHOD[text(e.method)] ?? "" : ""),
        facts: [...fact("청구", e.description), ...fact("금액", won(e.amount)), ...fact("입금일", row.targetDate),
          ...fact("방법", PAY_METHOD[text(e.method)] ?? e.method), ...fact("입금자", e.depositorName), ...fact("영수증 대상", e.receiptTarget),
          ...fact("메모", e.note), ...fact("원장 메모", e.decisionNote)],
        ref: { requestKind: text(e.requestKind) },
      };
    },
  },
  {
    kind: "KAKAO",
    from: `"KakaoParentIntake" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: "NULL::text",
    extra: `'intakeKind', x.kind, 'sourceText', x."sourceText", 'decisionNote', x."decisionNote"`,
    format: (_row, e) => ({
      title: `카카오 · ${KAKAO_KIND[text(e.intakeKind)] ?? "기타 문의"}`,
      summary: text(e.sourceText).slice(0, 60),
      facts: [...fact("종류", KAKAO_KIND[text(e.intakeKind)] ?? e.intakeKind), ...fact("대화 내용", e.sourceText), ...fact("원장 메모", e.decisionNote)],
    }),
  },
  {
    kind: "RENTAL",
    from: `"GymRentalRequest" x`,
    rawExpr: "x.status",
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: `x."rentalDate"`,
    extra: `'applicantName', x."applicantName", 'headcount', x.headcount, 'startMinute', COALESCE(x."startMinute", x."startHour" * 60),
            'endMinute', COALESCE(x."endMinute", x."endHour" * 60), 'totalAmount', x."totalAmount", 'memberFree', x."memberFree", 'purpose', x.purpose`,
    format: (row, e) => {
      const time = `${hm(e.startMinute)}~${hm(e.endMinute)}`;
      return {
        title: `대관 · ${text(e.applicantName)}`,
        summary: join(row.targetDate, time, `${text(e.headcount)}명`, e.memberFree ? "재원생 무료" : won(e.totalAmount)),
        facts: [...fact("신청자", e.applicantName), ...fact("날짜", row.targetDate), ["시간", time], ...fact("인원", `${text(e.headcount)}명`),
          ...fact("금액", e.memberFree ? "재원생 무료" : won(e.totalAmount)), ...fact("목적", e.purpose)],
      };
    },
  },
  {
    kind: "WITHDRAWAL",
    from: `"User" x`,
    rawExpr: `CASE WHEN x."withdrawnAt" IS NOT NULL THEN 'WITHDRAWN' ELSE 'REQUESTED' END`,
    where: `x."withdrawRequestedAt" IS NOT NULL`,
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."withdrawRequestedAt"`,
    targetDateExpr: "NULL::text",
    // 자녀 이름 — 누구의 보호자인지 알아야 판단할 수 있다(병합 학생 제외)
    extra: `'accountName', x.name, 'role', x.role::text,
            'childNames', (SELECT STRING_AGG(cs.name, ', ' ORDER BY cs.name) FROM "Student" cs WHERE cs."parentId" = x.id AND ${notMergedStudent("cs")}),
            'activeEnrollments', (SELECT COUNT(*)::int FROM "Enrollment" en JOIN "Student" es ON es.id = en."studentId" AND ${notMergedStudent("es")} WHERE es."parentId" = x.id AND en.status = 'ACTIVE')`,
    format: (_row, e) => ({
      title: `회원 탈퇴 · ${text(e.accountName)}`,
      summary: join(e.childNames ? `자녀 ${text(e.childNames)}` : "", Number(e.activeEnrollments) > 0 ? `수강 중 ${text(e.activeEnrollments)}건` : ""),
      facts: [...fact("계정", e.accountName), ...fact("자녀", e.childNames), ["수강 중", `${Number(e.activeEnrollments ?? 0)}건`]],
    }),
  },
  {
    kind: "ROLE_GRANT",
    from: `"UserRoleGrant" x LEFT JOIN "User" u ON u.id = x."userId"`,
    rawExpr: "x.status",
    where: `(x.source = 'REQUEST' OR x.status = 'PENDING')`, // 원장이 직접 준 역할은 «신청»이 아니다
    studentNameExpr: "NULL::text",
    createdAtExpr: `x."requestedAt"`,
    targetDateExpr: "NULL::text",
    extra: `'userName', u.name, 'role', x.role, 'note', x.note`,
    format: (_row, e) => ({
      title: `직원 역할 · ${text(e.userName)}`,
      summary: `${ROLE_LABEL[text(e.role)] ?? text(e.role)} 역할 신청`,
      facts: [...fact("신청자", e.userName), ...fact("역할", ROLE_LABEL[text(e.role)] ?? e.role), ...fact("메모", e.note)],
    }),
  },
  {
    kind: "MEDIA_REVOCATION",
    from: `"MediaRevocationJob" x ${studentJoin("s", `x."studentId"`)}`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: "NULL::text",
    extra: `'channel', x.channel, 'attempts', x.attempts, 'lastError', x."lastError"`,
    format: (_row, e) => ({
      title: "사진 공개 회수",
      summary: join(CHANNEL_LABEL[text(e.channel)] ?? e.channel, `시도 ${text(e.attempts)}회`),
      facts: [...fact("채널", CHANNEL_LABEL[text(e.channel)] ?? e.channel), ...fact("시도", `${text(e.attempts)}회`)],
    }),
  },
  {
    kind: "STAFF_PAYMENT",
    from: `"StaffPaymentConfirmationRequest" x ${studentJoin("s", `x."studentId"`)}
           LEFT JOIN "Class" c ON c.id = x."classId" LEFT JOIN "User" u ON u.id = x."requestedByUserId"`,
    rawExpr: "x.status",
    studentNameExpr: "s.name",
    createdAtExpr: `x."createdAt"`,
    targetDateExpr: kstYmd(`x."receivedAt"`),
    extra: `'className', c.name, 'staffName', u.name, 'method', x.method, 'amount', x.amount, 'note', x.note, 'reviewNote', x."reviewNote"`,
    format: (row, e) => ({
      title: "현장 수납 승인",
      summary: join(won(e.amount), PAY_METHOD[text(e.method)] ?? e.method, e.staffName ? `${text(e.staffName)} 선생님` : ""),
      facts: [...fact("금액", won(e.amount)), ...fact("방법", PAY_METHOD[text(e.method)] ?? e.method), ...fact("받은 날", row.targetDate),
        ...fact("반", e.className), ...fact("받은 사람", e.staffName), ...fact("메모", e.note), ...fact("원장 메모", e.reviewNote)],
    }),
  },
];

// 모든 종류에 어댑터가 하나씩 있어야 한다(빠지면 그 종류가 신청함에서 조용히 사라진다 — 테스트가 확인)
export const INBOX_ADAPTER_KINDS: readonly RequestKind[] = ADAPTERS.map((a) => a.kind);

/** catalog 의 상태 목록 → SQL 배열 글자. 상태는 영문 대문자만이라 따옴표 탈출이 필요 없지만 한 번 더 거른다 */
function sqlTextArray(values: string[]): string {
  const safe = values.filter((v) => /^[A-Z_]+$/.test(v));
  return safe.length ? `ARRAY[${safe.map((v) => `'${v}'`).join(",")}]::text[]` : `ARRAY[]::text[]`;
}

function selectSql(adapter: Adapter): string {
  return `SELECT x.id::text AS id, ${adapter.rawExpr} AS raw, ${adapter.studentNameExpr} AS "studentName",
                 ${adapter.createdAtExpr} AS "createdAt", ${adapter.targetDateExpr} AS "targetDate",
                 json_build_object(${adapter.extra}) AS extra
            FROM ${adapter.from}
           ${adapter.where ? `WHERE ${adapter.where}` : ""}`;
}

export type InboxQuery = {
  bucket: InboxBucket;
  kinds?: RequestKind[];
  /** 신청일(KST) 범위 «YYYY-MM-DD» */
  from?: string | null;
  to?: string | null;
  /** 종류마다 최대 몇 줄(완료 칸이 끝없이 길어지지 않게) */
  limitPerKind?: number;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 신청함 목록 — 종류마다 따로 읽어(한 종류의 표가 아직 없어도 나머지는 보이게) 코드에서 합쳐 정렬한다.
 * 정렬: 처리 필요·진행 중은 오래된 것부터(밀린 일 먼저), 완료는 최신부터.
 */
export async function getInboxRows(query: InboxQuery): Promise<{ rows: InboxRow[]; failedKinds: RequestKind[] }> {
  const wanted = new Set(query.kinds?.length ? query.kinds : REQUEST_KINDS.map((k) => k.kind));
  const limit = Math.min(Math.max(Number(query.limitPerKind ?? 150), 1), 500);
  const from = query.from && YMD.test(query.from) ? query.from : null;
  const to = query.to && YMD.test(query.to) ? query.to : null;
  const failedKinds: RequestKind[] = [];

  const parts = await Promise.all(ADAPTERS.filter((a) => wanted.has(a.kind)).map(async (adapter) => {
    const statuses = statusesOf(adapter.kind, query.bucket);
    if (!statuses.length) return [] as InboxRow[];
    try {
      const rows = await prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT * FROM (${selectSql(adapter)}) t
          WHERE t.raw = ANY(${sqlTextArray(statuses)})
            AND ($1::date IS NULL OR (t."createdAt" AT TIME ZONE 'Asia/Seoul')::date >= $1::date)
            AND ($2::date IS NULL OR (t."createdAt" AT TIME ZONE 'Asia/Seoul')::date <= $2::date)
          ORDER BY t."createdAt" ${query.bucket === "DONE" ? "DESC" : "ASC"}
          LIMIT ${limit}`,
        from, to,
      );
      return rows.map((row) => toInboxRow(adapter, row));
    } catch (error) {
      console.error(`[admin-inbox] ${adapter.kind} 조회 실패:`, error);
      failedKinds.push(adapter.kind);
      return [] as InboxRow[];
    }
  }));

  const rows = parts.flat().sort((a, b) =>
    query.bucket === "DONE" ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt));
  return { rows, failedKinds };
}

function toInboxRow(adapter: Adapter, row: RawRow): InboxRow {
  const extra = (typeof row.extra === "string" ? JSON.parse(row.extra) : row.extra) ?? {};
  const formatted = adapter.format(row, extra);
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  return {
    kind: adapter.kind,
    id: row.id,
    studentName: row.studentName ?? null,
    title: formatted.title,
    summary: formatted.summary,
    rawStatus: row.raw,
    bucket: bucketFor(adapter.kind, row.raw),
    statusLabel: statusLabel(adapter.kind, row.raw),
    createdAt,
    targetDate: row.targetDate ?? null,
    detailHref: kindEntry(adapter.kind).adminHref,
    facts: formatted.facts,
    ref: formatted.ref,
  };
}

/** 처리 필요·진행 중 개수를 세는 SQL — 종류별 조각을 UNION ALL 로 붙여 «한 번»에 센다 */
export function buildInboxCountsSql(): string {
  const pieces = ADAPTERS.map((adapter) => {
    const open = [...statusesOf(adapter.kind, "ACTION"), ...statusesOf(adapter.kind, "ONGOING")];
    return `SELECT '${adapter.kind}'::text AS kind, t.raw, COUNT(*)::int AS n
              FROM (SELECT ${adapter.rawExpr} AS raw FROM ${adapter.from} ${adapter.where ? `WHERE ${adapter.where}` : ""}) t
             WHERE t.raw = ANY(${sqlTextArray(open)})
             GROUP BY t.raw`;
  });
  return pieces.join("\nUNION ALL\n");
}

/** 메뉴 배지·«오늘 업무» 카드 숫자. 실패하면 null(화면은 숫자만 숨긴다 — 관리자 화면 전체를 죽이지 않는다) */
export async function getInboxCounts(): Promise<InboxCounts | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ kind: RequestKind; raw: string; n: number }>>(buildInboxCountsSql());
    return summarizeCounts(rows);
  } catch (error) {
    console.error("[admin-inbox] 개수 조회 실패:", error);
    return null;
  }
}

/** 순수 합산 — 테스트가 직접 부른다 */
export function summarizeCounts(rows: Array<{ kind: RequestKind; raw: string; n: number }>): InboxCounts {
  const counts: InboxCounts = { action: 0, ongoing: 0, byKind: {} };
  for (const row of rows) {
    const bucket = bucketFor(row.kind, row.raw);
    if (bucket === "DONE") continue;
    const slot = (counts.byKind[row.kind] ??= { action: 0, ongoing: 0 });
    const n = Number(row.n) || 0;
    if (bucket === "ACTION") { slot.action += n; counts.action += n; } else { slot.ongoing += n; counts.ongoing += n; }
  }
  return counts;
}
