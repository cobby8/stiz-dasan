import { createHash, randomUUID } from "node:crypto";
import { getMonthlyClassDates } from "@/lib/enrollment/monthlyClassDates";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";
import { notMergedStudent } from "@/lib/studentVisibility";
import { validateMonthlyRegisterDraft } from "./monthly-register";
import { WorkbenchError, carryPool, allocateCarry, filterWorkbenchDates, illnessMissedDatesOf, validateWorkbenchCommand, validateWorkbenchMonth, workbenchTotal, illnessReducedSumSql, shortMonthProration, attendedOnlyProration, STANDARD_MONTHLY_SESSIONS, WORKBENCH_GENERIC_REVIEW_REASON, WORKBENCH_SOURCE_CHANGED_REASON, AUTO_DRAFT_ACTOR,
  type WorkbenchAmounts, type WorkbenchView, type WorkbenchRow, type WorkbenchOperation, type WorkbenchCalendarSnapshot } from "./workbench";
// 주N회 요금·셔틀비·형제할인 «제안값» 규칙은 순수 모듈 한 곳에서만 정한다.
import { planWeeklyTuition, planShuttleFee, siblingDiscountStudents, siblingDiscountAmount, REGULAR_SIBLING_DISCOUNT_PERCENT, fixedTuitionCovers, fixedTuitionShortLabel, type ShuttlePlan, type FixedTuition } from "./workbench-pricing";
// 부상·질병 기간 결석의 «청구 발행 보류» 판정 조각·글자(순수 모듈 한 곳)
import { BILLING_HOLD_LABEL, BILLING_HOLD_MOVED_NOTE, illnessHoldPeriodSql, parseUnpaidGuides, unpaidGuideShape } from "@/lib/regular/illnessPeriodRules";

