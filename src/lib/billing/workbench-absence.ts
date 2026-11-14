import { createHash, randomUUID } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { validateMonthlyRegisterDraft } from "./monthly-register";
import { WorkbenchError, workbenchTotal, filterWorkbenchDates, type WorkbenchAmounts, type WorkbenchView, type WorkbenchCalendarSnapshot } from "./workbench";
import { readWorkbench, type WorkbenchDb, type WorkbenchTx } from "./workbench-service";
import { resolveMonthEvidence, type PaidPaymentEvidence } from "./carryEvidence";

export type ResolveWorkbenchAbsence = {
  action: "RESOLVE_ABSENCE"; month: string; sourceVersion: string; requestId: string;
  absenceId: string; resolution: "CARRY" | "MAKEUP"; evidenceConfirmed: boolean;
  eligibility: "ILLNESS_INJURY" | "DIRECT_FAMILY_EVENT" | "NONE";
  reason: string; cancelReservation: boolean; originMonth: string;
};
/** 인정 근거와 원기간의 할인 후 금액으로만 이월을 적립한다. 과거 보강권을 새로 발급하지 않는다. */
export async function resolveWorkbenchAbsence(db: WorkbenchDb, input: unknown, actorId: string, enabled = false,calendar?:WorkbenchCalendarSnapshot): Promise<{ view: WorkbenchView; operationResult: { requestId: string; action: string; rowIds: string[]; paymentIds: string[]; zeroCount: number } }> {
  if (!enabled) throw new WorkbenchError("결석 정산 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorId) throw new WorkbenchError("관리자 확인이 필요합니다.", 403);
  const b = input as ResolveWorkbenchAbsence;
  if (!b || b.action !== "RESOLVE_ABSENCE" || typeof b.absenceId !== "string" || !b.absenceId || b.absenceId.length > 200 || typeof b.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(b.requestId) || typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500 || !["CARRY", "MAKEUP"].includes(b.resolution) || !/^(20[2-9]\d|2100)-(0[1-9]|1[0-2])$/.test(b.originMonth)) throw new WorkbenchError("결석 처리 근거를 확인해 주세요.");
  if (Object.keys(b).some(k => !["action", "month", "sourceVersion", "requestId", "absenceId", "resolution", "evidenceConfirmed", "eligibility", "reason", "cancelReservation", "originMonth"].includes(k))) throw new WorkbenchError("허용되지 않은 결석 처리 항목입니다.");
  const fingerprint = createHash("sha256").update(JSON.stringify(b)).digest("hex");
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))`);
    const prior = await tx.$queryRawUnsafe<Array<{ fingerprint: string; result: { requestId: string; action: string; rowIds: string[]; paymentIds: string[]; zeroCount: number } }>>(`SELECT fingerprint,result FROM "BillingWorkbenchOperation" WHERE "requestId"=$1`, b.requestId);
    if (prior[0]) {
      if (prior[0].fingerprint !== fingerprint) throw new WorkbenchError("동일 요청 번호에 다른 내용이 있습니다.",409);
      return { view: await readWorkbench(tx,b.month,enabled,calendar), operationResult: prior[0].result };
    }
    const view = await readWorkbench(tx,b.month,enabled,calendar);
    if (!view.storageReady) throw new WorkbenchError("결석 정산 구조를 확인해 주세요.",503);
    if (view.sourceVersion !== b.sourceVersion) throw new WorkbenchError("결석·보강 자료가 변경됐습니다. 다시 조회해 주세요.",409,true);
    const absence = view.absences.find(a => a.id === b.absenceId);
    if (!absence || absence.status !== "CONFIRMED" || absence.resolution) throw new WorkbenchError("확인된 미처리 결석만 처리할 수 있습니다.",409);
    // 부상·질병 «기간 결석»을 승인·정산한 기간의 결석은 하루씩 처리하지 않는다(2026-11-15) — 기간 정산과 이중으로 적립되는 길을 막는다.
    // 기간 정산 칸(마이그레이션 20261116100000)이 아직 없으면 그대로 통과한다. 문구는 illnessPeriodRules.PERIOD_DAY_RESOLVE_BLOCKED 와 같다(테스트가 비교).
    const periodCarryColumn=await tx.$queryRawUnsafe<Array<{n:number}>>(`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='RegularAbsencePeriod' AND column_name='carryState'`);
    if(Number(periodCarryColumn[0]?.n??0)>0){
      const periodDecided=await tx.$queryRawUnsafe<Array<{found:number}>>(`SELECT 1 AS found FROM "RegularAbsencePeriod" p JOIN "RegularAbsence" a ON a."periodId"=p.id WHERE a.id=$1 AND a.reason='ILLNESS_INJURY' AND p."carryState"<>'NONE' LIMIT 1`,absence.id);
      if(periodDecided.length>0) throw new WorkbenchError("기간 정산에서 한 번에 처리합니다. 신청함의 «부상 결석(기간)»에서 확인해 주세요.",409);
    }
    const today = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul"}).format(new Date());
    if(absence.date>today) throw new WorkbenchError("아직 지나지 않은 수업은 결석 정산할 수 없습니다.",409);
    const lockedStudent=await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT s.id FROM "Student" s WHERE s.id=$1 AND ${notMergedStudent("s")} FOR UPDATE`,absence.studentId);
    if(lockedStudent.length!==1)throw new WorkbenchError("통합되거나 변경된 학생입니다. 현재 학생으로 다시 조회해 주세요.",409,true);
    await tx.$queryRawUnsafe(`SELECT id FROM "RegularAbsence" WHERE id=$1 FOR UPDATE`,absence.id);
    const sourceKey = `REGULAR:${absence.classId}:${absence.date}`;
    const credits = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(`SELECT id,status FROM "MakeupCredit" WHERE "studentId"=$1 AND "sourceKey"=$2 FOR UPDATE`,absence.studentId,sourceKey);
    const bookings = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(`SELECT id,status FROM "MakeupSession" WHERE "studentId"=$1 AND "originalClassId"=$2 AND ("originalDate" AT TIME ZONE 'Asia/Seoul')::date=$3::date FOR UPDATE`,absence.studentId,absence.classId,absence.date);
    if (b.resolution === "CARRY") {
      if (b.evidenceConfirmed !== true || !["ILLNESS_INJURY", "DIRECT_FAMILY_EVENT"].includes(b.eligibility)) throw new WorkbenchError("질병·부상·직계가족 경조사 인정 근거를 확인해 주세요.");
      if (b.eligibility === "ILLNESS_INJURY" && absence.reason !== "ILLNESS_INJURY") throw new WorkbenchError("결석 사유와 인정 분류를 확인해 주세요.",409);
      if (credits.some(c => ["USED","NO_SHOW"].includes(c.status)) || bookings.some(c => ["ATTENDED","NO_SHOW"].includes(c.status))) throw new WorkbenchError("이미 보강에 사용된 결석입니다. 자동 이월하지 않고 별도 확인이 필요합니다.",409);
      if ((credits.some(c => c.status === "RESERVED") || bookings.some(c => c.status === "BOOKED")) && b.cancelReservation !== true) throw new WorkbenchError("보강 예약 취소와 좌석 해제를 확인해 주세요.",409);
      const attendance = await tx.$queryRawUnsafe<Array<{status:string}>>(`SELECT t.status FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" WHERE t."studentId"=$1 AND se."classId"=$2 AND se.date::date=$3::date FOR SHARE OF t,se`,absence.studentId,absence.classId,absence.date);
      if(attendance.some(t=>t.status!=="ABSENT")) throw new WorkbenchError("출결이 결석과 일치하지 않습니다. 출석·지각 정정 내역을 먼저 확인해 주세요.",409);
      await creditCarryForAbsenceInTx(tx,{absence,originMonth:b.originMonth,eligibility:b.eligibility,actorId,calendar});
      await tx.$executeRawUnsafe(`UPDATE "MakeupSession" SET status='CANCELLED',"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status='BOOKED'`,bookings.map(c=>c.id));
      await tx.$executeRawUnsafe(`UPDATE "MakeupCredit" SET status='REVOKED',"makeupSessionId"=NULL,"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status IN ('AVAILABLE','RESERVED','EXPIRED')`,credits.map(c=>c.id));
    } else {
      if (!credits.some(c=>["AVAILABLE","RESERVED","USED","NO_SHOW"].includes(c.status))) throw new WorkbenchError("사용 가능한 기존 보강권을 먼저 확인해 주세요. 과거 결석의 보강권을 소급 발급하지 않습니다. 질병·부상 이월 검토 중인 결석은 신청함의 [보강권으로]를 눌러 주세요.",409);
    }
    await tx.$executeRawUnsafe(`INSERT INTO "BillingAbsenceResolution" ("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,absence.id,absence.studentId,b.resolution,b.reason.trim(),b.evidenceConfirmed===true,b.eligibility,actorId);
    // 질병·부상 «이월 검토»(2026-11-14 원장 결정 a3) — 신청함의 검토 상태를 «같은 트랜잭션»에서 맞춘다.
    // 이월(CARRY) → 이월 승인, 보강(MAKEUP) → 보강권으로 전환. 신청함 승인도 이 함수를 지나므로 규칙은 여기 한 곳이다.
    // 검토 표가 아직 없으면(마이그레이션 전) 건너뛴다. 질병·부상 결석만 적는다(경조사 이월은 신청함 대상이 아니다).
    const reviewTable=await tx.$queryRawUnsafe<Array<{found:string|null}>>(`SELECT to_regclass($1)::text AS found`,'public."RegularAbsenceCarryReview"');
    if(reviewTable[0]?.found) await tx.$executeRawUnsafe(`INSERT INTO "RegularAbsenceCarryReview" ("absenceId",status,source,"decidedAt","decidedBy","decidedByUserId","convertReason") SELECT a.id,$2::text,'STAFF',NOW(),'ADMIN',$3::text,$4::text FROM "RegularAbsence" a WHERE a.id=$1 AND a.reason='ILLNESS_INJURY' ON CONFLICT ("absenceId") DO UPDATE SET status=EXCLUDED.status,"decidedAt"=NOW(),"decidedBy"='ADMIN',"decidedByUserId"=EXCLUDED."decidedByUserId","convertReason"=EXCLUDED."convertReason","updatedAt"=NOW()`,absence.id,b.resolution==="CARRY"?"APPROVED":"MAKEUP",actorId,b.resolution==="CARRY"?null:"REJECTED");
    const operationResult = {requestId:b.requestId,action:b.action,rowIds:[absence.id],paymentIds:[],zeroCount:0};
    await tx.$executeRawUnsafe(`INSERT INTO "BillingWorkbenchOperation" ("requestId",fingerprint,result,"actorUserId") VALUES ($1,$2,$3::jsonb,$4)`,b.requestId,fingerprint,JSON.stringify(operationResult),actorId);
    return {view:await readWorkbench(tx,b.month,enabled,calendar),operationResult};
  },{isolationLevel:"Serializable",timeout:30_000});
}

/** 이월 적립 대상 결석(잠금·자격 확인은 부르는 쪽이 끝낸 뒤 넘긴다) */
export type CarryAbsenceTarget = { id: string; studentId: string; classId: string; date: string; reason: string };
export type CarryEvidenceSource = "WORKBENCH_ISSUED" | "MONTHLY_REGISTER" | "PAID_PAYMENT";
type CarryEvidenceInput = { absence: CarryAbsenceTarget; originMonth: string; calendar?: WorkbenchCalendarSnapshot };
type ResolvedCarryEvidence = { source: CarryEvidenceSource; numerator: number; dates: string[]; periodStart: string | null; periodEnd: string | null; sourcePaymentId: string | null; paidCopy: { paymentAmount: number; priorReduction: number; warnings: string[] } | null; warnings: string[] };
export const CARRY_NO_EVIDENCE_MESSAGE = "원결석 기간의 확정 수강료·실제 수업일 근거가 필요합니다.";
export const CARRY_PAUSE_SETTLED_MESSAGE = "휴원 정산에서 처리한 날입니다. 같은 날을 이월로 다시 보상할 수 없습니다.";
// 휴원 처리 방식이 «없음»(환불·이월·감액 없이 넘긴 날)이면 보상이 있었던 것이 아니다 — 막되 사실대로 말한다.
export const CARRY_PAUSE_PERIOD_MESSAGE = "휴원 기간 중인 날입니다. 휴원 신청을 먼저 확인해 주세요.";
/**
 * 결석 한 건의 «원기간 근거»(한 번 값의 분자·분모)를 정한다 — 적립(잠금 있음)과 신청함 미리보기(잠금 없음)가 같은 규칙을 쓴다.
 * 근거 순서: 발행 초안(ISSUED/ZERO)·확정 장부 → 없으면 그 반·그 달의 납부완료(PAID) 수강료 청구 1건(carryEvidence 규칙).
 * 조건이 안 맞으면 한국어 사유(WorkbenchError)를 던진다. 아무것도 쓰지 않는다.
 */
async function readCarryEvidenceInTx(tx: WorkbenchTx, input: CarryEvidenceInput, lock: boolean): Promise<ResolvedCarryEvidence> {
  const { absence, originMonth, calendar } = input;
  // 미리보기(lock=false)는 행을 잠그지 않는다 — 읽기만 하는 화면이 결제·발행 거래를 기다리게 하지 않는다.
  const share=(of="")=>lock?` FOR SHARE${of}`:"";
  // 휴원 정산이 이미 처리한 날(환불·이월·미납 감액으로 보상이 끝난 날)은 이월로 다시 보상하지 않는다 — 초안·장부·납부 근거 공통.
  // 취소된 휴원 신청의 정산은 실제로 빠지지 않은 날이라 제외한다. 정산 표가 아직 없으면(마이그레이션 전) 통과.
  const lineTable=await tx.$queryRawUnsafe<Array<{found:string|null}>>(`SELECT to_regclass($1)::text AS found`,'public."EnrollmentChangeSettlementLine"');
  if(lineTable[0]?.found) {
    const settled=await tx.$queryRawUnsafe<Array<{kind:string}>>(`SELECT DISTINCT l.kind AS kind FROM "EnrollmentChangeSettlementLine" l JOIN "EnrollmentChangeSettlement" s ON s.id=l."settlementId" JOIN "EnrollmentChangeRequest" r ON r.id=s."requestId" WHERE s."studentId"=$1 AND r."fromClassId"=$2 AND r.status<>'CANCELED' AND l."missedDates" @> to_jsonb($3::text)`,absence.studentId,absence.classId,absence.date);
    if(settled.some(l=>l.kind!=="NONE")) throw new WorkbenchError(CARRY_PAUSE_SETTLED_MESSAGE,409);
    if(settled.length) throw new WorkbenchError(CARRY_PAUSE_PERIOD_MESSAGE,409);
  }
  const registerExists=await tx.$queryRawUnsafe<Array<{found:string|null}>>(`SELECT to_regclass($1)::text AS found`,'public."MonthlyEnrollmentRegister"');
  const source = registerExists[0]?.found ? await tx.$queryRawUnsafe<Array<{ payload: unknown; status: string }>>(`SELECT payload,status FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2${share()}`,absence.studentId,originMonth) : [];
  const register = source[0]?.status==="CONFIRMED" ? validateMonthlyRegisterDraft(source[0].payload) : null;
  const registeredRow = register?.classes.find(r => r.classId === absence.classId);
  const issued = await tx.$queryRawUnsafe<Array<{payload:WorkbenchAmounts;status:string;paymentId:string|null;periodStart:string|null;periodEnd:string|null;scheduledDates:string[];calculationBasis:Record<string,unknown>}>>(`SELECT payload,status,"paymentId","periodStart","periodEnd","scheduledDates","calculationBasis" FROM "BillingWorkbenchDraft" WHERE "studentId"=$1 AND "classId"=$2 AND month=$3 AND status IN ('ISSUED','ZERO')${share()}`,absence.studentId,absence.classId,originMonth);
  const issuedRow=issued[0];
  if(issuedRow && registeredRow && ["baseAmount","discountAmount","prorationAmount"].some(k=>issuedRow.payload[k as keyof WorkbenchAmounts]!==registeredRow[k as "baseAmount"|"discountAmount"|"prorationAmount"])) throw new WorkbenchError("원기간 발행 금액과 기존 확정 장부가 다릅니다. 정본 금액을 대조한 뒤 이월해 주세요.",409);
  if(issuedRow?.status==="ISSUED") {
    const money=await tx.$queryRawUnsafe<Array<{amount:number;status:string;invoiceAmount:number|null;invoiceStatus:string|null}>>(`SELECT p.amount,p.status,i.amount AS "invoiceAmount",i.status AS "invoiceStatus" FROM "Payment" p LEFT JOIN "PaymentInvoice" i ON i."paymentId"=p.id WHERE p.id=$1 AND p."studentId"=$2 AND p."classId"=$3${share(" OF p")}`,issuedRow.paymentId,absence.studentId,absence.classId);
    const p=money[0];
    if(!p || p.amount!==workbenchTotal(issuedRow.payload) || p.invoiceAmount!==p.amount || ["CANCELED","CANCELLED","REFUNDED"].includes(p.status) || ["CANCELED","CANCELLED"].includes(p.invoiceStatus??"")) throw new WorkbenchError("원기간 청구·납부 정본이 일치하지 않습니다. 이월 적립을 보류합니다.",409);
  }
  // 납부 Payment 근거(2026-11-15): 초안·장부가 둘 다 없을 때만 본다 — 랠리즈에서 넘어온 달은 청구 준비 초안이 없다.
  // 그 학생·그 반·그 수강월의 납부완료(PAID) 수강료 청구만 근거다. 취소·환불·미납은 근거가 아니다(기존 문구로 차단).
  let paidPayments:PaidPaymentEvidence[]|null=null,enrollmentStartsOn:string|null=null,shuttleMayBeIncluded=false;
  if(!issuedRow && !registeredRow) {
    const [originYear,originMonthNumber]=originMonth.split("-").map(Number);
    const paidRows=await tx.$queryRawUnsafe<Array<{id:string;amount:number}>>(`SELECT p.id,p.amount FROM "Payment" p WHERE p."studentId"=$1 AND p."classId"=$2 AND p.year=$3 AND p.month=$4 AND p.type='MONTHLY' AND p.status='PAID' ORDER BY p.id${share(" OF p")}`,absence.studentId,absence.classId,originYear,originMonthNumber);
    if(!paidRows.length) throw new WorkbenchError(CARRY_NO_EVIDENCE_MESSAGE,409);
    // 이 청구에서 이미 줄인 금액(휴원 미납 감액·휴원 이월 차감) — 사이트가 청구 금액을 실제로 줄인 줄만 센다.
    const reduced=lineTable[0]?.found ? await tx.$queryRawUnsafe<Array<{paymentId:string;total:number}>>(`SELECT l."paymentId",SUM(l.amount)::int AS total FROM "EnrollmentChangeSettlementLine" l WHERE l."paymentId"=ANY($1::text[]) AND (l.kind='CARRY_APPLY' OR (l.kind='UNPAID_REDUCE' AND l.channel='SITE')) GROUP BY l."paymentId"`,paidRows.map(p=>p.id)) : [];
    paidPayments=paidRows.map(p=>({id:p.id,amount:Number(p.amount),priorReduction:Number(reduced.find(r=>r.paymentId===p.id)?.total??0)}));
    const enrollment=await tx.$queryRawUnsafe<Array<{startsOn:string|null}>>(`SELECT e."startsOn"::text AS "startsOn" FROM "Enrollment" e WHERE e."studentId"=$1 AND e."classId"=$2`,absence.studentId,absence.classId);
    enrollmentStartsOn=enrollment[0]?.startsOn??null;
    // 셔틀비 섞임 경고(금액은 그대로): 그 달 셔틀 명단에 있는데 별도 셔틀비 청구가 없으면 납부 금액에 셔틀비가 들어 있을 수 있다.
    const stopTable=await tx.$queryRawUnsafe<Array<{found:string|null}>>(`SELECT to_regclass($1)::text AS found`,'public."RegularShuttleStop"');
    const onRoster=stopTable[0]?.found ? await tx.$queryRawUnsafe<Array<{found:number}>>(`SELECT 1 AS found FROM "RegularShuttleStop" WHERE "serviceMonth"=$1 AND "studentId"=$2 AND direction IN ('BOARD','ALIGHT') LIMIT 1`,originMonth,absence.studentId) : [];
    const shuttleBill=onRoster.length ? await tx.$queryRawUnsafe<Array<{id:string}>>(`SELECT id FROM "Payment" WHERE "studentId"=$1 AND year=$2 AND month=$3 AND type='SHUTTLE' AND status NOT IN ('CANCELED','CANCELLED') LIMIT 1`,absence.studentId,originYear,originMonthNumber) : [];
    shuttleMayBeIncluded=onRoster.length>0 && shuttleBill.length===0;
  }
  const issuedSnapshot=issuedRow?.periodStart&&issuedRow.periodEnd&&Array.isArray(issuedRow.scheduledDates)&&issuedRow.scheduledDates.length>0?issuedRow:null;
  if(issuedRow && issuedRow.payload.prorationAmount>0 && !issuedSnapshot && !registeredRow)throw new WorkbenchError("원기간 월중 청구의 실제 수강 기간 근거가 없습니다. 전체 월 회수로 추측 이월할 수 없습니다.",409);
  const classData = await tx.$queryRawUnsafe<Array<{ dayOfWeek: string }>>(`SELECT "dayOfWeek" FROM "Class" WHERE id=$1${share()}`,absence.classId);
  const events = await tx.$queryRawUnsafe<Array<{ title: string; date: Date | string; endDate: Date | string | null }>>(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`);
  // 실제 청구 화면과 같은 연간 일정 함수가 산정한 회차만 허용한다.
  const { getMonthlyClassDates } = await import("@/lib/enrollment/monthlyClassDates");
  const allDates = getMonthlyClassDates(calendar?.events??events.map(e => ({ title:e.title,date:new Date(e.date).toISOString(),...(e.endDate ? {endDate:new Date(e.endDate).toISOString()} : {}) })),originMonth,classData[0]?.dayOfWeek ?? "");
  // 납부 Payment 근거의 금액·수업일은 순수 규칙(carryEvidence) 한 곳에서 정한다: 2건 이상 차단 · 이미 줄인 금액은 원래 금액 기준 · 월중 등록은 개시일 이후.
  const paidEvidence=paidPayments?resolveMonthEvidence({issuedDraft:null,paidPayments,monthDates:allDates,enrollmentStartsOn,shuttleMayBeIncluded}):null;
  if(paidEvidence?.kind==="BLOCKED") throw new WorkbenchError(paidEvidence.reason,409);
  const paid=paidEvidence?.kind==="PAID_PAYMENT"?paidEvidence:null;
  if(paidPayments && !paid) throw new WorkbenchError(CARRY_NO_EVIDENCE_MESSAGE,409);
  const periodStart=paid?paid.periodStart:issuedSnapshot?.periodStart??registeredRow?.periodStart??null,periodEnd=paid?paid.periodEnd:issuedSnapshot?.periodEnd??registeredRow?.periodEnd??null;
  const currentDates=paid?paid.scheduledDates:periodStart&&periodEnd?filterWorkbenchDates(allDates,periodStart,periodEnd):allDates;
  if(issuedSnapshot && JSON.stringify([...issuedSnapshot.scheduledDates].sort())!==JSON.stringify(currentDates))throw new WorkbenchError("원기간 발행 당시 수업일과 현재 일정이 달라 재정산 확인이 필요합니다.",409);
  const dates=issuedSnapshot?.scheduledDates??currentDates;
  const row=paid?null:issuedRow?.payload??registeredRow!;
  if ((registeredRow && registeredRow.status !== "ACTIVE") || !dates.includes(absence.date) || !dates.length || (row && row.prorationAmount > row.baseAmount-row.discountAmount)) throw new WorkbenchError("원결석이 확정 수강 기간·예정 수업일에 포함되는지 확인해 주세요.",409);
  // 이월·셔틀을 빼기 전 할인 후 수강료. 기간 조정은 실제 수강분에서만 산정한다.
  // 납부 Payment 근거는 «실제 청구 금액(+이미 줄인 금액)»이 분자다 — 할인은 낸 금액에 이미 반영돼 있다.
  const numerator = row ? row.baseAmount-row.discountAmount-row.prorationAmount : paid!.tuition;
  return {
    source: paid?"PAID_PAYMENT":issuedRow?"WORKBENCH_ISSUED":"MONTHLY_REGISTER", numerator, dates, periodStart, periodEnd,
    sourcePaymentId: paid?paid.paymentId:issuedRow?.paymentId??null,
    // 납부 Payment 근거에만 붙는 사본 — 청구 준비(readWorkbench)가 «그 청구가 지금도 납부완료이고 금액이 같은가»를 이 값으로 다시 본다.
    paidCopy: paid ? {paymentAmount:paidPayments![0].amount,priorReduction:paidPayments![0].priorReduction,warnings:paid.warnings} : null,
    warnings: paid?.warnings ?? [],
  };
}
/**
 * 결석 한 건의 근거를 확인하고 이월(BillingCarryCredit) 1행을 적립한다 — 하루짜리 이월과 기간 정산이 같이 쓴다.
 * 보강 예약 취소·보강권 회수·정산 기록(BillingAbsenceResolution)은 부르는 쪽 몫이다.
 */
