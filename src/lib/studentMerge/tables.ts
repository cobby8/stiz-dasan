// 학생 ID를 들고 있는 모든 컬럼 목록.
// 2026-07-26 DB 실측 28곳 → 2026-10-02 재실측(information_schema + pg_constraint + pg_index)으로
// 운영 DB 39곳 + 스키마에만 있고 운영 DB에는 아직 없는 4곳(mayBeMissing)으로 늘렸다.
// 왜 손으로 적어 두는가: FK가 걸린 곳도 있지만 FK 없이 문자열로만 물린 곳이 많다.
// FK만 따라가면 그 자리들이 그대로 남아 "흡수된 학생 ID를 가리키는 유령 행"이 된다.
// 새 테이블에 학생 ID 컬럼을 만들면 여기에 같이 적는다 — tables.test.ts 가 schema.prisma 와 대조해 잡아낸다.

export type StudentRefTable = {
  table: string;
  column: string;
  /**
   * studentId를 포함한 UNIQUE 제약의 나머지 컬럼들.
   * 여기 값이 있으면 그냥 UPDATE 할 수 없다(같은 조합이 대표 쪽에 이미 있으면 충돌).
   */
  conflictKeys?: string[];
  /**
   * 부분 UNIQUE 인덱스(WHERE 조건이 붙은 것)의 조건. 별칭을 받아 SQL 조건을 돌려준다.
   * 양쪽 행이 모두 이 조건을 만족할 때만 충돌로 본다(예: 취소 안 된 행끼리만 하루 1건).
   */
  conflictWhere?: (alias: string) => string;
  /**
   * UNIQUE 충돌로 못 옮길 때, 흡수 쪽 행이 더 "살아있는" 상태면 대표 쪽 행이 그 값을 승계한다.
   * (Enrollment 의 promote 와 같은 생각) 그래야 흡수 쪽에 남는 행이 진짜 중복이 되어 화면에서 숨겨도 된다.
   * priority 에 없는 상태는 0으로 본다 — 모르는 값으로는 승계하지 않는다.
   * updatedAt 은 건드리지 않는다(병합은 사람이 한 수정이 아니라서).
   * ⚠️ 결석 알림 복구 키에는 상태가 들어가므로, 최근 14일 안의 대표 행이 "취소 → 신고"로 승계되면
   *    원장에게 같은 결석 알림이 한 번 더 갈 수 있다(학부모 발송 아님). 2026-10-04 허용으로 결정.
   * 부분 UNIQUE(conflictWhere)와는 함께 쓰지 않는다 — 짝 찾기 SQL이 그 조건을 모른다(tables.test.ts 가 막는다).
   */
  promoteOnConflict?: {
    statusColumn: string;
    priority: Record<string, number>;
    /** 승계할 컬럼(statusColumn 포함). 학생·충돌 키·id·시각 컬럼은 넣지 않는다 */
    copyColumns: string[];
  };
  /** Payment의 연월 동결 규칙을 그대로 따라야 하는 청구 계열 테이블 */
  billingScoped?: boolean;
  /**
   * 병합해도 옮기지 않고 흡수 학생에 그대로 남기는 테이블. 값은 로그(SOFT_SKIP)에 남길 사유.
   * 행을 옮기려면 학생 컬럼 말고 다른 값(JSON 스냅샷 등)까지 고쳐야 하는 곳에 쓴다.
   */
  keepOnLoser?: string;
  /**
   * 부모 행을 따라가는 테이블. 부모 행이 대표 학생 소유가 됐을 때만 옮긴다(부모 연결이 비어 있으면 옮긴다).
   * 예: 학부모 납부요청은 연결된 Payment가 동결돼 흡수 쪽에 남으면 같이 남아야 금액·학생이 어긋나지 않는다.
   * 부모 테이블의 학생 컬럼은 "studentId"로 가정한다. 엔진은 청구·수강 이동이 끝난 뒤 이 테이블들을 처리한다.
   */
  followsParents?: { column: string; parentTable: string }[];
  /**
   * Payment(id, classId, studentId, amount) 복합 FK가 ON UPDATE CASCADE라
   * Payment를 옮기면 자동으로 따라온다. 직접 UPDATE 하면 오히려 FK가 깨진다.
   */
  cascadesFromPayment?: boolean;
  /** 이 모듈이 직접 처리하지 않고 별도 로직으로 다루는 테이블 */
  handledSeparately?: boolean;
  /** 스키마/마이그레이션에는 있지만 운영 DB에 아직 없을 수 있는 테이블. 없으면 건너뛴다 */
  mayBeMissing?: boolean;
};