export type WorkbenchTx = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type WorkbenchDb = { $transaction<T>(work: (tx: WorkbenchTx) => Promise<T>, options?: { isolationLevel: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T> };
type Enrollment = { studentId: string; studentName: string; classId: string; className: string; status: string; startsOn?: Date | string | null; price: number; dayOfWeek: string; createdAt: Date | string; updatedAt: Date | string;
  // 주N회 요금·셔틀비·형제할인 제안에 쓰는 칸(조회에 없을 수도 있어 선택값)
  programId?: string | null; programName?: string | null; priceWeek1?: number | null; priceWeek2?: number | null; priceWeek3?: number | null; priceDaily?: number | null;
  runsShuttle?: boolean | null; shuttleFeeOverride?: number | null; slotKey?: string | null; parentId?: string | null; birthDate?: string | null };
type Register = { studentId: string; month: string; status: string; payload: unknown; version: number };
type Stored = { id: string; month: string; studentId: string; classId: string; version: number; status: "DRAFT" | "CONFIRMED" | "ISSUED" | "ZERO"; payload: WorkbenchAmounts; reason: string; sourceVersion: string; paymentId: string | null; periodStart?:string|null;periodEnd?:string|null;scheduledDates?:string[];calculationBasis?:Record<string,unknown>;
  /** 마지막으로 저장한 사람(User.id 또는 자동 초안 AUTO_DRAFT_ACTOR) — 자동 초안 표시에만 쓴다 */
  actorUserId?: string | null;
  /** 마지막으로 저장·발행한 시각 — 부상 결석 정산 «전»에 저장된 초안인지 가릴 때만 쓴다 */
  updatedAt?: Date | string | null };
type Absence = { id: string; studentId: string; studentName: string; classId: string; date: string; reason: string; status: string; makeupStatus: string | null; resolution: string | null };
type Credit = { id: string; studentId: string; numerator: string; denominator: string; availableMonth: string; absenceId?: string; valid?: boolean; basis?:{originMonth?:string;classId?:string;discountedTuition?:number;sourcePaymentId?:string|null;scheduledDates?:string[];periodStart?:string|null;periodEnd?:string|null;
  // 납부 Payment 근거 이월에만 있는 칸: source='PAID_PAYMENT' · 적립 때 청구 금액 · 그 청구에서 이미 줄인 금액
  source?:string;paymentAmount?:number;priorReduction?:number;
  // 부상 결석 기간 정산이 적립한 이월이면 그 기간 id
  periodId?:string} };
type Usage = { studentId: string; amount: number; month?: string; paymentId?: string | null; paymentStatus?: string | null; invoiceStatus?:string|null; basis?:unknown; sourceCreditIds?:string[] };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** 부상 결석 안내는 있는데 그 기간의 확정 시각을 읽지 못한 행의 차단 사유(확정·발행을 막는다) */
export const GUIDE_TIME_UNKNOWN_REASON = "부상 결석 정산 시각을 읽지 못해 저장해 둔 금액을 그대로 발행할 수 없습니다. 신청함 «부상 결석(기간)»에서 정산 상태를 확인해 주세요.";
const limit = 5001;
const take = <T>(rows: T[]) => { if (rows.length >= limit) throw new WorkbenchError("자료가 많아 전체 계산을 완료하지 못했습니다. 기간을 나눠 확인해 주세요.", 409); return rows; };
/** 고정 수강료를 자동 적용하지 않거나 일부만 적용했을 때의 검토 사유(검수 반영 2026-11-16) — 테스트가 같은 글자를 쓴다 */
export const FIXED_TUITION_REGISTER_NOTE = "고정 수강료 — 확정 장부가 있어 자동 적용 안 함, 확인 필요";
export const FIXED_TUITION_NO_ROW_NOTE = "고정 수강료 — 발행할 수 있는 반이 없어 자동 적용 안 함, 확인 필요";
export const FIXED_TUITION_PARTIAL_NOTE = "고정 수강료 — 다른 반에 이미 청구·발행 보류가 있어 발행할 수 있는 첫 반에 넣었습니다. 두 번 청구되지 않는지 확인 필요";
const amountFields = (r: WorkbenchAmounts): WorkbenchAmounts => ({ baseAmount: r.baseAmount, discountAmount: r.discountAmount, prorationAmount: r.prorationAmount, carryAmount: r.carryAmount, shuttleAmount: r.shuttleAmount });
export async function readWorkbenchSchedule(tx:WorkbenchTx,month:string,classId:string,start:string|null,end:string|null,calendar?:WorkbenchCalendarSnapshot) {
  const cls=await tx.$queryRawUnsafe<Array<{dayOfWeek:string}>>(`SELECT "dayOfWeek" FROM "Class" WHERE id=$1 FOR SHARE`,classId);
  const events=await tx.$queryRawUnsafe<Array<{title:string;date:Date|string;endDate:Date|string|null}>>(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`);
  const eventValues=calendar?.events??events.map(e=>({title:e.title,date:new Date(e.date).toISOString(),...(e.endDate?{endDate:new Date(e.endDate).toISOString()}:{})}));
  const allDates=getMonthlyClassDates(eventValues,month,cls[0]?.dayOfWeek??"");
  const periodStart=start??allDates[0]??null,periodEnd=end??allDates.at(-1)??null;
  return{periodStart,periodEnd,scheduledDates:periodStart&&periodEnd?filterWorkbenchDates(allDates,periodStart,periodEnd):[]};
}

/** 동일 거래의 원본만 읽는다. 외부 캘린더/서비스와 연결하거나 초기 테이블을 생성하지 않는다. */
// 읽기에 필요한 표가 있는지 한 번에 확인한다(2026-11-14 속도 개선 — 예전엔 표마다 따로 12번 왕복).
// 판정 기준은 예전 표별 확인과 같은 to_regclass 다.
const READ_TABLES = ["MonthlyEnrollmentRegister","AnnualEvent","BillingWorkbenchDraft","BillingWorkbenchOperation","BillingCarryCredit","BillingCarryUsage","BillingAbsenceResolution","BillingWorkbenchRevision","RegularAbsence","MakeupCredit","MakeupSession","Attendance","SpecialProgramCredit","RegularShuttleStop","RegularAbsencePeriod","PaymentAuditLog","StudentFixedTuition"] as const;
async function existingTables(tx: WorkbenchTx): Promise<Set<string>> {
  const rows = await tx.$queryRawUnsafe<Array<{ name: string; found: boolean }>>(
    `SELECT name, to_regclass('public."' || name || '"') IS NOT NULL AS found FROM unnest($1::text[]) AS name`, [...READ_TABLES]);
  return new Set(rows.filter(r => r.found).map(r => r.name));
}

// calendar 는 값 또는 «불러오는 중인 약속(Promise)»을 받는다. 약속을 받으면 아래 DB 조회와 동시에 불러와지고,
// 달력이 처음 필요한 곳(조회가 다 끝난 뒤)에서만 기다린다(2026-11-14 속도 개선). 달력 실패는 예전처럼 그대로 오류가 된다.
export async function readWorkbench(tx: WorkbenchTx, month: string, writesEnabled = false,calendarInput?:WorkbenchCalendarSnapshot|Promise<WorkbenchCalendarSnapshot>): Promise<WorkbenchView> {
  validateWorkbenchMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const tables = await existingTables(tx);
  const has = (table: (typeof READ_TABLES)[number]) => tables.has(table);
  const enrollments = take(await tx.$queryRawUnsafe<Enrollment[]>(`SELECT e."studentId", s.name AS "studentName", e."classId", c.name AS "className", e.status, e."startsOn"::text AS "startsOn",
    p.price, p.id AS "programId", p.name AS "programName", p."priceWeek1", p."priceWeek2", p."priceWeek3", p."priceDaily", p."runsShuttle", p."shuttleFeeOverride", c."slotKey",
    to_char(s."birthDate",'YYYY-MM-DD') AS "birthDate", c."dayOfWeek", s."parentId", c."updatedAt" AS "classUpdatedAt", p."updatedAt" AS "programUpdatedAt", e."createdAt", e."updatedAt" FROM "Enrollment" e JOIN "Student" s ON s.id=e."studentId"
    JOIN "Class" c ON c.id=e."classId" JOIN "Program" p ON p.id=c."programId"
    WHERE ${notMergedStudent("s")} ORDER BY e."studentId",e."classId" LIMIT ${limit}`));
  const payments = take(await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string | null; status: string; amount: number; type: string; updatedAt: Date | string }>>(`SELECT id,"studentId","classId",status,amount,type,"updatedAt" FROM "Payment" WHERE year=$1 AND month=$2 ORDER BY id LIMIT ${limit}`, year, monthNumber));
  const invoices = take(await tx.$queryRawUnsafe<Array<{ id: string; paymentId: string; status: string; amount: number; updatedAt: Date | string }>>(`SELECT i.id,i."paymentId",i.status,i.amount,i."updatedAt" FROM "PaymentInvoice" i JOIN "Payment" p ON p.id=i."paymentId" WHERE p.year=$1 AND p.month=$2 ORDER BY i.id LIMIT ${limit}`, year, monthNumber));
  const registerReady = has("MonthlyEnrollmentRegister");
  const registers = registerReady ? take(await tx.$queryRawUnsafe<Register[]>(`SELECT "studentId",month,status,payload,version FROM "MonthlyEnrollmentRegister" ORDER BY month,"studentId" LIMIT ${limit}`)) : [];
  const events = has("AnnualEvent") ? take(await tx.$queryRawUnsafe<Array<{ title: string; date: Date | string; endDate: Date | string | null }>>(`SELECT title,date,"endDate","updatedAt" FROM "AnnualEvent" ORDER BY date,id LIMIT ${limit}`)) : [];
  const storageReady = (["BillingWorkbenchDraft", "BillingWorkbenchOperation", "BillingCarryCredit", "BillingCarryUsage", "BillingAbsenceResolution", "BillingWorkbenchRevision"] as const).every(has);
  const drafts = storageReady ? take(await tx.$queryRawUnsafe<Stored[]>(`SELECT * FROM "BillingWorkbenchDraft" WHERE month=$1 ORDER BY id LIMIT ${limit}`, month)) : [];
  // 원기간에서 실제 수정·발행한 금액도 결석 정산의 정본이다. 선택월 초안은 자체 저장으로 해시가 변하지 않게 제외한다.
  const originDrafts = storageReady ? take(await tx.$queryRawUnsafe<Stored[]>(`SELECT * FROM "BillingWorkbenchDraft" WHERE month<>$1 AND status IN ('ISSUED','ZERO') ORDER BY month,id LIMIT ${limit}`,month)) : [];
  const credits = storageReady ? take(await tx.$queryRawUnsafe<Credit[]>(`SELECT c.id,c."studentId",c."absenceId",c.numerator::text,c.denominator::text,c."availableMonth",c.basis,
    (a.status='CONFIRMED' AND COALESCE(c.basis->>'originalReason',a.reason)=a.reason AND COALESCE(c.basis->>'absenceDate',to_char(a.date,'YYYY-MM-DD'))=to_char(a.date,'YYYY-MM-DD') AND COALESCE(c.basis->>'classId',a."classId")=a."classId" AND NOT EXISTS(SELECT 1 FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" WHERE t."studentId"=c."studentId" AND se."classId"=a."classId" AND se.date::date=a.date::date AND t.status<>'ABSENT')) AS valid
    FROM "BillingCarryCredit" c JOIN "RegularAbsence" a ON a.id=c."absenceId" WHERE c."availableMonth" <= $1 OR c.id IN (SELECT unnest(u."sourceCreditIds") FROM "BillingCarryUsage" u) ORDER BY c.id LIMIT ${limit}`, month)) : [];
  // 결석 이월 검증에 필요한 «원래 청구»만 읽는다(2026-11-14 — 예전엔 결제·청구서 표 전체를 읽어 5,001건 한도에 닿을 수 있었다).
  // 아래 검증은 credit.basis.sourcePaymentId 로만 찾으므로, 그 결제와 그 결제의 청구서만 있으면 판정이 같다.
  const sourcePaymentIds = [...new Set(credits.map(c => c.basis?.sourcePaymentId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  // illnessReduced = 질병·부상 결석으로 그 청구에서 이미 줄인 금액(2026-11-16 «미납 청구에서 1회분 빼기»). 아래 발행 금액 대조가 이 값을 더해 견준다.
  // 줄인 적이 없는 청구(0)는 칸을 떼어 낸다 — 원본 지문(sourceVersion)에 새 칸이 끼어 저장해 둔 초안이 전부 «원본 변경»으로 바뀌지 않게.
  const originPayments = sourcePaymentIds.length ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;classId:string|null;amount:number;status:string;year:number|null;month:number|null;updatedAt:Date|string;illnessReduced?:number|null}>>(`SELECT id,"studentId","classId",amount,status,year,month,"updatedAt",${has("PaymentAuditLog") ? illnessReducedSumSql('"Payment".id') : "0"} AS "illnessReduced" FROM "Payment" WHERE id = ANY($1::text[]) ORDER BY id LIMIT ${limit}`, sourcePaymentIds))
    .map(({ illnessReduced, ...row }): typeof row & { illnessReduced?: number } => Number(illnessReduced ?? 0) > 0 ? { ...row, illnessReduced: Number(illnessReduced) } : row) : [];
  const originInvoices = sourcePaymentIds.length ? take(await tx.$queryRawUnsafe<Array<{id:string;paymentId:string;status:string;amount:number;updatedAt:Date|string}>>(`SELECT id,"paymentId",status,amount,"updatedAt" FROM "PaymentInvoice" WHERE "paymentId" = ANY($1::text[]) ORDER BY id LIMIT ${limit}`, sourcePaymentIds)) : [];
  // 미래 기간에서 사용한 잔액도 중복 차감하지 않는다.
  const usages = storageReady ? take(await tx.$queryRawUnsafe<Usage[]>(`SELECT u."studentId",u.amount,u.month,u."paymentId",u.basis,u."sourceCreditIds",p.status AS "paymentStatus",i.status AS "invoiceStatus" FROM "BillingCarryUsage" u LEFT JOIN "Payment" p ON p.id=u."paymentId" LEFT JOIN "PaymentInvoice" i ON i."paymentId"=p.id ORDER BY u.id LIMIT ${limit}`)) : [];
  const absences: Absence[] = has("RegularAbsence") ? take(await tx.$queryRawUnsafe<Absence[]>(`SELECT a.id,a."studentId",s.name AS "studentName",a."classId",to_char(a.date,'YYYY-MM-DD') AS date,a.reason,a.status,
      ${has("MakeupCredit") ? `(SELECT string_agg(DISTINCT m.status,',') FROM "MakeupCredit" m WHERE m."studentId"=a."studentId" AND m."sourceKey"='REGULAR:'||a."classId"||':'||to_char(a.date,'YYYY-MM-DD'))` : `NULL::text`} AS "makeupStatus",
      ${storageReady ? `(SELECT r.resolution FROM "BillingAbsenceResolution" r WHERE r."absenceId"=a.id)` : `NULL::text`} AS resolution
      FROM "RegularAbsence" a JOIN "Student" s ON s.id=a."studentId" WHERE ${notMergedStudent("s")} AND a.date>='2026-10-05'::date AND a.date < ($1||'-01')::date+interval '1 month' AND a.status<>'CANCELLED' ORDER BY a.id LIMIT ${limit}`, month)) : [];
  const bookings = has("MakeupSession") ? take(await tx.$queryRawUnsafe<Array<{ id: string; status: string; studentId: string; originalClassId: string; originalDate: Date | string; updatedAt: Date | string }>>(`SELECT id,status,"studentId","originalClassId","originalDate","updatedAt" FROM "MakeupSession" WHERE "originalDate">='2026-10-05'::timestamp AND "originalDate" < ($1||'-01')::date+interval '1 month' ORDER BY id LIMIT ${limit}`,month)) : [];
  const makeupSource = has("MakeupCredit") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;sourceKey:string;status:string;updatedAt:Date|string;makeupSessionId:string|null}>>(`SELECT id,"studentId","sourceKey",status,"updatedAt","makeupSessionId" FROM "MakeupCredit" ORDER BY id LIMIT ${limit}`)) : [];
  // 출결은 «변경 감지 지문»(sourceVersion)에만 쓰인다. 결석 이월 판정이 실제로 보는 출결 = 결석 신고(RegularAbsence)와
  // 같은 학생·반·날짜의 출결뿐이라 그것만 읽는다(2026-11-14 — 예전엔 출결 전체를 읽어 5,001건 한도에 곧 닿았다).
  const attendance = has("Attendance") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;classId:string;date:string;status:string;updatedAt:Date|string}>>(has("RegularAbsence")
    ? `SELECT DISTINCT t.id,t."studentId",se."classId",to_char(se.date,'YYYY-MM-DD') AS date,t.status,t."updatedAt" FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId"
        JOIN "RegularAbsence" a ON a."studentId"=t."studentId" AND a."classId"=se."classId" AND a.date::date=se.date::date ORDER BY t.id LIMIT ${limit}`
    : `SELECT t.id,t."studentId",se."classId",to_char(se.date,'YYYY-MM-DD') AS date,t.status,t."updatedAt" FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" WHERE false`)) : [];
  const seasonalCredits = has("SpecialProgramCredit") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string|null;amount:number;status:string;updatedAt:Date|string}>>(`SELECT cr.id,a."convertedStudentId" AS "studentId",cr.amount,cr.status,cr."updatedAt" FROM "SpecialProgramCredit" cr JOIN "SpecialProgramApplicationItem" it ON it.id=cr."applicationItemId" JOIN "SpecialProgramApplication" a ON a.id=it."applicationId" WHERE cr.status='ACTIVE' ORDER BY cr.id LIMIT ${limit}`)) : [];
  // 그 달 셔틀 명단(셔틀 명단 탭에서 편집하는 RegularShuttleStop). 학생 연결(studentId)된 승차·하차 행만 이용자로 본다.
  // 이름만 있고 학생 연결이 없는 행은 동명이인 오청구 위험이 있어 자동 제안에 쓰지 않고 안내만 한다.
  // 무료 거점(1호점 앞 버스정류장) 판정에 쓰도록 방향·정류장 이름도 함께 읽는다.
  const shuttleStops = has("RegularShuttleStop") ? take(await tx.$queryRawUnsafe<Array<{studentId:string|null;studentName:string;direction:string;stopName:string}>>(`SELECT DISTINCT "studentId","studentName",direction,"stopName" FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 AND direction IN ('BOARD','ALIGHT') AND "studentName" IS NOT NULL AND btrim("studentName")<>'' ORDER BY "studentName","studentId",direction,"stopName" LIMIT ${limit}`,month)) : [];
  // 부상·질병 기간 결석 «발행 보류»(2026-11-15 원장 결정): 승인됐고 금액이 아직 확정되지 않은 기간이 있는 학생은
  // 그 기간이 시작한 달부터 «그 기간의 대상 반» 청구를 발행하지 않는다(대상 반이 빈 배열이면 그 학생의 반 전부).
  // 결석이 아닌 다른 반은 정상 발행된다 — 이미 발행된 미납 청구를 보류로 돌리는 범위(holdIssuedBillsForPeriod)와 같다.
  // 보류는 표시 칸이 아니라 기간 상태에서 계산한다(판정 조각 한 곳).
  // 기간 정산 칸이 아직 없는 DB 면 읽지 않는다(없는 칸을 읽으면 조회 전체가 실패한다).
  const holdReady = has("RegularAbsencePeriod") && Number((await tx.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='RegularAbsencePeriod' AND column_name='carryState'`))[0]?.n ?? 0) === 1;
  const illnessHolds = holdReady ? take(await tx.$queryRawUnsafe<Array<{ studentId: string; periodId: string; startMonth: string; classIds: string[] | null }>>(
    `SELECT hp."studentId", hp.id AS "periodId", to_char(hp."startDate",'YYYY-MM') AS "startMonth", hp."classIds" AS "classIds" FROM "RegularAbsencePeriod" hp
      WHERE ${illnessHoldPeriodSql("hp")} AND to_char(hp."startDate",'YYYY-MM') <= $1 ORDER BY hp."studentId", hp."startDate", hp.id LIMIT ${limit}`, month)) : [];
  // 그 학생·그 반을 보류로 만드는 기간 id(없으면 undefined). 대상 반이 빈 배열인 기간은 그 학생의 모든 반을 막는다
  const holdPeriodFor = (studentId: string, classId: string) => illnessHolds.find(held => held.studentId === studentId
    && (!Array.isArray(held.classIds) || held.classIds.length === 0 || held.classIds.includes(classId)))?.periodId;
  // 부상 결석 복귀 정산(3단계)이 남긴 «낸 돈이 없는 달» 안내 — 이월을 만들지 않은 대신 이 달 청구를 «다닌 횟수만큼만» 제안한다.
  // 확정된(SETTLED) 기간의 carrySettlement.unpaidGuides 중 이 달 것만 읽는다(칸이 없는 DB 는 읽지 않는다).
  const illnessGuides = holdReady ? take(await tx.$queryRawUnsafe<Array<{ studentId: string; periodId: string; guides: unknown; settledAt: Date | string | null }>>(
    `SELECT sp."studentId", sp.id AS "periodId", sp."carrySettlement"->'unpaidGuides' AS guides, sp."carrySettledAt" AS "settledAt" FROM "RegularAbsencePeriod" sp
      WHERE sp.reason = 'ILLNESS_INJURY' AND sp."carryState" = 'SETTLED'
        AND sp."carrySettlement"->'unpaidGuides' @> jsonb_build_array(jsonb_build_object('month', $1::text))
      ORDER BY sp."studentId", sp.id LIMIT ${limit}`, month))
    // settledAtMs = 그 기간의 이월을 확정한 시각(carrySettledAt, timestamptz — 시각끼리만 견준다. 달력 날짜 계산이 아니다)
    .flatMap(row => parseUnpaidGuides(row.guides, month).map(guide => ({ studentId: row.studentId, periodId: row.periodId, settledAtMs: row.settledAt ? new Date(row.settledAt).getTime() : null, ...guide }))) : [];
  /**
   * 그 학생·그 반·이 달의 정산 안내 상태 — 행 계산과 «다른 반 초안의 셔틀비» 판정이 같은 함수를 쓴다.
   *   guided    = 빠진 날의 모양(앞쪽·뒤쪽·전부·가운데)을 지금 일정으로 다시 본 것. 확정 장부가 있는 행·제외된 행은 건드리지 않는다.
   *               같은 반·같은 달에 안내가 둘 이상이면(기간이 두 번) 빠진 날을 합친다.
   *   overrides = 저장 초안이 그 기간의 확정 «전»에 저장된 것(초안 updatedAt < 확정 시각)인가. 그런 초안에는 빠진 수업이 반영돼 있지 않아
   *               그대로 다시 저장하면 낸 돈이 없는 달이 전액으로 발행된다 → 기간·기간 조정·이월은 제안값을 기본으로 쓴다.
   *               확정 «뒤»에 원장이 손으로 고쳐 저장한 초안은, 다른 학생의 발행·납부로 원본 지문이 바뀌어도 다시 덮지 않는다.
   *               시각을 못 읽으면(확정 시각·초안 저장 시각 중 하나라도) «정산 전 초안»으로 본다 — 모르는 채로 저장값(전액)을 유지하지 않는다.
   *   timeUnknown = 안내는 있는데 그 기간의 확정 시각 자체를 읽지 못했다. 다시 저장해도 «정산 뒤에 저장한 것»인지 가릴 수 없으므로
   *               제안값으로 덮는 것에 더해 그 행의 확정·발행을 막는다(전용 차단 사유).
   * dates 는 «그 아이가 수강한 수업일»이다(월중 등록이면 개시일 이후만) — 개시일 전 회차를 «다닌 날»로 세지 않는다.
   */
  const guideStateOf = (studentId: string, classId: string, dates: readonly string[], untouched: boolean, savedDraft?: Stored) => {
    const mine = untouched ? [] : illnessGuides.filter(g => g.studentId === studentId && g.classId === classId);
    const shape = mine.length ? unpaidGuideShape(dates, mine.flatMap(g => g.missedDates)) : null;
    const guided = shape && shape.shape !== "NONE" ? shape : null;
    const settledAt = mine.reduce<number | null>((latest, g) => g.settledAtMs !== null && Number.isFinite(g.settledAtMs) && (latest === null || g.settledAtMs > latest) ? g.settledAtMs : latest, null);
    const savedAt = savedDraft?.updatedAt ? new Date(savedDraft.updatedAt).getTime() : NaN;
    const openDraft = Boolean(guided && dates.length > 0 && savedDraft && !["ISSUED", "ZERO"].includes(savedDraft.status));
    const overrides = openDraft && (settledAt === null || !Number.isFinite(savedAt) || savedAt < settledAt);
    return { guided, overrides, timeUnknown: openDraft && settledAt === null };
  };
  // 월중 등록: 수강 개시일 전 수업은 그 아이의 수업일이 아니다(부상 결석 안내의 «다닌 횟수»에서 뺀다)
  const enrolledDates = (dates: readonly string[], startsOn: string | null) => startsOn ? dates.filter(date => date >= startsOn) : [...dates];
  // 승인·정산된 질병 기간에 묶인 결석 — 결석 정산 목록에서 «기간 정산에서 처리»로 보이고 하루씩 처리 버튼을 숨긴다(서버는 이미 거절한다).
  // 표시용이라 원본 지문(sourceVersion)에는 넣지 않는다 — 위 결석 목록과 따로 읽어, 이 칸 때문에 저장해 둔 초안이 낡은 것으로 바뀌지 않게.
  const periodAbsenceRows = holdReady && has("RegularAbsence") ? take(await tx.$queryRawUnsafe<Array<{ id: string; periodId: string }>>(
    `SELECT pa.id, pa."periodId" AS "periodId" FROM "RegularAbsence" pa JOIN "RegularAbsencePeriod" pp ON pp.id = pa."periodId"
      WHERE pa.reason = 'ILLNESS_INJURY' AND pa.status <> 'CANCELLED' AND pp."carryState" <> 'NONE'
        AND pa.date < ($1||'-01')::date + interval '1 month' ORDER BY pa.id LIMIT ${limit}`, month)) : [];
  const carryPeriodOf = new Map(periodAbsenceRows.map(row => [row.id, row.periodId]));
  // 학생별 고정 월 수강료(2026-11-16 원장 결정 — 예: 서우빈 «매달 15만 원 고정»). 그 달이 기간 안인 것만 읽는다.
  // 표가 아직 없는 DB(운영 적용 전)면 읽지 않는다 → 예전과 똑같이 계산된다.
  // 같은 학생에 겹치는 기간이 있으면(저장 화면이 막지만) 가장 나중에 만든 것을 쓴다.
  const fixedTuitionRows = has("StudentFixedTuition") ? take(await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; amount: number; startMonth: string; endMonth: string | null; memo: string | null; updatedAt: Date | string }>>(
    `SELECT id,"studentId",amount,"startMonth","endMonth",memo,"updatedAt" FROM "StudentFixedTuition" WHERE "startMonth" <= $1 AND ("endMonth" IS NULL OR "endMonth" >= $1) ORDER BY "studentId","createdAt" DESC,id LIMIT ${limit}`, month)) : [];
  const fixedTuitionByStudent = new Map<string, FixedTuition>();
  for (const row of fixedTuitionRows) if (fixedTuitionCovers(row, month) && !fixedTuitionByStudent.has(row.studentId)) fixedTuitionByStudent.set(row.studentId, { amount: Number(row.amount), memo: row.memo ?? null });
  const shuttleRiders = new Set(shuttleStops.map(r=>r.studentId).filter((v):v is string=>Boolean(v)));
  const unlinkedShuttleNames = [...new Set(shuttleStops.filter(r=>!r.studentId).map(r=>r.studentName))];
  const calendar = await calendarInput;
  const eventValues = calendar?.events??events.map(e => ({ title: e.title, date: new Date(e.date).toISOString(), ...(e.endDate ? { endDate: new Date(e.endDate).toISOString() } : {}) }));
  // 같은 달·같은 요일의 수업일은 한 번만 계산한다(2026-11-14 속도 개선 — 예전엔 반 500여 개마다 연간 일정 전체를 다시 훑었다).
  // 순수 계산이라 결과는 같고, 받는 쪽이 고쳐도 기억한 값이 바뀌지 않게 복사본을 준다.
  const classDatesMemo = new Map<string, string[]>();
  const classDates = (targetMonth: string, dayOfWeek: string) => {
    const key = `${targetMonth}|${dayOfWeek}`;
    let dates = classDatesMemo.get(key);
    if (!dates) { dates = getMonthlyClassDates(eventValues, targetMonth, dayOfWeek); classDatesMemo.set(key, dates); }
    return [...dates];
  };
  for(const credit of credits) if(credit.basis?.originMonth && credit.basis.classId) {
    const b=credit.basis,issued=[...originDrafts,...drafts].find(d=>d.studentId===credit.studentId&&d.classId===b.classId&&d.month===b.originMonth&&["ISSUED","ZERO"].includes(d.status));
    const reg=registers.find(r=>r.studentId===credit.studentId&&r.month===b.originMonth&&r.status==="CONFIRMED");
    let monthly:ReturnType<typeof validateMonthlyRegisterDraft>["classes"][number]|undefined;
    // 납부 Payment 근거 이월(2026-11-15 — 랠리즈에서 넘어온 달처럼 발행 초안·확정 장부가 없는 달).
    // 초안·장부 대신 «그 청구가 지금도 그 학생·그 반·그 달의 납부완료이고 금액이 적립 때 사본과 같은가»로 본다.
    // 환불·취소되거나 금액이 바뀌면 무효 → 아래 «원결석 취소·출석 정정된 이월» 차단 사유로 이어진다.
    const paidEvidence=b.source==="PAID_PAYMENT";
    if(paidEvidence){
      const p=originPayments.find(p=>p.id===b.sourcePaymentId);
      if(!p||p.status!=="PAID"||p.studentId!==credit.studentId||p.classId!==b.classId||`${p.year}-${String(p.month).padStart(2,"0")}`!==b.originMonth||p.amount!==b.paymentAmount||b.discountedTuition!==p.amount+(b.priorReduction??0))credit.valid=false;
    } else {
    try{monthly=reg?validateMonthlyRegisterDraft(reg.payload).classes.find(c=>c.classId===b.classId):undefined;}catch{credit.valid=false;}
    const latest=issued?.payload??monthly,monthlyRow=monthly;
    if(!latest || latest.baseAmount-latest.discountAmount-latest.prorationAmount!==b.discountedTuition || (monthlyRow&&["baseAmount","discountAmount","prorationAmount"].some(k=>issued&&issued.payload[k as keyof WorkbenchAmounts]!==monthlyRow[k as "baseAmount"|"discountAmount"|"prorationAmount"])))credit.valid=false;
    if(b.sourcePaymentId){
      const p=originPayments.find(p=>p.id===b.sourcePaymentId),invoice=originInvoices.find(i=>i.paymentId===b.sourcePaymentId);
      // 질병·부상 결석으로 줄인 금액은 «이미 줄인 금액»으로 인정한다(지금 금액 + 줄인 금액 = 발행 금액이면 정본이 맞다) — 근거 읽기(workbench-absence)와 같은 비교
      if(!p||!issued||p.amount+(p.illnessReduced??0)!==workbenchTotal(issued.payload)||!invoice||invoice.amount!==p.amount||["CANCELED","CANCELLED","REFUNDED"].includes(p.status)||["CANCELED","CANCELLED","REFUNDED"].includes(invoice.status))credit.valid=false;
    }
    }
    // 납부 Payment 근거의 수강 기간은 적립 때 사본(월중 등록이면 개시일~그 달 마지막 수업일)만 본다.
    const periodStart=paidEvidence?b.periodStart:issued?.periodStart??monthly?.periodStart??b.periodStart;
    const periodEnd=paidEvidence?b.periodEnd:issued?.periodEnd??monthly?.periodEnd??b.periodEnd;
    const day=enrollments.find(e=>e.classId===b.classId)?.dayOfWeek;
    // 적립 후 휴강·원기간 조정으로 실제 분모가 바뀌면 새 사유 저장으로 우회하지 않는다.
    let currentDates=day?classDates(b.originMonth!,day):[];
    try{if(periodStart&&periodEnd)currentDates=filterWorkbenchDates(currentDates,periodStart,periodEnd);}catch{credit.valid=false;}
    // 달 가운데가 빠진 달로 발행한 초안은 수업일 사본에 다닌 날만 있다(빠진 날은 calculationBasis.illnessMissedDates) — 같은 날을 빼고 견준다
    const issuedMissed=!paidEvidence?illnessMissedDatesOf(issued?.calculationBasis):[];
    if(issuedMissed.length)currentDates=currentDates.filter(date=>!issuedMissed.includes(date));
    if(!b.scheduledDates?.length || String(b.scheduledDates.length)!==credit.denominator || JSON.stringify([...b.scheduledDates].sort())!==JSON.stringify(currentDates))credit.valid=false;
  }
  // 날짜 변환기는 한 번만 만든다(반복문 안에서 매번 만들면 느리다). 판정 기준(KST 날짜)은 그대로.
  const kstYmd = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul"});
  for(const absence of absences) {
    const states = new Set((absence.makeupStatus ?? "").split(",").filter(Boolean));
    for(const booking of bookings) if(booking.studentId===absence.studentId && booking.originalClassId===absence.classId && kstYmd.format(new Date(booking.originalDate))===absence.date && booking.status!=="CANCELLED") states.add(booking.status);
    absence.makeupStatus=states.size ? [...states].sort().join(",") : null;
  }
  const completedCurrentDrafts=drafts.filter(d=>["ISSUED","ZERO"].includes(d.status));
  const calendarSource=calendar?.kind??"DB";
  const officialCalendarFingerprint=calendar?hash({kind:calendar.kind,events:calendar.events,fingerprint:calendar.fingerprint}):null;
  // 보류 목록도 원본이다 — 화면을 연 뒤 승인(보류)이 끼면 지문이 달라져 확정·발행이 거절된다.
  // 보류가 한 건도 없으면 키를 넣지 않는다: 보류가 없는 달의 지문이 예전과 같아야 이미 저장·확정해 둔 초안이 그대로 유효하다.
  const sourceVersion = hash({ month, enrollments, payments, invoices, registers, events, officialCalendarFingerprint, calendarSource, credits, usages, absences, bookings, originDrafts, completedCurrentDrafts, originPayments, originInvoices, makeupSource, attendance, seasonalCredits, shuttleStops, ...(illnessHolds.length ? { illnessHolds } : {}),
    // 정산 안내도 원본이다 — 화면을 연 뒤 확정·확정 취소가 끼면 지문이 달라진다. 안내가 없는 달의 지문은 예전 그대로
    ...(illnessGuides.length ? { illnessGuides } : {}),
    // 고정 수강료도 원본이다 — 화면을 연 뒤 원장이 바꾸면 지문이 달라진다. 없는 달의 지문은 예전 그대로(저장해 둔 초안이 낡은 것으로 바뀌지 않게)
    ...(fixedTuitionRows.length ? { fixedTuitionRows } : {}) });
  const pool = (studentId:string)=>carryPool(credits.filter(c=>c.studentId===studentId),usages.filter(u=>u.studentId===studentId),month);
  const available = (studentId: string) => pool(studentId).available;
  const assignedShuttle = new Set<string>(), assignedCarry = new Map<string, number>();
  // 행마다 «이번 달 청구 대상인가(excluded)»를 먼저 한 번에 정한다.
  // 주N회 요금(같은 프로그램 몇 반)·형제할인(재원 형제 몇 명)은 다른 행의 제외 여부를 알아야 셀 수 있어서다.
  const scopeOf = (e: Enrollment) => {
    const register = registers.find(r => r.studentId === e.studentId && r.month===month && r.status === "CONFIRMED");
    let reg: ReturnType<typeof validateMonthlyRegisterDraft> | null = null;
    if (register) { try { reg = validateMonthlyRegisterDraft(register.payload); } catch { /* 잘못된 확정 장부는 발행을 막는다. */ } }
    const allScheduledDates = classDates(month, e.dayOfWeek);
    const classReg = reg?.classes.find(c => c.classId === e.classId);
    const startsOn = typeof e.startsOn === "string" ? e.startsOn : null;
    const futurePeriod=Boolean(startsOn && allScheduledDates.length && startsOn > allScheduledDates.at(-1)!);
    const excluded = e.status !== "ACTIVE" || Boolean(classReg && classReg.status !== "ACTIVE") || futurePeriod;
    return { register, reg, allScheduledDates, classReg, startsOn, futurePeriod, excluded };
  };
  const scopes = new Map<string, ReturnType<typeof scopeOf>>(enrollments.map(e => [`${e.studentId}:${e.classId}`, scopeOf(e)]));
  const billable = enrollments.filter(e => !scopes.get(`${e.studentId}:${e.classId}`)!.excluded);
  // (0) 학생별 고정 수강료를 «이번 달 자동 적용해도 안전한가»로 거른다(검수 반영 2026-11-16 — 두 번 청구 방지).
  //   - 그 학생의 청구 대상 반 중 하나라도 확정 월 장부(classReg)가 있으면 적용하지 않는다 — 장부 반 금액 + 고정 금액이 겹칠 수 있다.
  //   - 고정 금액은 «발행 가능한 첫 행»(이미 발행·0원 정산·기존 청구·발행 보류가 아닌 행)에 붙인다. 그런 행이 없으면 적용하지 않는다.
  //   - 적용하지 않거나, 다른 반에 이미 청구가 있으면 그 학생 행에 검토 사유를 붙인다(원장이 직접 확인).
  const rowIssuable = (e: Enrollment) => {
    const saved = drafts.find(d => d.id === `${e.studentId}:${e.classId}`);
    if (saved && ["ISSUED", "ZERO"].includes(saved.status)) return false;
    if (payments.some(p => p.studentId === e.studentId && p.status !== "CANCELED" && p.status !== "CANCELLED" && (p.classId === e.classId || p.classId === null) && p.type !== "UNIFORM")) return false;
    return !holdPeriodFor(e.studentId, e.classId);
  };
  const fixedApplied = new Map<string, FixedTuition>();
  const fixedNotes = new Map<string, string>();
  for (const [studentId, fixed] of fixedTuitionByStudent) {
    const mine = billable.filter(e => e.studentId === studentId);
    if (!mine.length) continue;
    if (mine.some(e => scopes.get(`${e.studentId}:${e.classId}`)!.classReg)) { fixedNotes.set(studentId, FIXED_TUITION_REGISTER_NOTE); continue; }
    if (!mine.some(rowIssuable)) { fixedNotes.set(studentId, FIXED_TUITION_NO_ROW_NOTE); continue; }
    fixedApplied.set(studentId, fixed);
    if (mine.some(e => !rowIssuable(e))) fixedNotes.set(studentId, FIXED_TUITION_PARTIAL_NOTE);
  }
  // 고정 금액은 계산 함수가 «학생의 첫 행»에 넣는다 — 고정 적용 학생은 발행 가능한 행이 앞에 오게 순서만 바꾼다(다른 학생 순서는 그대로).
  const plannable = billable.filter(e => !scopes.get(`${e.studentId}:${e.classId}`)!.classReg);
  const tuitionInput = [...plannable.filter(e => !fixedApplied.has(e.studentId) || rowIssuable(e)), ...plannable.filter(e => fixedApplied.has(e.studentId) && !rowIssuable(e))];
  // (1) 수강료: 확정 장부가 없는 청구 대상 반만 학생 단위로 계산한다(전체 주 횟수 N 기준 주N회 요금·대회준비반 30만원 묶음).
  const tuitionPlans = planWeeklyTuition(tuitionInput.map(e => ({
    key: `${e.studentId}:${e.classId}`, studentId: e.studentId, programId: e.programId ?? null, programName: e.programName ?? null, dayOfWeek: e.dayOfWeek,
    price: e.price, priceWeek1: e.priceWeek1 ?? null, priceWeek2: e.priceWeek2 ?? null, priceWeek3: e.priceWeek3 ?? null, priceDaily: e.priceDaily ?? null })),
    // 학생별 고정 월 수강료가 있으면 반별 합산 대신 그 금액(형제할인·3회 달 차감 없음 — fixedFee). 위에서 안전하다고 거른 학생만.
    fixedApplied);
  // (2) 셔틀비: 그 달 명단에 있는 학생만, 청구 대상 반의 주 횟수로 제안한다.
  const shuttlePlans = new Map<string, ShuttlePlan>();
  for (const studentId of new Set(billable.map(e => e.studentId))) shuttlePlans.set(studentId, planShuttleFee(shuttleRiders.has(studentId),
    billable.filter(e => e.studentId === studentId).map(e => ({ dayOfWeek: e.dayOfWeek, slotKey: e.slotKey ?? null, runsShuttle: Boolean(e.runsShuttle), shuttleFeeOverride: e.shuttleFeeOverride ?? null })),
    // 그 학생의 명단 정류장(무료 거점 판정)
    shuttleStops.filter(r => r.studentId === studentId).map(r => ({ direction: r.direction, stopName: r.stopName }))));
  // (3) 형제할인: 같은 학부모의 «이번 달 청구 대상 반이 있는» 자녀가 2명 이상이면 대상.
  const siblingStudents = siblingDiscountStudents(billable.map(e => ({ studentId: e.studentId, parentId: e.parentId ?? null, birthDate: e.birthDate ?? null, name: e.studentName })));
  const rows: WorkbenchRow[] = enrollments.map(e => {
    const id = `${e.studentId}:${e.classId}`, saved = drafts.find(d => d.id === id);
    const { register, reg, allScheduledDates, classReg, startsOn, futurePeriod, excluded } = scopes.get(id)!;
    const basis: string[] = [], reviewReasons: string[] = [], blockingReasons: string[] = [];
    // 부상 결석 복귀 정산의 «낸 돈이 없는 달» 안내(guideStateOf): 빠진 날의 모양과, 정산 «전»에 저장된 초안인지.
    // 정산 전 초안이면 «수강 기간·기간 조정·이월»만 저장값 대신 제안값을 기본으로 쓴다(수강료·할인은 저장값 유지).
    // 달 가운데만 빠진 달도 같다 — 수강 기간은 그대로 두고 기간 조정만 빠진 횟수만큼 넣는다(전부 빠진 달과 같은 방식).
    // 다닌 횟수는 «개시일 이후 수업일» 중 빠지지 않은 날만 센다 — 월중 등록 달과 안내가 겹치면 개시일 전 회차까지 다닌 것으로 세어 더 청구하게 된다
    const enrolledScheduledDates = enrolledDates(allScheduledDates, startsOn);
    const preStartSessions = allScheduledDates.length - enrolledScheduledDates.length;
    const { guided, overrides: guideOverridesSaved, timeUnknown: guideTimeUnknown } = guideStateOf(e.studentId, e.classId, enrolledScheduledDates, excluded || Boolean(classReg), saved);
    const savedPeriodStart = guideOverridesSaved ? null : saved?.periodStart;
    const savedPeriodEnd = guideOverridesSaved ? null : saved?.periodEnd;
    const proposedStart=savedPeriodStart??(guided?.shape==="PREFIX"?guided.periodStart:null)??classReg?.periodStart??allScheduledDates[0]??null;
    const periodStart=futurePeriod ? null : startsOn && proposedStart && startsOn > proposedStart ? startsOn : proposedStart;
    const periodEnd=futurePeriod ? null : savedPeriodEnd??(guided?.shape==="SUFFIX"?guided.periodEnd:null)??classReg?.periodEnd??allScheduledDates.at(-1)??null;
    // 달 가운데만 빠진 달은 수강 기간으로 빠진 날을 나타낼 수 없다 — 수업일 목록에서 빠진 날을 직접 뺀다(다닌 날만 남긴다).
    // 이 목록이 발행 근거의 수업일 사본이 된다: 나중에 이 달이 이월 근거가 될 때 한 번 값 = 청구 금액 ÷ «다닌 횟수»가 맞게 나온다.
    const guideMissedDates = guided?.shape === "MIDDLE" ? guided.missedDates : [];
    const scheduledDates=(periodStart&&periodEnd&&periodStart<=periodEnd?filterWorkbenchDates(allScheduledDates,periodStart,periodEnd):[]).filter(date=>!guideMissedDates.includes(date));
    let amounts: WorkbenchAmounts = { baseAmount: excluded ? 0 : e.price, discountAmount: 0, prorationAmount: 0, carryAmount: 0, shuttleAmount: 0 };
    // 부상 결석 제외로 제안한 기간 조정 금액(자동 제안한 경우만 — 저장값과 다르면 아래에서 알린다)
    let guidedProration: number | null = null;
    // 정가는 월 4회 기준. 연간 일정상 그달 전체 수업이 4회 미만이면 모자란 회차만큼 뺀다(설 주간·연휴가 낀 달).
    const monthSessions = allScheduledDates.length;
    const isShortMonth = monthSessions > 0 && monthSessions < STANDARD_MONTHLY_SESSIONS;
    if (classReg) {
      amounts = { ...amounts, baseAmount: classReg.baseAmount, discountAmount: classReg.discountAmount, prorationAmount: classReg.prorationAmount };
      basis.push("확정 월 장부");
      if (classReg.carryAmount > 0) reviewReasons.push("기존 장부 이월액은 원결석·사용 잔액 대조가 필요합니다.");
      if (!assignedShuttle.has(e.studentId) && !excluded) { amounts.shuttleAmount = reg!.shuttleAmount; assignedShuttle.add(e.studentId); }
    } else if (!excluded) {
      basis.push("등록 반의 프로그램 수강료");
      // 같은 프로그램을 주 N회 다니면 주N회 요금을 반 수로 나눈 값(빈 칸이면 기존 방식 + 경고).
      const tuition = tuitionPlans.get(id);
      if (tuition) {
        amounts.baseAmount = tuition.baseAmount;
        if (tuition.basis) basis.push(tuition.basis);
        // 경고는 관리자 저장 뒤 검토 사유가 걸러져도 남도록 근거에도 적는다.
        if (tuition.warning) { reviewReasons.push(tuition.warning); basis.push(`확인: ${tuition.warning}`); }
      }
      // 고정 요금 행(대회준비반 30만 원 묶음·학생별 고정 수강료)은 형제할인·3회 달 차감을 붙이지 않는다(원장 확정 2026-11-09·11-16).
      // 같은 학생의 다른 일반 반 행은 fixedFee 가 아니므로 형제할인을 그대로 받는다.
      // (근거 문구 FIXED_FEE_NOTE 는 tuition.basis 에 이미 들어 있다.)
      // 형제할인 제안: 수강료(기본 금액)에만 10%, 셔틀비 제외. 기간 조정보다 먼저 정해야 3회 달 차감이 할인 후 금액 기준이 된다.
      if (siblingStudents.has(e.studentId) && !tuition?.fixedFee) {
        amounts.discountAmount = siblingDiscountAmount(amounts.baseAmount);
        basis.push(`형제할인 ${REGULAR_SIBLING_DISCOUNT_PERCENT}% 제안 → ${amounts.discountAmount.toLocaleString("ko-KR")}원(셔틀비 제외)`);
      }
      reviewReasons.push(WORKBENCH_GENERIC_REVIEW_REASON);
      if (isShortMonth && !tuition?.fixedFee) {
        amounts.prorationAmount = shortMonthProration(amounts.baseAmount, monthSessions, amounts.discountAmount);
        basis.push(`월 ${STANDARD_MONTHLY_SESSIONS}회 기준 중 ${STANDARD_MONTHLY_SESSIONS - monthSessions}회 적은 달 → ${amounts.prorationAmount.toLocaleString("ko-KR")}원 차감`);
      }
      // 부상 결석 복귀 정산: 낸 돈이 없는 달은 이월이 아니라 «다닌 횟수만큼만 청구»(원장 결정 2026-11-15).
      // 한 번 값 = (할인 후 금액 − 3회 달 차감) ÷ 그 달 수업 횟수 — 낸 달의 이월 한 번 값과 같은 단가다.
      if (guided && monthSessions > 0) {
        const missed = guided.missedDates.length, attended = guided.attendedDates.length;
        const proposed = attendedOnlyProration(amounts.baseAmount - amounts.discountAmount, amounts.prorationAmount, monthSessions, attended);
        // 모양과 상관없이 금액은 같은 단가로 자동 제안한다(재검수 필수): 빠진 횟수만큼 뺀다.
        // 수강 기간은 앞쪽·뒤쪽이 빠졌을 때만 좁힌다 — 전부 빠진 달·가운데만 빠진 달은 기간으로 나타낼 수 없어 그대로 둔다.
        amounts.prorationAmount = proposed; guidedProration = proposed;
        basis.push(guided.shape === "WHOLE"
          ? `부상 결석 ${missed}회 제외(다닌 수업 없음) → 기간 조정 ${proposed.toLocaleString("ko-KR")}원 제안(청구 0원)`
          : guided.shape === "MIDDLE"
            ? `부상 결석 ${missed}회(${guided.missedDates.join(", ")}) 제외 → 기간 조정 ${proposed.toLocaleString("ko-KR")}원 제안(다닌 ${attended}회 · 달 가운데가 빠져 수강 기간은 그대로)`
            : `부상 결석 ${missed}회 제외 → 기간 조정 ${proposed.toLocaleString("ko-KR")}원 제안(다닌 ${attended}회 · 수강 ${guided.periodStart}~${guided.periodEnd})`);
        // 월중 등록 달: 개시일 전 회차도 다닌 횟수에 들지 않아 위 기간 조정에 함께 들어 있다
        if (preStartSessions > 0) basis.push(`수강 개시일 전 ${preStartSessions}회도 다닌 횟수에서 빼 기간 조정에 넣었어요`);
      }
    }
    // 고정 수강료를 자동 적용하지 않았거나 일부만 적용한 학생 — 원장이 직접 확인하도록 검토 사유(근거에도 남긴다)
    const fixedNote = excluded ? undefined : fixedNotes.get(e.studentId);
    if (fixedNote) { reviewReasons.push(fixedNote); basis.push(`확인: ${fixedNote}`); }
    if (startsOn) basis.push(`수강 개시일 ${startsOn}`);
    if (startsOn && !excluded && scheduledDates.length < allScheduledDates.length) reviewReasons.push("개시일 이후 실제 수업 횟수에 맞는 기간 조정 금액을 확인해 주세요.");
    if (startsOn && !guideOverridesSaved && saved?.scheduledDates?.some(day => day < startsOn)) blockingReasons.push("저장된 청구 기간에 수강 개시일 전 수업이 포함되어 있습니다. 기간과 금액을 다시 검토해 주세요.");
    if (!scheduledDates.length && !excluded) blockingReasons.push("연간 일정의 실제 수업일이 없어 확정·발행할 수 없습니다.");
    if (register && !reg) reviewReasons.push("확정 월 장부의 근거가 올바르지 않습니다.");
    if (scheduledDates.length) basis.push(`연간 일정 ${scheduledDates.length}회`);
    const existing = payments.filter(p => p.studentId === e.studentId && p.status !== "CANCELED" && p.status !== "CANCELLED" && (p.classId === e.classId || p.classId === null) && p.type !== "UNIFORM");
    const completed = Boolean(saved && ["ISSUED", "ZERO"].includes(saved.status));
    const participates = !excluded && !completed && !existing.length;
    const balance = available(e.studentId);
    const remaining = Math.max(0, balance - (assignedCarry.get(e.studentId) ?? 0));
    amounts.carryAmount = !participates ? 0 : Math.min(remaining, Math.max(0, amounts.baseAmount - amounts.discountAmount - amounts.prorationAmount));
    // 셔틀비 제안: 확정 장부가 없는 학생의 «첫 번째 발행 대상 반» 한 행에만(학생당 한 청구 규칙).
    // 사람이 저장한 값은 아래 saved 덮어쓰기로 우선한다. 다른 반 초안에 셔틀비를 이미 저장했거나
    // 이번 달 기존 청구(랠리즈 사본 등)가 있으면 셔틀비가 이미 들어갔을 수 있어 제안하지 않는다.
    // 학생 단위로 확정 장부(reg)가 있으면 장부 셔틀비만 쓴다 — 장부 확정 뒤 추가된 반이 정렬상 앞에 와도
    // 새 셔틀비를 제안하지 않고, 장부 반 행이 장부 셔틀비를 그대로 받게 한다.
    // 부상 결석으로 한 번도 다니지 않은 달(WHOLE)은 셔틀도 타지 않았다 — 이 행에는 셔틀비를 제안하지 않는다(PM 결정 2026-11-15).
    // 학생의 «셔틀비 자리»도 차지하지 않아, 같은 달에 다닌 다른 반 행이 있으면 그 행이 셔틀비를 받는다.
    const wholeAbsent = guided?.shape === "WHOLE";
    if (wholeAbsent && !reg && participates && (shuttlePlans.get(e.studentId)?.amount ?? 0) > 0) basis.push("부상 결석으로 다닌 수업이 없어 이 행에는 셔틀비를 제안하지 않았어요");
    if (!reg && participates && !assignedShuttle.has(e.studentId) && !wholeAbsent) {
      assignedShuttle.add(e.studentId);
      const plan = shuttlePlans.get(e.studentId);
      const savedElsewhere = drafts.some(d => {
        if (d.studentId !== e.studentId || d.id === id || !((d.payload?.shuttleAmount ?? 0) > 0)) return false;
        // 그 초안이 «정산 전에 저장된, 전부 빠진 달» 행이면 그 셔틀비는 0원으로 덮인다 — 셔틀비가 이미 들어간 것으로 세지 않는다(다닌 반 행이 제안을 받게)
        const other = scopes.get(d.id);
        if (!other) return true;
        const state = guideStateOf(d.studentId, d.classId, enrolledDates(other.allScheduledDates, other.startsOn), other.excluded || Boolean(other.classReg), d);
        return !(state.overrides && state.guided?.shape === "WHOLE");
      });
      const billedThisMonth = payments.some(p => p.studentId === e.studentId && !["CANCELED", "CANCELLED"].includes(p.status) && p.type !== "UNIFORM");
      if (plan && plan.amount > 0 && !savedElsewhere && !billedThisMonth) { amounts.shuttleAmount = plan.amount; if (plan.basis) basis.push(plan.basis); }
      else if (plan && plan.amount > 0) {
        // 명단에는 있는데 제안을 건너뛴 경우 — 셔틀비 누락·중복을 사람이 확인하도록 검토 사유에도 남긴다.
        const note = "셔틀 명단 있음 · 다른 청구에 셔틀비가 있을 수 있어 제안하지 않음";
        basis.push(note);
        reviewReasons.push(`${note}. 셔틀비가 빠지거나 두 번 들어가지 않았는지 확인해 주세요.`);
      }
      else if (plan?.basis) basis.push(plan.basis);
      if (plan?.warning) { reviewReasons.push(plan.warning); basis.push(`확인: ${plan.warning}`); }
      // 일부만 빠진 달의 셔틀비는 자동으로 줄이지 않는다 — 근거에 한 줄 남겨 원장이 판단하게 한다
      if (guided && amounts.shuttleAmount > 0) basis.push("셔틀비는 그대로예요 · 필요하면 조정");
    }
    if (saved && !["ISSUED", "ZERO"].includes(saved.status)) {
      // 저장값은 그대로 쓰되, 장부 없는 청구 대상 반이면 «새 요금 기준 자동 제안»과 다른 칸을 알린다
      // (요금 규칙이 바뀌기 전에 저장한 초안이 옛 금액으로 발행되는 일을 막기 위한 확인 신호).
      if (!classReg && !excluded) {
        const labels = { baseAmount: "수강료", discountAmount: "할인", shuttleAmount: "셔틀비" } as const;
        for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
          const proposed = amounts[key], stored = saved.payload?.[key] ?? 0;
          if (proposed === stored) continue;
          const note = `${labels[key]}: 새 요금 기준 제안 ${proposed.toLocaleString("ko-KR")}원과 다릅니다(저장값 ${stored.toLocaleString("ko-KR")}원)`;
          // 검토 사유에만 넣는다 — 원본이 바뀐(옛 기준으로 저장된) 초안에서 보이고, 같은 원본으로 다시 저장하면
          // 사람이 확인한 값으로 보고 걸러진다(의도한 별도 할인·셔틀 무료가 근거에 영구 경고로 남지 않게).
          reviewReasons.push(note);
        }
        // 정산 안내가 없는 행: 저장값이 우선한다. 다만 부상 결석 이월을 쓸 수 있는데 저장값이 더 적으면 알린다(다시 저장하면 사람이 확인한 값으로 본다).
        if (!guideOverridesSaved && amounts.carryAmount > (saved.payload?.carryAmount ?? 0) && credits.some(c => c.studentId === e.studentId && c.valid !== false && typeof c.basis?.periodId === "string")) {
          reviewReasons.push(`이월: 부상 결석 이월 ${amounts.carryAmount.toLocaleString("ko-KR")}원을 쓸 수 있습니다(저장값 ${(saved.payload?.carryAmount ?? 0).toLocaleString("ko-KR")}원). 이월 칸을 확인해 주세요.`);
        }
      }
      if (guideOverridesSaved && guided) {
        // 정산 «전»에 저장된 초안 + 낸 돈이 없는 달 안내: 수강료·할인은 저장값, 기간 조정·이월(·전부 빠진 달의 셔틀비)은 제안값을 기본으로.
        // 기간 조정은 «저장된» 수강료·할인으로 다시 계산한다(제안 금액과 저장 금액이 다를 수 있다). 3회 달 차감도 같은 기준.
        // 다닌 횟수가 «개시일 이후 · 빠지지 않은 날»이라, 옛 초안에 들어 있던 개시일 조정분(개시일 전 회차)과 부상 결석 안내분이 한 금액에 합쳐진다.
        const stored = saved.payload;
        const fixedFee = Boolean(tuitionPlans.get(id)?.fixedFee);
        const net = stored.baseAmount - stored.discountAmount;
        const short = isShortMonth && !fixedFee ? shortMonthProration(stored.baseAmount, monthSessions, stored.discountAmount) : 0;
        const proration = attendedOnlyProration(net, short, monthSessions, guided.attendedDates.length);
        const carry = Math.min(remaining, Math.max(0, net - proration));
        const shuttle = wholeAbsent ? 0 : stored.shuttleAmount;
        // 실제로 달라진 것이 있을 때만 알린다(저장값이 이미 제안과 같으면 «바꿨습니다»라고 하지 않는다)
        const changed = proration !== stored.prorationAmount || carry !== stored.carryAmount || shuttle !== stored.shuttleAmount
          || (saved.periodStart ?? null) !== periodStart || (saved.periodEnd ?? null) !== periodEnd;
        if (changed) {
          const note = `부상 결석 정산 뒤라 저장해 둔 금액 대신 제안값으로 바꿨습니다 — 기간 조정 ${proration.toLocaleString("ko-KR")}원(저장값 ${stored.prorationAmount.toLocaleString("ko-KR")}원)·이월 ${carry.toLocaleString("ko-KR")}원(저장값 ${stored.carryAmount.toLocaleString("ko-KR")}원)${shuttle !== stored.shuttleAmount ? `·셔틀비 0원(저장값 ${stored.shuttleAmount.toLocaleString("ko-KR")}원)` : ""}. 확인하고 다시 저장해 주세요.`;
          reviewReasons.push(note); basis.push(`확인: ${note}`);
        }
        amounts = { ...stored, prorationAmount: proration, carryAmount: carry, shuttleAmount: shuttle };
        guidedProration = proration;
      } else amounts = saved.payload;
    }
    if (saved && ["ISSUED", "ZERO"].includes(saved.status)) amounts = saved.payload;
    // 3회 달을 그달 전체로 청구하는데 기간 조정이 할인 후 금액 기준과 다르면 알린다(장부·저장 초안 포함).
    // 기간을 좁힌 경우(일부 수강)는 관리자가 직접 계산한 값이라 비교하지 않는다.
    // (부상 결석 제외로 «청구 0원»을 제안한 행은 기간 조정이 전액이라 3회 달 기준과 다른 것이 정상 — 비교하지 않는다)
    if (isShortMonth && participates && scheduledDates.length === monthSessions && guidedProration === null) {
      // 고정 요금 행(대회준비반·학생별 고정 수강료)은 3회 달 차감이 없으므로 기대값 0(장부 확정 행은 제안이 없어 일반 기준).
      const fixed = !classReg && !excluded && Boolean(tuitionPlans.get(id)?.fixedFee);
      const expected = fixed ? 0 : shortMonthProration(amounts.baseAmount, monthSessions, amounts.discountAmount);
      if (amounts.prorationAmount !== expected) {
        const note = fixed
          ? `${fixedApplied.has(e.studentId) ? "고정 수강료" : "대회준비반 요금"}는 3회 달 차감이 없습니다(현재 기간 조정 ${amounts.prorationAmount.toLocaleString("ko-KR")}원).`
          : `연간 일정 ${monthSessions}회인 달은 기간 조정이 할인 후 금액 기준 ${expected.toLocaleString("ko-KR")}원이어야 합니다(현재 ${amounts.prorationAmount.toLocaleString("ko-KR")}원).`;
        reviewReasons.push(note);
        basis.push(`확인: ${note}`); // 관리자 저장 뒤 검토 사유가 걸러져도 근거에는 남긴다
      }
    }
    if(participates) assignedCarry.set(e.studentId, (assignedCarry.get(e.studentId) ?? 0) + amounts.carryAmount);
    // 발행 보류: 이번에 새로 발행될 수 있는 행(제외·이미 발행·기존 청구 있음이 아닌 행)만 막는다.
    // 차단 사유 맨 앞에 넣어, 확정·발행을 요청하면 이 글자로 거절된다(mutateWorkbench 가 첫 차단 사유를 돌려준다).
    const holdPeriodId = participates ? holdPeriodFor(e.studentId, e.classId) : undefined;
    // 고정 수강료가 이 행의 제안값을 정했는가(확정 장부가 없고 청구 대상인 행만)
    const fixedOfStudent = fixedApplied.get(e.studentId);
    const fixedLabel = fixedOfStudent && !classReg && !excluded ? fixedTuitionShortLabel(fixedOfStudent.amount) : null;
    if (holdPeriodId) blockingReasons.unshift(BILLING_HOLD_LABEL);
    // 부상 결석 안내는 있는데 그 기간의 확정 시각을 읽지 못했다 — 저장해 둔 금액이 정산 전 것인지 뒤 것인지 가릴 수 없어 발행을 막는다
    if (guideTimeUnknown && participates) blockingReasons.push(GUIDE_TIME_UNKNOWN_REASON);
    // 반 이동 경고(차단 아님): 그 아이에게 보류 중인 기간이 있는데 대상 반이 따로 정해져 있고, 그 대상 반을 지금은 하나도 다니지 않는다
    // = 결석 중에 반을 옮겼다. 새 반 청구는 보류되지 않으므로 원장이 한 번 보게 한다.
    if (!holdPeriodId && participates && illnessHolds.some(held => held.studentId === e.studentId && Array.isArray(held.classIds) && held.classIds.length > 0
      && !held.classIds.some(classId => enrollments.some(other => other.studentId === e.studentId && other.classId === classId && other.status === "ACTIVE")))) {
      reviewReasons.push(BILLING_HOLD_MOVED_NOTE);
    }
    if(credits.some(c=>c.studentId===e.studentId && c.valid===false)) blockingReasons.push("원결석 취소·출석 정정된 이월이 있습니다. 정산을 확인해 주세요.");
    if(usages.some(u=>u.studentId===e.studentId && (["CANCELED","CANCELLED","REFUNDED"].includes(u.paymentStatus??"") || ["CANCELED","CANCELLED","REFUNDED"].includes(u.invoiceStatus??"") || (u.paymentId && (!u.paymentStatus || !u.invoiceStatus))))) blockingReasons.push("이월 사용 청구의 취소·환불 내역을 재정산해야 합니다.");
    if(seasonalCredits.some(c=>c.studentId===e.studentId)) blockingReasons.push("기존 특강 이월액은 원결석·사용액 대조 후 옮겨야 합니다. 중복 차감을 막기 위해 보류합니다.");
    if(pool(e.studentId).unresolved) blockingReasons.push("기존 이월 사용분에 원적립 연결이 없어 정산 확인이 필요합니다.");
    if (existing.length) reviewReasons.push("이미 청구·납부된 내역이 있어 새 발행에서 제외합니다.");
    if (saved && saved.sourceVersion !== sourceVersion && !["ISSUED", "ZERO"].includes(saved.status)) reviewReasons.push(WORKBENCH_SOURCE_CHANGED_REASON);
    if (saved && saved.sourceVersion === sourceVersion) {
      const structural = reviewReasons.filter(r => r.startsWith("이미") || r.startsWith("확정 월"));
      reviewReasons.splice(0, reviewReasons.length, ...structural);
      basis.push(`관리자 검토: ${saved.reason}`);
    }
    reviewReasons.push(...blockingReasons);
    return { ...amounts, id, studentId: e.studentId, studentName: e.studentName, classId: e.classId, className: e.className,
      status: completed || existing.length ? "ISSUED" : excluded ? "EXCLUDED" : reviewReasons.length ? "REVIEW" : "READY",
      totalAmount: workbenchTotal(amounts), reviewReasons, basis, version: saved?.version ?? 0, draftStatus: saved?.status ?? null,
      paymentId: saved?.paymentId ?? existing[0]?.id ?? null, periodStart,
      periodEnd, scheduledDates, monthDates: allScheduledDates, carryAvailable: balance, remainingCarry: Math.max(0, balance - (assignedCarry.get(e.studentId) ?? 0)), dueDate: monthlyBillingDueDate(year,monthNumber), blockingReasons,
      // 보류 행에만 붙인다 — 보류가 아닌 행의 모양은 예전과 완전히 같다
      ...(holdPeriodId ? { hold: true as const, holdPeriodId } : {}),
      // 달 가운데가 빠진 행에만 붙인다 — 저장할 때 수업일 사본에서 이 날들을 빼고, 근거에 따로 적어 둔다
      ...(guideMissedDates.length ? { guideMissedDates } : {}),
      // 학생별 고정 수강료가 적용된 행에만 붙인다 — 화면이 «고정 15만»처럼 근거를 보인다(확정 장부·제외 행은 고정 금액을 쓰지 않으므로 없음)
      ...(fixedLabel ? { fixedTuitionLabel: fixedLabel } : {}),
      // 청구일 cron 이 저장한 초안이고 사람이 아직 다시 저장하지 않았으면 «자동 초안(원장 확인 전)»으로 구분한다(2026-11-17)
      ...(saved?.status === "DRAFT" && saved.actorUserId === AUTO_DRAFT_ACTOR ? { autoDraft: true as const } : {}) };
  });
  return { month, sourceVersion, storageReady, writesEnabled: writesEnabled && storageReady, rows,carrySettlementReady:true,calendarSource,
    // 그 달 셔틀 명단이 하나도 없으면(아래 안내와 같은 조건) 표시 — 자동 초안·한꺼번에 발행을 막는다(검수 B-1, 2026-11-17). 있으면 칸이 없다
    ...(!shuttleStops.length ? { shuttleRosterMissing: true as const } : {}),
    notices:[...seasonalCredits.length?[`기존 특강 이월 ${seasonalCredits.length}건은 별도 대조·이관이 필요합니다. 자동 중복 적립하지 않습니다.`]:[],
      // 셔틀비 제안의 근거가 되는 명단 상태를 알린다(명단이 없거나 학생 연결이 빠지면 셔틀비가 0원으로 시작한다).
      ...!shuttleStops.length?[`${month} 셔틀 명단이 없어 셔틀비를 자동 제안하지 않았습니다.`]:[],
      ...unlinkedShuttleNames.length?[`셔틀 명단에서 학생과 연결되지 않은 ${unlinkedShuttleNames.length}명(${unlinkedShuttleNames.slice(0,5).join(", ")}${unlinkedShuttleNames.length>5?" 외":""})은 셔틀비를 자동 제안하지 않았습니다.`]:[]],
    absences: absences.map(a => ({ ...a, ...(carryPeriodOf.has(a.id) ? { carryPeriodId: carryPeriodOf.get(a.id) } : {}), reviewReasons: a.resolution ? [] : [a.status !== "CONFIRMED" ? "결석 확인 필요" : "이월·보강 중 하나를 선택해 주세요.", ...a.makeupStatus?.split(",").some(s => ["USED", "ATTENDED", "NO_SHOW"].includes(s)) ? ["보강 사용 내역이 있어 자동 이월할 수 없습니다."] : []] })),
    // 발행 보류 행은 «확인 필요» 수와 발행 예정 합계에서 뺀다 — 원장이 지금 처리할 일이 아니고(복귀 정산 뒤), 화면의 «발행 보류 n»과 겹치지 않게
    summary: { total: rows.length, ready: rows.filter(r => r.status === "READY").length, review: rows.filter(r => r.status === "REVIEW" && !r.hold).length,
      excluded: rows.filter(r => r.status === "EXCLUDED").length, issued: rows.filter(r => r.status === "ISSUED").length,
      totalAmount: rows.filter(r => !["EXCLUDED", "ISSUED"].includes(r.status) && !r.hold).reduce((s, r) => s + r.totalAmount, 0) } };
}

/** 저장·확정·발행은 하나의 거래로 처리하며 외부 발송은 하지 않는다. */
export async function mutateWorkbench(db: WorkbenchDb, input: unknown, actorId: string, writesEnabled = false,calendar?:WorkbenchCalendarSnapshot) {
  if (!writesEnabled) throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const command = validateWorkbenchCommand(input), fingerprint = hash(command);
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))`);
    const old = await tx.$queryRawUnsafe<Array<{ fingerprint: string; result: WorkbenchOperation }>>(`SELECT fingerprint,result FROM "BillingWorkbenchOperation" WHERE "requestId"=$1`, command.requestId);
    if (old[0]) {
      if (old[0].fingerprint !== fingerprint) throw new WorkbenchError("동일 요청 번호에 다른 내용이 있습니다.", 409);
      return { view: await readWorkbench(tx, command.month, writesEnabled,calendar), operationResult: old[0].result };
    }
    let view = await readWorkbench(tx, command.month, writesEnabled,calendar);
    if (!view.storageReady) throw new WorkbenchError("청구 준비 저장 구조를 먼저 확인해 주세요.", 503);
    if (view.sourceVersion !== command.sourceVersion) throw new WorkbenchError("수강·출결·청구 자료가 변경됐습니다. 다시 조회해 주세요.", 409,true);
    const selected = command.rows.map(edit => {
      const row = view.rows.find(r => r.id === edit.id);
      if (!row || row.version !== edit.expectedVersion) throw new WorkbenchError("다른 작업에서 변경한 청구가 있습니다. 다시 조회해 주세요.", 409,true);
      if (["EXCLUDED", "ISSUED"].includes(row.status)) throw new WorkbenchError("제외 또는 이미 발행된 청구는 변경할 수 없습니다.", 409);
      if(command.action!=="SAVE" && row.blockingReasons.length) throw new WorkbenchError(row.blockingReasons[0],409);
      return { row, edit };
    });
    const studentIds = [...new Set(selected.map(s => s.row.studentId))].sort();
    const lockedStudents=await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT s.id FROM "Student" s WHERE s.id=ANY($1::text[]) AND ${notMergedStudent("s")} ORDER BY s.id FOR UPDATE`, studentIds);
    if(lockedStudents.length!==studentIds.length)throw new WorkbenchError("통합되거나 변경된 학생이 있습니다. 현재 학생으로 다시 조회해 주세요.",409,true);
    const operationResult: WorkbenchOperation = { requestId: command.requestId, action: command.action, rowIds: selected.map(s => s.row.id), paymentIds: [], zeroCount: 0 };
    const allAmounts = new Map(view.rows.filter(r => !["EXCLUDED", "ISSUED"].includes(r.status)).map(r => [r.id, amountFields(r)]));
    if (command.action === "SAVE") for (const { row, edit } of selected) allAmounts.set(row.id, amountFields(edit as WorkbenchAmounts));
    for (const studentId of studentIds) {
      const rows = view.rows.filter(r => r.studentId === studentId && allAmounts.has(r.id));
      const carry = rows.reduce((s, r) => s + allAmounts.get(r.id)!.carryAmount, 0);
      if (carry > (rows[0]?.carryAvailable ?? 0)) throw new WorkbenchError("이월 잔액을 초과하거나 여러 반에 중복 차감했습니다.", 409);
      const issuedShuttles = view.rows.filter(r=>r.studentId===studentId && r.status === "ISSUED" && r.shuttleAmount>0).length;
      if (issuedShuttles + rows.filter(r => allAmounts.get(r.id)!.shuttleAmount > 0).length > 1) throw new WorkbenchError("셔틀비는 학생당 한 청구에만 포함해 주세요.", 409);
      if (rows.some(r=>allAmounts.get(r.id)!.shuttleAmount>0)) {
        const oldShuttle = await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM "Payment" WHERE "studentId"=$1 AND year=$2 AND month=$3 AND type='SHUTTLE' AND status NOT IN ('CANCELED','CANCELLED')`, studentId,...command.month.split("-").map(Number));
        if(oldShuttle.length) throw new WorkbenchError("이미 별도 셔틀비 청구가 있습니다. 중복 부과 여부를 확인해 주세요.",409);
      }
    }
    for (const { row, edit } of selected) {
      const stored = (await tx.$queryRawUnsafe<Stored[]>(`SELECT * FROM "BillingWorkbenchDraft" WHERE id=$1 AND month=$2 FOR UPDATE`, row.id, command.month))[0];
      if (command.action !== "SAVE" && (!stored || stored.sourceVersion !== view.sourceVersion || (command.action === "CONFIRM" ? stored.status !== "DRAFT" : stored.status !== "CONFIRMED"))) throw new WorkbenchError("최신 자료로 저장·확정한 청구만 처리할 수 있습니다.", 409,true);
      const payload = command.action === "SAVE" ? amountFields(edit as WorkbenchAmounts) : stored.payload;
      if(command.action==="SAVE" && payload.prorationAmount>0 && (!edit.periodStart||!edit.periodEnd) && !stored?.periodStart)throw new WorkbenchError("기간 조정액에는 실제 수강 시작일·종료일을 함께 확인해 주세요.",409);
      // 달 가운데가 빠진 달(부상 결석 안내): 수업일 사본에는 다닌 날만 남긴다 — 화면 행(row.scheduledDates)과 같은 목록이어야 확정·발행이 통과한다
      const guideMissed=command.action==="SAVE"?(row.guideMissedDates??[]):[];
      const scheduleRead=command.action==="SAVE"?await readWorkbenchSchedule(tx,command.month,row.classId,edit.periodStart??row.periodStart,edit.periodEnd??row.periodEnd,calendar):null;
      const savedMissed=scheduleRead?scheduleRead.scheduledDates.filter(date=>guideMissed.includes(date)):[];
      const snapshot=scheduleRead?{...scheduleRead,scheduledDates:scheduleRead.scheduledDates.filter(date=>!guideMissed.includes(date))}:{periodStart:stored.periodStart??null,periodEnd:stored.periodEnd??null,scheduledDates:stored.scheduledDates??[]};
      if(command.action!=="SAVE" && (!snapshot.scheduledDates.length || JSON.stringify(snapshot.scheduledDates)!==JSON.stringify(row.scheduledDates)))throw new WorkbenchError("저장한 실제 수강일과 현재 일정이 다릅니다. 기간을 다시 검토해 주세요.",409,true);
      if(command.action==="SAVE" && (edit.periodStart||edit.periodEnd) && !snapshot.scheduledDates.length)throw new WorkbenchError("선택한 수강 기간에 예정 수업이 없습니다.",409);
      const calculationBasis=command.action==="SAVE"?{source:calendar?.kind??"DB",calendarFingerprint:calendar?.fingerprint??null,...snapshot,sourceVersion:view.sourceVersion,discountedTuition:payload.baseAmount-payload.discountAmount-payload.prorationAmount,reviewReason:edit.reason!.trim(),...(savedMissed.length?{illnessMissedDates:savedMissed}:{})}:stored.calculationBasis??{};
      let status: Stored["status"] = command.action === "SAVE" ? "DRAFT" : "CONFIRMED", paymentId: string | null = null;
      if (command.action === "ISSUE") {
        const total = workbenchTotal(payload);
        if (total === 0) { status = "ZERO"; operationResult.zeroCount++; }
        else {
          paymentId = randomUUID(); const invoiceId = randomUUID(), invoiceNo = `STIZ-${command.month.replace("-", "")}-${paymentId.replaceAll("-", "")}`;
          const [year, month] = command.month.split("-").map(Number);
          const title = `${command.month} ${row.className} 수강료`;
          const description = `${title} · 수강료 ${payload.baseAmount} · 할인 ${payload.discountAmount} · 기간조정 ${payload.prorationAmount} · 이월 ${payload.carryAmount} · 셔틀 ${payload.shuttleAmount}`;
          await tx.$executeRawUnsafe(`INSERT INTO "Payment" (id,"studentId","classId",amount,status,"dueDate",type,description,year,month,"invoiceNo","issuedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,'PENDING',$5::timestamp,'MONTHLY',$6,$7,$8,$9,NOW(),NOW(),NOW())`, paymentId,row.studentId,row.classId,total,row.dueDate,description,year,month,invoiceNo);
          const invoiceCount=await tx.$executeRawUnsafe(`INSERT INTO "PaymentInvoice" (id,"paymentId","studentId","classId","parentId","invoiceNo",status,amount,title,description,"dueDate","issuedAt","createdAt","updatedAt") SELECT $1,$2,s.id,$3,s."parentId",$4,'ISSUED',$5,$6,$7,$8::timestamp,NOW(),NOW(),NOW() FROM "Student" s WHERE s.id=$9 AND ${notMergedStudent("s")}`, invoiceId,paymentId,row.classId,invoiceNo,total,title,description,row.dueDate,row.studentId);
          if(invoiceCount!==1)throw new WorkbenchError("현재 학생으로 청구서를 만들지 못했습니다. 다시 조회해 주세요.",409,true);
          operationResult.paymentIds.push(paymentId); status = "ISSUED";
        }
        if (payload.carryAmount > 0) {
          const sourceCredits=await tx.$queryRawUnsafe<Credit[]>(`SELECT id,numerator::text,denominator::text,"availableMonth" FROM "BillingCarryCredit" WHERE "studentId"=$1 ORDER BY "availableMonth",id FOR UPDATE`,row.studentId);
          const previousUsage=await tx.$queryRawUnsafe<Usage[]>(`SELECT amount,basis,"sourceCreditIds" FROM "BillingCarryUsage" WHERE "studentId"=$1 ORDER BY id FOR UPDATE`,row.studentId);
          const allocation=allocateCarry(sourceCredits,previousUsage,command.month,payload.carryAmount);
          await tx.$executeRawUnsafe(`INSERT INTO "BillingCarryUsage" (id,"studentId",month,"draftId",amount,"paymentId","actorUserId","sourceCreditIds",basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb)`, randomUUID(),row.studentId,command.month,row.id,payload.carryAmount,paymentId,actorId,allocation.sourceCreditIds,JSON.stringify(allocation.basis));
        }
      }
      const reason = command.action === "SAVE" ? edit.reason!.trim() : stored.reason;
      await tx.$executeRawUnsafe(`INSERT INTO "BillingWorkbenchDraft" (id,month,"studentId","classId",version,status,payload,reason,"sourceVersion","paymentId","actorUserId","periodStart","periodEnd","scheduledDates","calculationBasis","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,NOW())
        ON CONFLICT (id,month) DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status,payload=EXCLUDED.payload,reason=EXCLUDED.reason,"sourceVersion"=EXCLUDED."sourceVersion","paymentId"=EXCLUDED."paymentId","actorUserId"=EXCLUDED."actorUserId","periodStart"=EXCLUDED."periodStart","periodEnd"=EXCLUDED."periodEnd","scheduledDates"=EXCLUDED."scheduledDates","calculationBasis"=EXCLUDED."calculationBasis","updatedAt"=NOW()`, row.id,command.month,row.studentId,row.classId,row.version+1,status,JSON.stringify(payload),reason,view.sourceVersion,paymentId,actorId,snapshot.periodStart,snapshot.periodEnd,JSON.stringify(snapshot.scheduledDates),JSON.stringify(calculationBasis));
      await tx.$executeRawUnsafe(`INSERT INTO "BillingWorkbenchRevision" (id,"draftId",month,version,action,payload,reason,"actorUserId") VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,randomUUID(),row.id,command.month,row.version+1,command.action,JSON.stringify({...payload,...snapshot,calculationBasis}),reason,actorId);
    }
    await tx.$executeRawUnsafe(`INSERT INTO "BillingWorkbenchOperation" ("requestId",fingerprint,result,"actorUserId") VALUES ($1,$2,$3::jsonb,$4)`, command.requestId,fingerprint,JSON.stringify(operationResult),actorId);
    view = await readWorkbench(tx, command.month, writesEnabled,calendar);
    return { view, operationResult };
  }, { isolationLevel: "Serializable", timeout: 30_000 });
}