export async function creditCarryForAbsenceInTx(tx: WorkbenchTx, input: CarryEvidenceInput & { eligibility: string; actorId: string }): Promise<{ source: CarryEvidenceSource; numerator: number; denominator: number; availableMonth: string }> {
  const { absence, originMonth, eligibility, actorId, calendar } = input;
  const { source: evidenceSource, numerator, dates, periodStart, periodEnd, sourcePaymentId, paidCopy } = await readCarryEvidenceInTx(tx, input, true);
  const [y,m] = originMonth.split("-").map(Number);
  const availableMonth = `${m === 12 ? y+1:y}-${String(m === 12 ? 1:m+1).padStart(2,"0")}`;
  await tx.$executeRawUnsafe(`INSERT INTO "BillingCarryCredit" (id,"studentId","absenceId",numerator,denominator,"availableMonth",basis,"actorUserId") VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6,$7::jsonb,$8)`,randomUUID(),absence.studentId,absence.id,String(numerator),String(dates.length),availableMonth,JSON.stringify({originMonth:originMonth,classId:absence.classId,absenceDate:absence.date,periodStart,periodEnd,scheduledDates:dates,discountedTuition:numerator,evidenceConfirmed:true,eligibility:eligibility,originalReason:absence.reason,source:evidenceSource,calendarSource:calendar?.kind??"DB",calendarFingerprint:calendar?.fingerprint??null,sourcePaymentId,...(paidCopy??{})}),actorId);
  return { source: evidenceSource, numerator, denominator: dates.length, availableMonth };
}
export type CarryEvidencePreview =
  | { ok: true; source: CarryEvidenceSource; tuition: number; sessions: number; unit: number; warnings: string[] }
  | { ok: false; reason: string; noEvidence: boolean };
/**
 * 신청함 «승인 전 근거 미리보기» — 적립과 같은 규칙으로 금액·나눈 횟수·1회 값(표시용 반올림)을 읽기만 한다.
 * 조건이 안 맞으면 적립 때 나올 사유를 그대로 돌려준다(noEvidence = 근거 청구 자체가 없음).
 */
export async function previewCarryEvidence(tx: WorkbenchTx, input: CarryEvidenceInput): Promise<CarryEvidencePreview> {
  try {
    const evidence = await readCarryEvidenceInTx(tx, input, false);
    return { ok: true, source: evidence.source, tuition: evidence.numerator, sessions: evidence.dates.length, unit: Math.round(evidence.numerator / evidence.dates.length), warnings: evidence.warnings };
  } catch (error) {
    if (error instanceof WorkbenchError) return { ok: false, reason: error.message, noEvidence: error.message === CARRY_NO_EVIDENCE_MESSAGE };
    throw error;
  }
}
