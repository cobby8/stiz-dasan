import { randomUUID } from "node:crypto";
import {
  calculateMonthlyRegister, MonthlyRegisterError, validateMonthlyRegisterDraft,
  type MonthlyRegisterDraft, type MonthlyRegisterRecord, type MonthlyRegisterView,
} from "./monthly-register";

export type RegisterTransaction = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
export type RegisterDatabase = {
  $transaction<T>(work: (tx: RegisterTransaction) => Promise<T>): Promise<T>;
};
type StoredRegister = {
  id: string; studentId: string; month: string; version: number;
  status: "DRAFT" | "CONFIRMED"; payload: unknown;
  updatedAt: Date | string; confirmedAt: Date | string | null;
};
export type RegisterCommand = {
  action: "SAVE_DRAFT" | "CONFIRM" | "REOPEN";
  studentId: string; month: string; expectedVersion: number;
  payload?: MonthlyRegisterDraft; reason: string;
};

export function validateRegisterTarget(studentId: unknown, month: unknown) {
  if (typeof studentId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(studentId)) {
    throw new MonthlyRegisterError("학생 ID를 확인해 주세요.");
  }
  if (typeof month !== "string" || !/^(20[2-9][0-9]|2100)-(0[1-9]|1[0-2])$/.test(month)) {
    throw new MonthlyRegisterError("장부 월을 확인해 주세요.");
  }
  return { studentId, month };
}

export function validateRegisterCommand(input: unknown): RegisterCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MonthlyRegisterError("요청 내용을 확인해 주세요.");
  const body = input as Record<string, unknown>;
  const { studentId, month } = validateRegisterTarget(body.studentId, body.month);
  if (!["SAVE_DRAFT", "CONFIRM", "REOPEN"].includes(body.action as string)) throw new MonthlyRegisterError("지원하지 않는 장부 작업입니다.");
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 || (body.expectedVersion as number) >= 2147483647) {
    throw new MonthlyRegisterError("장부 버전을 다시 조회해 주세요.");
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 500) throw new MonthlyRegisterError("변경 사유를 1~500자로 입력해 주세요.");
  const action = body.action as RegisterCommand["action"];
  const allowed = new Set(["action", "studentId", "month", "expectedVersion", "reason", ...(action === "SAVE_DRAFT" ? ["payload"] : [])]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new MonthlyRegisterError("허용되지 않은 요청 항목입니다.");
  const payload = action === "SAVE_DRAFT" ? validateMonthlyRegisterDraft(body.payload) : undefined;
  if (payload && (payload.studentId !== studentId || payload.month !== month)) throw new MonthlyRegisterError("미리보기의 학생 또는 월이 다릅니다.");
  if (payload && payload.reason !== body.reason.trim()) throw new MonthlyRegisterError("미리보기의 변경 사유가 다릅니다.");
  return { action, studentId, month, expectedVersion: body.expectedVersion as number, reason: body.reason.trim(), ...(payload ? { payload } : {}) };
}

const selectRegister = `SELECT id, "studentId", month, version, status, payload, "updatedAt", "confirmedAt"
  FROM "MonthlyEnrollmentRegister" WHERE "studentId" = $1 AND month = $2`;
const iso = (value: Date | string) => new Date(value).toISOString();
function toRecord(row: StoredRegister): MonthlyRegisterRecord {
  const payload = validateMonthlyRegisterDraft(row.payload);
  if (payload.studentId !== row.studentId || payload.month !== row.month || !["DRAFT", "CONFIRMED"].includes(row.status)) {
    throw new MonthlyRegisterError("저장된 장부가 일치하지 않아 확인이 필요합니다.", 409);
  }
  return { ...row, payload, totals: calculateMonthlyRegister(payload), updatedAt: iso(row.updatedAt), confirmedAt: row.confirmedAt ? iso(row.confirmedAt) : null };
}

async function context(tx: RegisterTransaction, studentId: string, lock: boolean) {
  // 이름이 아니라 실제 학생과 등록 반 ID로 연결한다. 병합된 이전 ID로 새 장부를 만들지 않는다.
  const students = await tx.$queryRawUnsafe<Array<{ name: string; mergedIntoStudentId: string | null }>>(
    `SELECT name, "mergedIntoStudentId" FROM "Student" WHERE id = $1${lock ? " FOR UPDATE" : ""}`, studentId);
  if (!students[0]) throw new MonthlyRegisterError("학생을 찾을 수 없습니다.", 404);
  if (lock && students[0].mergedIntoStudentId) throw new MonthlyRegisterError("통합된 학생입니다. 현재 학생 ID를 확인해 주세요.", 409);
  const candidates = await tx.$queryRawUnsafe<MonthlyRegisterView["candidates"]>(
    `SELECT e."classId", c.name AS "className", e.status FROM "Enrollment" e
     JOIN "Class" c ON c.id = e."classId" WHERE e."studentId" = $1
     ORDER BY e."classId"${lock ? " FOR SHARE OF e, c" : ""}`, studentId);
  return { studentName: students[0].name, candidates };
}

