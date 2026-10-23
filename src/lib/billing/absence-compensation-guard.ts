/** 기존 보강 입구와 새 이월 정산이 같은 결석을 동시에 보상하지 않도록 연결한다. */
export type CompensationTransaction = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export class CompensationConflict extends Error {
  constructor() {
    super("이월로 정산한 결석입니다. 청구·이월 내역을 먼저 확인해 주세요.");
    this.name = "CompensationConflict";
  }
}

export async function lockCompensation(tx: CompensationTransaction) {
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('STIZ_BILLING_WORKBENCH'))");
}

async function hasResolutionTable(tx: CompensationTransaction) {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(
    `SELECT to_regclass('public."BillingAbsenceResolution"')::text AS found`,
  );
  return Boolean(rows[0]?.found);
}

export async function assertRegularMakeupAllowed(tx: CompensationTransaction, input: {
  studentId: string; classId: string; dateYmd: string;
}) {
  if (!await hasResolutionTable(tx)) return;
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT a.id FROM "RegularAbsence" a JOIN "BillingAbsenceResolution" r ON r."absenceId"=a.id
      WHERE a."studentId"=$1 AND a."classId"=$2 AND to_char(a.date,'YYYY-MM-DD')=$3
        AND r.resolution='CARRY' LIMIT 1`, input.studentId, input.classId, input.dateYmd,
  );
  if (rows.length) throw new CompensationConflict();
}

export async function assertMakeupSessionAllowed(tx: CompensationTransaction, makeupSessionId: string) {
  if (!await hasResolutionTable(tx)) return;
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT a.id FROM "MakeupSession" m JOIN "RegularAbsence" a
       ON a."studentId"=m."studentId" AND a."classId"=m."originalClassId"
       AND to_char(a.date,'YYYY-MM-DD')=to_char(m."originalDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD')
       JOIN "BillingAbsenceResolution" r ON r."absenceId"=a.id
      WHERE m.id=$1 AND r.resolution='CARRY' LIMIT 1`, makeupSessionId,
  );
  if (rows.length) throw new CompensationConflict();
}

export async function assertAbsenceCompensationEditable(tx: CompensationTransaction, absenceId: string) {
  if (!await hasResolutionTable(tx)) return;
  const rows = await tx.$queryRawUnsafe<Array<{ absenceId: string }>>(
    `SELECT "absenceId" FROM "BillingAbsenceResolution" WHERE "absenceId"=$1 AND resolution='CARRY' LIMIT 1`, absenceId,
  );
  if (rows.length) throw new CompensationConflict();
}
