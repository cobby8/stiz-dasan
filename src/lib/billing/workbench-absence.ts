import { createHash, randomUUID } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { validateMonthlyRegisterDraft } from "./monthly-register";
import { WorkbenchError, workbenchTotal, filterWorkbenchDates, type WorkbenchAmounts, type WorkbenchView, type WorkbenchCalendarSnapshot } from "./workbench";
import { readWorkbench, type WorkbenchDb } from "./workbench-service";

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
      const registerExists=await tx.$queryRawUnsafe<Array<{found:string|null}>>(`SELECT to_regclass($1)::text AS found`,'public."MonthlyEnrollmentRegister"');
      const source = registerExists[0]?.found ? await tx.$queryRawUnsafe<Array<{ payload: unknown; status: string }>>(`SELECT payload,status FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2 FOR SHARE`,absence.studentId,b.originMonth) : [];
      const register = source[0]?.status==="CONFIRMED" ? validateMonthlyRegisterDraft(source[0].payload) : null;
      const registeredRow = register?.classes.find(r => r.classId === absence.classId);
      const issued = await tx.$queryRawUnsafe<Array<{payload:WorkbenchAmounts;status:string;paymentId:string|null;periodStart:string|null;periodEnd:string|null;scheduledDates:string[];calculationBasis:Record<string,unknown>}>>(`SELECT payload,status,"paymentId","periodStart","periodEnd","scheduledDates","calculationBasis" FROM "BillingWorkbenchDraft" WHERE "studentId"=$1 AND "classId"=$2 AND month=$3 AND status IN ('ISSUED','ZERO') FOR SHARE`,absence.studentId,absence.classId,b.originMonth);
      const issuedRow=issued[0];
      if(issuedRow && registeredRow && ["baseAmount","discountAmount","prorationAmount"].some(k=>issuedRow.payload[k as keyof WorkbenchAmounts]!==registeredRow[k as "baseAmount"|"discountAmount"|"prorationAmount"])) throw new WorkbenchError("원기간 발행 금액과 기존 확정 장부가 다릅니다. 정본 금액을 대조한 뒤 이월해 주세요.",409);
      if(issuedRow?.status==="ISSUED") {
        const money=await tx.$queryRawUnsafe<Array<{amount:number;status:string;invoiceAmount:number|null;invoiceStatus:string|null}>>(`SELECT p.amount,p.status,i.amount AS "invoiceAmount",i.status AS "invoiceStatus" FROM "Payment" p LEFT JOIN "PaymentInvoice" i ON i."paymentId"=p.id WHERE p.id=$1 AND p."studentId"=$2 AND p."classId"=$3 FOR SHARE OF p`,issuedRow.paymentId,absence.studentId,absence.classId);
        const p=money[0];
        if(!p || p.amount!==workbenchTotal(issuedRow.payload) || p.invoiceAmount!==p.amount || ["CANCELED","CANCELLED","REFUNDED"].includes(p.status) || ["CANCELED","CANCELLED"].includes(p.invoiceStatus??"")) throw new WorkbenchError("원기간 청구·납부 정본이 일치하지 않습니다. 이월 적립을 보류합니다.",409);
      }
      if(!issuedRow && !registeredRow) throw new WorkbenchError("원결석 기간의 확정 수강료·실제 수업일 근거가 필요합니다.",409);
      const issuedSnapshot=issuedRow?.periodStart&&issuedRow.periodEnd&&Array.isArray(issuedRow.scheduledDates)&&issuedRow.scheduledDates.length>0?issuedRow:null;
      if(issuedRow && issuedRow.payload.prorationAmount>0 && !issuedSnapshot && !registeredRow)throw new WorkbenchError("원기간 월중 청구의 실제 수강 기간 근거가 없습니다. 전체 월 회수로 추측 이월할 수 없습니다.",409);
      const classData = await tx.$queryRawUnsafe<Array<{ dayOfWeek: string }>>(`SELECT "dayOfWeek" FROM "Class" WHERE id=$1 FOR SHARE`,absence.classId);
      const events = await tx.$queryRawUnsafe<Array<{ title: string; date: Date | string; endDate: Date | string | null }>>(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`);
      // 실제 청구 화면과 같은 연간 일정 함수가 산정한 회차만 허용한다.
      const { getMonthlyClassDates } = await import("@/lib/enrollment/monthlyClassDates");
      const periodStart=issuedSnapshot?.periodStart??registeredRow?.periodStart??null,periodEnd=issuedSnapshot?.periodEnd??registeredRow?.periodEnd??null;
      const allDates = getMonthlyClassDates(calendar?.events??events.map(e => ({ title:e.title,date:new Date(e.date).toISOString(),...(e.endDate ? {endDate:new Date(e.endDate).toISOString()} : {}) })),b.originMonth,classData[0]?.dayOfWeek ?? "");
      const currentDates=periodStart&&periodEnd?filterWorkbenchDates(allDates,periodStart,periodEnd):allDates;
      if(issuedSnapshot && JSON.stringify([...issuedSnapshot.scheduledDates].sort())!==JSON.stringify(currentDates))throw new WorkbenchError("원기간 발행 당시 수업일과 현재 일정이 달라 재정산 확인이 필요합니다.",409);
      const dates=issuedSnapshot?.scheduledDates??currentDates;
      const row=issuedRow?.payload??registeredRow!;
      if ((registeredRow && registeredRow.status !== "ACTIVE") || !dates.includes(absence.date) || !dates.length || row.prorationAmount > row.baseAmount-row.discountAmount) throw new WorkbenchError("원결석이 확정 수강 기간·예정 수업일에 포함되는지 확인해 주세요.",409);
      const [y,m] = b.originMonth.split("-").map(Number);
      const availableMonth = `${m === 12 ? y+1:y}-${String(m === 12 ? 1:m+1).padStart(2,"0")}`;
      // 이월·셔틀을 빼기 전 할인 후 수강료. 기간 조정은 실제 수강분에서만 산정한다.
      const numerator = row.baseAmount-row.discountAmount-row.prorationAmount;
      await tx.$executeRawUnsafe(`INSERT INTO "BillingCarryCredit" (id,"studentId","absenceId",numerator,denominator,"availableMonth",basis,"actorUserId") VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6,$7::jsonb,$8)`,randomUUID(),absence.studentId,absence.id,String(numerator),String(dates.length),availableMonth,JSON.stringify({originMonth:b.originMonth,classId:absence.classId,absenceDate:absence.date,periodStart,periodEnd,scheduledDates:dates,discountedTuition:numerator,evidenceConfirmed:true,eligibility:b.eligibility,originalReason:absence.reason,source:issuedRow?"WORKBENCH_ISSUED":"MONTHLY_REGISTER",calendarSource:calendar?.kind??"DB",calendarFingerprint:calendar?.fingerprint??null,sourcePaymentId:issuedRow?.paymentId??null}),actorId);
      await tx.$executeRawUnsafe(`UPDATE "MakeupSession" SET status='CANCELLED',"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status='BOOKED'`,bookings.map(c=>c.id));
      await tx.$executeRawUnsafe(`UPDATE "MakeupCredit" SET status='REVOKED',"makeupSessionId"=NULL,"updatedAt"=NOW() WHERE id=ANY($1::text[]) AND status IN ('AVAILABLE','RESERVED','EXPIRED')`,credits.map(c=>c.id));
    } else {
      if (!credits.some(c=>["AVAILABLE","RESERVED","USED","NO_SHOW"].includes(c.status))) throw new WorkbenchError("사용 가능한 기존 보강권을 먼저 확인해 주세요. 과거 결석의 보강권을 소급 발급하지 않습니다.",409);
    }
    await tx.$executeRawUnsafe(`INSERT INTO "BillingAbsenceResolution" ("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId") VALUES ($1,$2,$3,$4,$5,$6,$7)`,absence.id,absence.studentId,b.resolution,b.reason.trim(),b.evidenceConfirmed===true,b.eligibility,actorId);
    const operationResult = {requestId:b.requestId,action:b.action,rowIds:[absence.id],paymentIds:[],zeroCount:0};
    await tx.$executeRawUnsafe(`INSERT INTO "BillingWorkbenchOperation" ("requestId",fingerprint,result,"actorUserId") VALUES ($1,$2,$3::jsonb,$4)`,b.requestId,fingerprint,JSON.stringify(operationResult),actorId);
    return {view:await readWorkbench(tx,b.month,enabled,calendar),operationResult};
  },{isolationLevel:"Serializable",timeout:30_000});
}