export const STUDENT_REF_TABLES: StudentRefTable[] = [
  // --- FK 있음 ---
  { table: "Attendance", column: "studentId", conflictKeys: ["sessionId"] },
  { table: "Enrollment", column: "studentId", conflictKeys: ["classId"], handledSeparately: true },
  {
    // 수강 변경 신청. 대상 수강(Enrollment)이 UNIQUE 충돌로 흡수 쪽에 남거나,
    // 이미 청구한 Payment가 동결돼 남으면 신청도 같이 남아야 화면에서 학생이 엇갈리지 않는다.
    table: "EnrollmentChangeRequest",
    column: "studentId",
    followsParents: [
      { column: "enrollmentId", parentTable: "Enrollment" },
      { column: "invoicedPaymentId", parentTable: "Payment" },
    ],
  },
  { table: "Guardian", column: "studentId" },
  { table: "OperationsCommand", column: "studentId" },
  { table: "ParentOperationsRequestLink", column: "studentId" },
  { table: "Payment", column: "studentId", billingScoped: true, handledSeparately: true },
  {
    // 학부모 납부 신고/영수증 요청. Payment에 매달린 청구 계열이라 Payment를 그대로 따라간다.
    table: "PaymentParentRequest",
    column: "studentId",
    billingScoped: true,
    followsParents: [{ column: "paymentId", parentTable: "Payment" }],
  },
  { table: "RallyzAttendanceSyncItem", column: "studentId" },
  {
    // UNIQUE(studentId, classId, date) 는 상태를 보지 않는다. 대표 쪽이 취소(CANCELLED)이고
    // 흡수 쪽이 신고(REPORTED)·확인(CONFIRMED)이면 살아있는 결석이 흡수 쪽에 남아 기사 명단에서 빠진다.
    // → 대표 행이 흡수 쪽 상태·사유를 승계한다.
    table: "RegularAbsence",
    column: "studentId",
    conflictKeys: ["classId", "date"],
    promoteOnConflict: {
      statusColumn: "status",
      priority: { CONFIRMED: 3, REPORTED: 2, CANCELLED: 1 },
      copyColumns: ["status", "reason", "note", "reportedByUserId", "resolvedByUserId"],
    },
  },
  { table: "RegularShuttleStop", column: "studentId" },
  {
    table: "ShuttleDayException",
    column: "studentId",
    conflictKeys: ["serviceDate", "direction"],
    // ShuttleDayException_one_active_per_day: WHERE "canceledAt" IS NULL
    conflictWhere: (a) => `${a}."canceledAt" IS NULL`,
  },
  {
    table: "ShuttleRoutePassenger",
    column: "studentId",
    conflictKeys: ["routePlanId", "sessionId", "locationKind"],
  },
  {
    table: "StaffPaymentConfirmationRequest",
    column: "studentId",
    billingScoped: true,
    cascadesFromPayment: true,
  },
  { table: "StudentMediaConsent", column: "studentId" },
  { table: "StudentRegistrationLedger", column: "studentId" },
  { table: "StudentSessionNote", column: "studentId", conflictKeys: ["sessionId"] },
  { table: "StudentSheetRawRow", column: "studentId" },
  { table: "StudentShuttleLocation", column: "studentId", conflictKeys: ["kind"] },
  { table: "StudentShuttleRide", column: "studentId" },
  { table: "StudentTeamRosterEntry", column: "studentId" },

  // --- FK 없음 (빠뜨리면 유령 ID가 남는 자리) ---
  { table: "EnrollmentApplication", column: "convertedStudentId" },
  { table: "Feedback", column: "studentId" },
  { table: "KakaoParentIntake", column: "studentId" },
  { table: "MakeupCredit", column: "studentId", conflictKeys: ["sourceKey"] },
  { table: "MakeupSession", column: "studentId" },
  { table: "MediaRevocationJob", column: "studentId" },
  { table: "NotificationDelivery", column: "studentId" },
  { table: "ParentRequest", column: "studentId" },
  { table: "PaymentInvoice", column: "studentId", billingScoped: true, handledSeparately: true },
  { table: "PaymentTransaction", column: "studentId", billingScoped: true, handledSeparately: true },
  {
    // 토스 POS 결제 알림. 사이트 청구(sitePaymentId)에 연결됐으면 그 Payment를 따라간다.
    table: "PosPaymentNotice",
    column: "resolvedStudentId",
    billingScoped: true,
    followsParents: [{ column: "sitePaymentId", parentTable: "Payment" }],
  },
  // 이름은 스냅샷이지만 학부모 마이페이지가 자녀와 잇는 열쇠로 쓴다 → 유령 ID면 자녀 연결이 끊긴다.
  { table: "SeasonalShuttleRoster", column: "studentIdSnapshot" },
  { table: "SkillRecord", column: "studentId" },
  { table: "SpecialProgramApplication", column: "convertedStudentId" },
  { table: "SpecialProgramEnrollmentDate", column: "studentId" },
  { table: "SpecialProgramMakeup", column: "studentId" },
  { table: "TrialLead", column: "convertedStudentId" },
  { table: "Waitlist", column: "studentId", conflictKeys: ["classId"] },

  // --- 스키마에는 있으나 2026-10-02 운영 DB에는 아직 없는 테이블 ---
  { table: "RegularShuttleLocationLink", column: "studentId", mayBeMissing: true },
  { table: "RegularShuttleNoticeBatch", column: "studentId", mayBeMissing: true },
  // 월별 수강 대장(+이력). 반별 금액 근거 스냅샷이고, CHECK 제약이
  // payload->>'studentId' = "studentId" 를 강제해 컬럼만 바꾸면 병합 전체가 실패한다.
  // 금액 스냅샷 JSON을 고쳐 쓰지 않고, 동결월 Payment처럼 흡수 쪽에 그대로 남긴다.
  {
    table: "MonthlyEnrollmentRegister",
    column: "studentId",
    billingScoped: true,
    keepOnLoser: "월별 수강 대장은 payload 스냅샷과 학생이 묶여 있어 흡수 쪽에 남김",
    mayBeMissing: true,
  },
  {
    table: "MonthlyEnrollmentRegisterRevision",
    column: "studentId",
    billingScoped: true,
    keepOnLoser: "월별 수강 대장 이력은 payload 스냅샷과 학생이 묶여 있어 흡수 쪽에 남김",
    mayBeMissing: true,
  },
];

/**
 * `SocialPostDraft.subjectStudentIdsJSON`은 학생 ID를 JSON 배열 문자열로 들고 있다.
 * 컬럼 UPDATE로는 못 고치므로 문자열 치환이 필요하다.
 * 2026-07-26·2026-10-02 실측 모두 흡수 학생에 대한 참조는 0건이라 병합에서 건드릴 것이 없다.
 */
export const JSON_STUDENT_REF = {
  table: "SocialPostDraft",
  column: "subjectStudentIdsJSON",
} as const;

/** 병합 엔진이 자동으로 훑는 테이블 (개별 로직으로 따로 처리하는 것 제외) */
export function autoMovableTables(): StudentRefTable[] {
  return STUDENT_REF_TABLES.filter((t) => !t.handledSeparately && !t.cascadesFromPayment);
}

/** 부모 행을 따라가는 테이블인지 — 엔진은 청구·수강 이동이 끝난 뒤에 처리한다 */
export function followsParentRows(t: StudentRefTable): boolean {
  return (t.followsParents?.length ?? 0) > 0;
}
