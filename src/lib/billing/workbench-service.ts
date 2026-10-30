import { createHash, randomUUID } from "node:crypto";
import { getMonthlyClassDates } from "@/lib/enrollment/monthlyClassDates";
import { monthlyBillingDueDate } from "@/lib/billing-due-date";
import { notMergedStudent } from "@/lib/studentVisibility";
import { validateMonthlyRegisterDraft } from "./monthly-register";
import { WorkbenchError, carryPool, allocateCarry, filterWorkbenchDates, validateWorkbenchCommand, validateWorkbenchMonth, workbenchTotal, shortMonthProration, STANDARD_MONTHLY_SESSIONS,
  type WorkbenchAmounts, type WorkbenchView, type WorkbenchRow, type WorkbenchOperation, type WorkbenchCalendarSnapshot } from "./workbench";

export type WorkbenchTx = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type WorkbenchDb = { $transaction<T>(work: (tx: WorkbenchTx) => Promise<T>, options?: { isolationLevel: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T> };
type Enrollment = { studentId: string; studentName: string; classId: string; className: string; status: string; price: number; dayOfWeek: string; createdAt: Date | string; updatedAt: Date | string };
type Register = { studentId: string; month: string; status: string; payload: unknown; version: number };
type Stored = { id: string; month: string; studentId: string; classId: string; version: number; status: "DRAFT" | "CONFIRMED" | "ISSUED" | "ZERO"; payload: WorkbenchAmounts; reason: string; sourceVersion: string; paymentId: string | null; periodStart?:string|null;periodEnd?:string|null;scheduledDates?:string[];calculationBasis?:Record<string,unknown> };
type Absence = { id: string; studentId: string; studentName: string; classId: string; date: string; reason: string; status: string; makeupStatus: string | null; resolution: string | null };
type Credit = { id: string; studentId: string; numerator: string; denominator: string; availableMonth: string; absenceId?: string; valid?: boolean; basis?:{originMonth?:string;classId?:string;discountedTuition?:number;sourcePaymentId?:string|null;scheduledDates?:string[];periodStart?:string|null;periodEnd?:string|null} };
type Usage = { studentId: string; amount: number; month?: string; paymentId?: string | null; paymentStatus?: string | null; invoiceStatus?:string|null; basis?:unknown; sourceCreditIds?:string[] };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const limit = 5001;
const take = <T>(rows: T[]) => { if (rows.length >= limit) throw new WorkbenchError("자료가 많아 전체 계산을 완료하지 못했습니다. 기간을 나눠 확인해 주세요.", 409); return rows; };
const amountFields = (r: WorkbenchAmounts): WorkbenchAmounts => ({ baseAmount: r.baseAmount, discountAmount: r.discountAmount, prorationAmount: r.prorationAmount, carryAmount: r.carryAmount, shuttleAmount: r.shuttleAmount });
async function exists(tx: WorkbenchTx, table: string) {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, `public."${table}"`);
  return Boolean(rows[0]?.found);
}
export async function readWorkbenchSchedule(tx:WorkbenchTx,month:string,classId:string,start:string|null,end:string|null,calendar?:WorkbenchCalendarSnapshot) {
  const cls=await tx.$queryRawUnsafe<Array<{dayOfWeek:string}>>(`SELECT "dayOfWeek" FROM "Class" WHERE id=$1 FOR SHARE`,classId);
  const events=await tx.$queryRawUnsafe<Array<{title:string;date:Date|string;endDate:Date|string|null}>>(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`);
  const eventValues=calendar?.events??events.map(e=>({title:e.title,date:new Date(e.date).toISOString(),...(e.endDate?{endDate:new Date(e.endDate).toISOString()}:{})}));
  const allDates=getMonthlyClassDates(eventValues,month,cls[0]?.dayOfWeek??"");
  const periodStart=start??allDates[0]??null,periodEnd=end??allDates.at(-1)??null;
  return{periodStart,periodEnd,scheduledDates:periodStart&&periodEnd?filterWorkbenchDates(allDates,periodStart,periodEnd):[]};
}

/** 동일 거래의 원본만 읽는다. 외부 캘린더/서비스와 연결하거나 초기 테이블을 생성하지 않는다. */
export async function readWorkbench(tx: WorkbenchTx, month: string, writesEnabled = false,calendar?:WorkbenchCalendarSnapshot): Promise<WorkbenchView> {
  validateWorkbenchMonth(month);
  const [year, monthNumber] = month.split("-").map(Number);
  const enrollments = take(await tx.$queryRawUnsafe<Enrollment[]>(`SELECT e."studentId", s.name AS "studentName", e."classId", c.name AS "className", e.status,
    p.price, c."dayOfWeek", s."parentId", c."updatedAt" AS "classUpdatedAt", p."updatedAt" AS "programUpdatedAt", e."createdAt", e."updatedAt" FROM "Enrollment" e JOIN "Student" s ON s.id=e."studentId"
    JOIN "Class" c ON c.id=e."classId" JOIN "Program" p ON p.id=c."programId"
    WHERE ${notMergedStudent("s")} ORDER BY e."studentId",e."classId" LIMIT ${limit}`));
  const payments = take(await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; classId: string | null; status: string; amount: number; type: string; updatedAt: Date | string }>>(`SELECT id,"studentId","classId",status,amount,type,"updatedAt" FROM "Payment" WHERE year=$1 AND month=$2 ORDER BY id LIMIT ${limit}`, year, monthNumber));
  const invoices = take(await tx.$queryRawUnsafe<Array<{ id: string; paymentId: string; status: string; amount: number; updatedAt: Date | string }>>(`SELECT i.id,i."paymentId",i.status,i.amount,i."updatedAt" FROM "PaymentInvoice" i JOIN "Payment" p ON p.id=i."paymentId" WHERE p.year=$1 AND p.month=$2 ORDER BY i.id LIMIT ${limit}`, year, monthNumber));
  const registerReady = await exists(tx, "MonthlyEnrollmentRegister");
  const registers = registerReady ? take(await tx.$queryRawUnsafe<Register[]>(`SELECT "studentId",month,status,payload,version FROM "MonthlyEnrollmentRegister" ORDER BY month,"studentId" LIMIT ${limit}`)) : [];
  const events = await exists(tx, "AnnualEvent") ? take(await tx.$queryRawUnsafe<Array<{ title: string; date: Date | string; endDate: Date | string | null }>>(`SELECT title,date,"endDate","updatedAt" FROM "AnnualEvent" ORDER BY date,id LIMIT ${limit}`)) : [];
  const eventValues = calendar?.events??events.map(e => ({ title: e.title, date: new Date(e.date).toISOString(), ...(e.endDate ? { endDate: new Date(e.endDate).toISOString() } : {}) }));
  const storageReady = (await Promise.all(["BillingWorkbenchDraft", "BillingWorkbenchOperation", "BillingCarryCredit", "BillingCarryUsage", "BillingAbsenceResolution", "BillingWorkbenchRevision"].map(t => exists(tx, t)))).every(Boolean);
  const drafts = storageReady ? take(await tx.$queryRawUnsafe<Stored[]>(`SELECT * FROM "BillingWorkbenchDraft" WHERE month=$1 ORDER BY id LIMIT ${limit}`, month)) : [];
  // 원기간에서 실제 수정·발행한 금액도 결석 정산의 정본이다. 선택월 초안은 자체 저장으로 해시가 변하지 않게 제외한다.
  const originDrafts = storageReady ? take(await tx.$queryRawUnsafe<Stored[]>(`SELECT * FROM "BillingWorkbenchDraft" WHERE month<>$1 AND status IN ('ISSUED','ZERO') ORDER BY month,id LIMIT ${limit}`,month)) : [];
  const originPayments = take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;classId:string|null;amount:number;status:string;year:number|null;month:number|null;updatedAt:Date|string}>>(`SELECT id,"studentId","classId",amount,status,year,month,"updatedAt" FROM "Payment" ORDER BY id LIMIT ${limit}`));
  const originInvoices = take(await tx.$queryRawUnsafe<Array<{id:string;paymentId:string;status:string;amount:number;updatedAt:Date|string}>>(`SELECT id,"paymentId",status,amount,"updatedAt" FROM "PaymentInvoice" ORDER BY id LIMIT ${limit}`));
  const credits = storageReady ? take(await tx.$queryRawUnsafe<Credit[]>(`SELECT c.id,c."studentId",c."absenceId",c.numerator::text,c.denominator::text,c."availableMonth",c.basis,
    (a.status='CONFIRMED' AND COALESCE(c.basis->>'originalReason',a.reason)=a.reason AND COALESCE(c.basis->>'absenceDate',to_char(a.date,'YYYY-MM-DD'))=to_char(a.date,'YYYY-MM-DD') AND COALESCE(c.basis->>'classId',a."classId")=a."classId" AND NOT EXISTS(SELECT 1 FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" WHERE t."studentId"=c."studentId" AND se."classId"=a."classId" AND se.date::date=a.date::date AND t.status<>'ABSENT')) AS valid
    FROM "BillingCarryCredit" c JOIN "RegularAbsence" a ON a.id=c."absenceId" WHERE c."availableMonth" <= $1 OR c.id IN (SELECT unnest(u."sourceCreditIds") FROM "BillingCarryUsage" u) ORDER BY c.id LIMIT ${limit}`, month)) : [];
  // 미래 기간에서 사용한 잔액도 중복 차감하지 않는다.
  const usages = storageReady ? take(await tx.$queryRawUnsafe<Usage[]>(`SELECT u."studentId",u.amount,u.month,u."paymentId",u.basis,u."sourceCreditIds",p.status AS "paymentStatus",i.status AS "invoiceStatus" FROM "BillingCarryUsage" u LEFT JOIN "Payment" p ON p.id=u."paymentId" LEFT JOIN "PaymentInvoice" i ON i."paymentId"=p.id ORDER BY u.id LIMIT ${limit}`)) : [];
  const absences: Absence[] = await exists(tx, "RegularAbsence") ? take(await tx.$queryRawUnsafe<Absence[]>(`SELECT a.id,a."studentId",s.name AS "studentName",a."classId",to_char(a.date,'YYYY-MM-DD') AS date,a.reason,a.status,
      ${await exists(tx, "MakeupCredit") ? `(SELECT string_agg(DISTINCT m.status,',') FROM "MakeupCredit" m WHERE m."studentId"=a."studentId" AND m."sourceKey"='REGULAR:'||a."classId"||':'||to_char(a.date,'YYYY-MM-DD'))` : `NULL::text`} AS "makeupStatus",
      ${storageReady ? `(SELECT r.resolution FROM "BillingAbsenceResolution" r WHERE r."absenceId"=a.id)` : `NULL::text`} AS resolution
      FROM "RegularAbsence" a JOIN "Student" s ON s.id=a."studentId" WHERE ${notMergedStudent("s")} AND a.date>='2026-10-05'::date AND a.date < ($1||'-01')::date+interval '1 month' AND a.status<>'CANCELLED' ORDER BY a.id LIMIT ${limit}`, month)) : [];
  const bookings = await exists(tx, "MakeupSession") ? take(await tx.$queryRawUnsafe<Array<{ id: string; status: string; studentId: string; originalClassId: string; originalDate: Date | string; updatedAt: Date | string }>>(`SELECT id,status,"studentId","originalClassId","originalDate","updatedAt" FROM "MakeupSession" WHERE "originalDate">='2026-10-05'::timestamp AND "originalDate" < ($1||'-01')::date+interval '1 month' ORDER BY id LIMIT ${limit}`,month)) : [];
  const makeupSource = await exists(tx,"MakeupCredit") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;sourceKey:string;status:string;updatedAt:Date|string;makeupSessionId:string|null}>>(`SELECT id,"studentId","sourceKey",status,"updatedAt","makeupSessionId" FROM "MakeupCredit" ORDER BY id LIMIT ${limit}`)) : [];
  const attendance = await exists(tx,"Attendance") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string;classId:string;date:string;status:string;updatedAt:Date|string}>>(`SELECT t.id,t."studentId",se."classId",to_char(se.date,'YYYY-MM-DD') AS date,t.status,t."updatedAt" FROM "Attendance" t JOIN "Session" se ON se.id=t."sessionId" ORDER BY t.id LIMIT ${limit}`)) : [];
  const seasonalCredits = await exists(tx,"SpecialProgramCredit") ? take(await tx.$queryRawUnsafe<Array<{id:string;studentId:string|null;amount:number;status:string;updatedAt:Date|string}>>(`SELECT cr.id,a."convertedStudentId" AS "studentId",cr.amount,cr.status,cr."updatedAt" FROM "SpecialProgramCredit" cr JOIN "SpecialProgramApplicationItem" it ON it.id=cr."applicationItemId" JOIN "SpecialProgramApplication" a ON a.id=it."applicationId" WHERE cr.status='ACTIVE' ORDER BY cr.id LIMIT ${limit}`)) : [];
  for(const credit of credits) if(credit.basis?.originMonth && credit.basis.classId) {
    const b=credit.basis,issued=[...originDrafts,...drafts].find(d=>d.studentId===credit.studentId&&d.classId===b.classId&&d.month===b.originMonth&&["ISSUED","ZERO"].includes(d.status));
    const reg=registers.find(r=>r.studentId===credit.studentId&&r.month===b.originMonth&&r.status==="CONFIRMED");
    let monthly:ReturnType<typeof validateMonthlyRegisterDraft>["classes"][number]|undefined;
    try{monthly=reg?validateMonthlyRegisterDraft(reg.payload).classes.find(c=>c.classId===b.classId):undefined;}catch{credit.valid=false;}
    const latest=issued?.payload??monthly;
    if(!latest || latest.baseAmount-latest.discountAmount-latest.prorationAmount!==b.discountedTuition || (monthly&&["baseAmount","discountAmount","prorationAmount"].some(k=>issued&&issued.payload[k as keyof WorkbenchAmounts]!==monthly[k as "baseAmount"|"discountAmount"|"prorationAmount"])))credit.valid=false;
    if(b.sourcePaymentId){
      const p=originPayments.find(p=>p.id===b.sourcePaymentId),invoice=originInvoices.find(i=>i.paymentId===b.sourcePaymentId);
      if(!p||!issued||p.amount!==workbenchTotal(issued.payload)||!invoice||invoice.amount!==p.amount||["CANCELED","CANCELLED","REFUNDED"].includes(p.status)||["CANCELED","CANCELLED","REFUNDED"].includes(invoice.status))credit.valid=false;
    }
    const periodStart=issued?.periodStart??monthly?.periodStart??b.periodStart;
    const periodEnd=issued?.periodEnd??monthly?.periodEnd??b.periodEnd;
    const day=enrollments.find(e=>e.classId===b.classId)?.dayOfWeek;
    // 적립 후 휴강·원기간 조정으로 실제 분모가 바뀌면 새 사유 저장으로 우회하지 않는다.
    let currentDates=day?getMonthlyClassDates(eventValues,b.originMonth!,day):[];
    try{if(periodStart&&periodEnd)currentDates=filterWorkbenchDates(currentDates,periodStart,periodEnd);}catch{credit.valid=false;}
    if(!b.scheduledDates?.length || String(b.scheduledDates.length)!==credit.denominator || JSON.stringify([...b.scheduledDates].sort())!==JSON.stringify(currentDates))credit.valid=false;
  }
  for(const absence of absences) {
    const states = new Set((absence.makeupStatus ?? "").split(",").filter(Boolean));
    for(const booking of bookings) if(booking.studentId===absence.studentId && booking.originalClassId===absence.classId && new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul"}).format(new Date(booking.originalDate))===absence.date && booking.status!=="CANCELLED") states.add(booking.status);
    absence.makeupStatus=states.size ? [...states].sort().join(",") : null;
  }
  const completedCurrentDrafts=drafts.filter(d=>["ISSUED","ZERO"].includes(d.status));
  const calendarSource=calendar?.kind??"DB";
  const officialCalendarFingerprint=calendar?hash({kind:calendar.kind,events:calendar.events,fingerprint:calendar.fingerprint}):null;
  const sourceVersion = hash({ month, enrollments, payments, invoices, registers, events, officialCalendarFingerprint, calendarSource, credits, usages, absences, bookings, originDrafts, completedCurrentDrafts, originPayments, originInvoices, makeupSource, attendance, seasonalCredits });
  const pool = (studentId:string)=>carryPool(credits.filter(c=>c.studentId===studentId),usages.filter(u=>u.studentId===studentId),month);
  const available = (studentId: string) => pool(studentId).available;
  const assignedShuttle = new Set<string>(), assignedCarry = new Map<string, number>();
  const rows: WorkbenchRow[] = enrollments.map(e => {
    const id = `${e.studentId}:${e.classId}`, saved = drafts.find(d => d.id === id);
    const register = registers.find(r => r.studentId === e.studentId && r.month===month && r.status === "CONFIRMED");
    let reg: ReturnType<typeof validateMonthlyRegisterDraft> | null = null;
    if (register) { try { reg = validateMonthlyRegisterDraft(register.payload); } catch { /* 잘못된 확정 장부는 발행을 막는다. */ } }
    const basis: string[] = [], reviewReasons: string[] = [], blockingReasons: string[] = [];
    const allScheduledDates = getMonthlyClassDates(eventValues, month, e.dayOfWeek);
    const classReg = reg?.classes.find(c => c.classId === e.classId);
    const periodStart=saved?.periodStart??classReg?.periodStart??allScheduledDates[0]??null;
    const periodEnd=saved?.periodEnd??classReg?.periodEnd??allScheduledDates.at(-1)??null;
    const scheduledDates=periodStart&&periodEnd?filterWorkbenchDates(allScheduledDates,periodStart,periodEnd):[];
    const excluded = e.status !== "ACTIVE" || Boolean(classReg && classReg.status !== "ACTIVE");
    let amounts: WorkbenchAmounts = { baseAmount: excluded ? 0 : e.price, discountAmount: 0, prorationAmount: 0, carryAmount: 0, shuttleAmount: 0 };
    // 정가는 월 4회 기준. 연간 일정상 그달 전체 수업이 4회 미만이면 모자란 회차만큼 뺀다(설 주간·연휴가 낀 달).
    const monthSessions = allScheduledDates.length;
    const isShortMonth = monthSessions > 0 && monthSessions < STANDARD_MONTHLY_SESSIONS;
    if (classReg) {
      amounts = { ...amounts, baseAmount: classReg.baseAmount, discountAmount: classReg.discountAmount, prorationAmount: classReg.prorationAmount };
      basis.push("확정 월 장부");
      if (classReg.carryAmount > 0) reviewReasons.push("기존 장부 이월액은 원결석·사용 잔액 대조가 필요합니다.");
      if (isShortMonth && !excluded && classReg.prorationAmount === 0) reviewReasons.push(`연간 일정 ${monthSessions}회인 달인데 확정 장부에 일할 차감이 없습니다.`);
      if (!assignedShuttle.has(e.studentId) && !excluded) { amounts.shuttleAmount = reg!.shuttleAmount; assignedShuttle.add(e.studentId); }
    } else if (!excluded) {
      basis.push("등록 반의 프로그램 수강료");
      reviewReasons.push("할인·셔틀 및 수강 기간을 검토해 주세요.");
      if (isShortMonth) {
        amounts.prorationAmount = shortMonthProration(amounts.baseAmount, monthSessions);
        basis.push(`월 ${STANDARD_MONTHLY_SESSIONS}회 기준 중 ${STANDARD_MONTHLY_SESSIONS - monthSessions}회 적은 달 → ${amounts.prorationAmount.toLocaleString("ko-KR")}원 차감`);
      }
    }
    if (!scheduledDates.length && !excluded) blockingReasons.push("연간 일정의 실제 수업일이 없어 확정·발행할 수 없습니다.");
    if (register && !reg) reviewReasons.push("확정 월 장부의 근거가 올바르지 않습니다.");
    if (scheduledDates.length) basis.push(`연간 일정 ${scheduledDates.length}회`);
    const existing = payments.filter(p => p.studentId === e.studentId && p.status !== "CANCELED" && p.status !== "CANCELLED" && (p.classId === e.classId || p.classId === null) && p.type !== "UNIFORM");
    const completed = Boolean(saved && ["ISSUED", "ZERO"].includes(saved.status));
    const participates = !excluded && !completed && !existing.length;
    const balance = available(e.studentId);
    const remaining = Math.max(0, balance - (assignedCarry.get(e.studentId) ?? 0));
    amounts.carryAmount = !participates ? 0 : Math.min(remaining, Math.max(0, amounts.baseAmount - amounts.discountAmount - amounts.prorationAmount));
    if (saved && !["ISSUED", "ZERO"].includes(saved.status)) amounts = saved.payload;
    if (saved && ["ISSUED", "ZERO"].includes(saved.status)) amounts = saved.payload;
    if(participates) assignedCarry.set(e.studentId, (assignedCarry.get(e.studentId) ?? 0) + amounts.carryAmount);
    if(credits.some(c=>c.studentId===e.studentId && c.valid===false)) blockingReasons.push("원결석 취소·출석 정정된 이월이 있습니다. 정산을 확인해 주세요.");
    if(usages.some(u=>u.studentId===e.studentId && (["CANCELED","CANCELLED","REFUNDED"].includes(u.paymentStatus??"") || ["CANCELED","CANCELLED","REFUNDED"].includes(u.invoiceStatus??"") || (u.paymentId && (!u.paymentStatus || !u.invoiceStatus))))) blockingReasons.push("이월 사용 청구의 취소·환불 내역을 재정산해야 합니다.");
    if(seasonalCredits.some(c=>c.studentId===e.studentId)) blockingReasons.push("기존 특강 이월액은 원결석·사용액 대조 후 옮겨야 합니다. 중복 차감을 막기 위해 보류합니다.");
    if(pool(e.studentId).unresolved) blockingReasons.push("기존 이월 사용분에 원적립 연결이 없어 정산 확인이 필요합니다.");
    if (existing.length) reviewReasons.push("이미 청구·납부된 내역이 있어 새 발행에서 제외합니다.");
    if (saved && saved.sourceVersion !== sourceVersion && !["ISSUED", "ZERO"].includes(saved.status)) reviewReasons.push("검토 후 원본이 변경되었습니다. 다시 저장·확정해 주세요.");
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
      periodEnd, scheduledDates, carryAvailable: balance, remainingCarry: Math.max(0, balance - (assignedCarry.get(e.studentId) ?? 0)), dueDate: monthlyBillingDueDate(year,monthNumber), blockingReasons };
  });
  return { month, sourceVersion, storageReady, writesEnabled: writesEnabled && storageReady, rows,carrySettlementReady:true,calendarSource,
    notices:[...seasonalCredits.length?[`기존 특강 이월 ${seasonalCredits.length}건은 별도 대조·이관이 필요합니다. 자동 중복 적립하지 않습니다.`]:[]],
    absences: absences.map(a => ({ ...a, reviewReasons: a.resolution ? [] : [a.status !== "CONFIRMED" ? "결석 확인 필요" : "이월·보강 중 하나를 선택해 주세요.", ...a.makeupStatus?.split(",").some(s => ["USED", "ATTENDED", "NO_SHOW"].includes(s)) ? ["보강 사용 내역이 있어 자동 이월할 수 없습니다."] : []] })),
    summary: { total: rows.length, ready: rows.filter(r => r.status === "READY").length, review: rows.filter(r => r.status === "REVIEW").length,
      excluded: rows.filter(r => r.status === "EXCLUDED").length, issued: rows.filter(r => r.status === "ISSUED").length,
      totalAmount: rows.filter(r => !["EXCLUDED", "ISSUED"].includes(r.status)).reduce((s, r) => s + r.totalAmount, 0) } };
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
      const snapshot=command.action==="SAVE"?await readWorkbenchSchedule(tx,command.month,row.classId,edit.periodStart??row.periodStart,edit.periodEnd??row.periodEnd,calendar):{periodStart:stored.periodStart??null,periodEnd:stored.periodEnd??null,scheduledDates:stored.scheduledDates??[]};
      if(command.action!=="SAVE" && (!snapshot.scheduledDates.length || JSON.stringify(snapshot.scheduledDates)!==JSON.stringify(row.scheduledDates)))throw new WorkbenchError("저장한 실제 수강일과 현재 일정이 다릅니다. 기간을 다시 검토해 주세요.",409,true);
      if(command.action==="SAVE" && (edit.periodStart||edit.periodEnd) && !snapshot.scheduledDates.length)throw new WorkbenchError("선택한 수강 기간에 예정 수업이 없습니다.",409);
      const calculationBasis=command.action==="SAVE"?{source:calendar?.kind??"DB",calendarFingerprint:calendar?.fingerprint??null,...snapshot,sourceVersion:view.sourceVersion,discountedTuition:payload.baseAmount-payload.discountAmount-payload.prorationAmount,reviewReason:edit.reason!.trim()}:stored.calculationBasis??{};
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