function checkClasses(payload: MonthlyRegisterDraft, candidates: MonthlyRegisterView["candidates"], confirming: boolean) {
  const ids = new Set(candidates.map((row) => row.classId));
  if (payload.classes.some((row) => !ids.has(row.classId))) throw new MonthlyRegisterError("실제 등록 내역에 없는 반입니다. 등록 이력을 먼저 확인해 주세요.", 409);
  if (confirming) {
    const included = new Set(payload.classes.map((row) => row.classId));
    if (candidates.some((row) => ["ACTIVE", "PAUSED"].includes(row.status) && !included.has(row.classId))) {
      throw new MonthlyRegisterError("현재 등록 반 중 빠진 반이 있습니다. 대상 월에 제외할 반도 제외 상태와 0원으로 기록해 주세요.", 409);
    }
  }
}

export async function readMonthlyRegister(tx: RegisterTransaction, studentId: string, month: string, writesEnabled = false): Promise<MonthlyRegisterView> {
  validateRegisterTarget(studentId, month);
  const details = await context(tx, studentId, false);
  const rows = await tx.$queryRawUnsafe<StoredRegister[]>(selectRegister, studentId, month);
  const history = await tx.$queryRawUnsafe<Array<{ version: number; status: "DRAFT" | "CONFIRMED"; reason: string; createdAt: Date | string }>>(
    `SELECT version, status, reason, "createdAt" FROM "MonthlyEnrollmentRegisterRevision"
     WHERE "studentId" = $1 AND month = $2 ORDER BY version DESC LIMIT 50`, studentId, month);
  return { ...details, record: rows[0] ? toRecord(rows[0]) : null,
    history: history.map((row) => ({ ...row, createdAt: iso(row.createdAt) })), writesEnabled };
}

/** 새 청구 경로가 아닌 검토용 영구 기록이다. Payment·Enrollment·외부 시스템을 수정하지 않는다. */
export async function mutateMonthlyRegister(db: RegisterDatabase, input: unknown, actorUserId: string, writesEnabled = false): Promise<MonthlyRegisterRecord> {
  if (!writesEnabled) throw new MonthlyRegisterError("월 장부 저장은 운영 적용 승인 전까지 잠겨 있습니다.", 503);
  if (!actorUserId) throw new MonthlyRegisterError("관리자 확인이 필요합니다.", 403);
  const command = validateRegisterCommand(input);
  return db.$transaction(async (tx) => {
    // 학생 행 잠금으로 첫 저장 경쟁까지 순서대로 처리한다. 기존 행은 버전도 함께 비교한다.
    const details = await context(tx, command.studentId, true);
    const rows = await tx.$queryRawUnsafe<StoredRegister[]>(`${selectRegister} FOR UPDATE`, command.studentId, command.month);
    const previous = rows[0];
    if ((previous?.version ?? 0) !== command.expectedVersion) throw new MonthlyRegisterError("다른 작업에서 장부가 변경됐습니다. 다시 조회해 주세요.", 409);
    if (command.action !== "SAVE_DRAFT" && !previous) throw new MonthlyRegisterError("초안을 먼저 저장해 주세요.", 409);
    if (command.action === "SAVE_DRAFT" && previous?.status === "CONFIRMED") throw new MonthlyRegisterError("확정 장부는 재열기 후 수정할 수 있습니다.", 409);
    if (command.action === "CONFIRM" && previous?.status !== "DRAFT") throw new MonthlyRegisterError("초안 상태에서만 확정할 수 있습니다.", 409);
    if (command.action === "REOPEN" && previous?.status !== "CONFIRMED") throw new MonthlyRegisterError("확정 장부만 재열 수 있습니다.", 409);
    const payload = command.action === "SAVE_DRAFT" ? command.payload! : toRecord(previous!).payload;
    // 확정은 화면에서 새 금액을 받지 않고 저장된 버전의 금액을 다시 검증한다.
    checkClasses(payload, details.candidates, command.action === "CONFIRM");
    const status = command.action === "CONFIRM" ? "CONFIRMED" : "DRAFT";
    const id = previous?.id ?? randomUUID();
    const version = command.expectedVersion + 1;
    const values = [id, command.studentId, command.month, version, status, JSON.stringify(payload), actorUserId];
    const saved = previous
      ? await tx.$queryRawUnsafe<StoredRegister[]>(`UPDATE "MonthlyEnrollmentRegister"
          SET version = $4, status = $5, payload = $6::jsonb, "updatedBy" = $7, "updatedAt" = NOW(),
              "confirmedAt" = CASE WHEN $5 = 'CONFIRMED' THEN NOW() ELSE NULL END
          WHERE id = $1 AND "studentId" = $2 AND month = $3 AND version = $8
          RETURNING id, "studentId", month, version, status, payload, "updatedAt", "confirmedAt"`, ...values, command.expectedVersion)
      : await tx.$queryRawUnsafe<StoredRegister[]>(`INSERT INTO "MonthlyEnrollmentRegister"
          (id, "studentId", month, version, status, payload, "updatedBy", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
          RETURNING id, "studentId", month, version, status, payload, "updatedAt", "confirmedAt"`, ...values);
    if (saved.length !== 1) throw new MonthlyRegisterError("저장 상태가 변경됐습니다. 다시 조회해 주세요.", 409);
    await tx.$executeRawUnsafe(`INSERT INTO "MonthlyEnrollmentRegisterRevision"
      (id, "registerId", "studentId", month, version, status, payload, action, reason, "actorUserId")
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
    randomUUID(), id, command.studentId, command.month, version, status, JSON.stringify(payload), command.action, command.reason, actorUserId);
    return toRecord(saved[0]);
  });
}
