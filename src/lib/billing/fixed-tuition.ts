/**
 * 학생별 고정 월 수강료(StudentFixedTuition) — 입력 확인(순수) + 읽기·저장·삭제(db 인자).
 *
 * 왜 있나(2026-11-16 원장 결정 — 결정표 x4):
 *   청구 준비는 등록 반마다 프로그램 요금을 더한다. 원장이 «매달 15만 원 고정»으로 정한 학생(서우빈 수7+토7)도
 *   반별 합산으로 계산돼 42만 원 같은 금액이 나왔다. 학생 상세 «청구/수납»에서 고정 금액을 켜 두면
 *   청구 준비(workbench-service → workbench-pricing.planWeeklyTuition)가 그 금액 1건으로 제안한다.
 *
 * 권한: 원장(ADMIN)만. 부원장은 금액·청구 준비·«청구/수납» 탭을 못 보므로(moneyAccess) 이 기능도 못 쓴다.
 *   권한 확인은 서버 동작(src/app/actions/fixed-tuition.ts)의 requireOwner 가 맡는다. 이 모듈은 DB 일만 한다.
 * DB: PgBouncer 라 $queryRawUnsafe/$executeRawUnsafe 만 쓴다.
 */
import { randomUUID } from "node:crypto";
// 흡수(병합)된 학생에는 고정 수강료를 새로 걸지 않는다 — 학생 조회 공용 필터
import { notMergedStudent } from "@/lib/studentVisibility";

/** 고정 수강료 한 건(화면·서버 동작이 주고받는 모양) */
export type FixedTuitionRow = {
    id: string;
    studentId: string;
    amount: number;
    startMonth: string;
    endMonth: string | null;
    memo: string | null;
    createdAt: string;
};

/** 저장 입력(화면에서 받은 값 — 확인 전) */
export type FixedTuitionInput = { studentId: unknown; amount: unknown; startMonth: unknown; endMonth?: unknown; memo?: unknown };

/** 확인을 통과한 저장 값 */
export type FixedTuitionDraft = { studentId: string; amount: number; startMonth: string; endMonth: string | null; memo: string | null };

/** 금액 상한(DB CHECK 와 같은 값) — 오타로 0 을 하나 더 붙이는 일을 막는다 */
export const FIXED_TUITION_MAX_AMOUNT = 10_000_000;
/** 메모 최대 글자 수(DB CHECK 와 같은 값) */
export const FIXED_TUITION_MEMO_MAX = 200;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class FixedTuitionError extends Error {}

/** 화면 입력을 확인해 저장 값으로 바꾼다. 틀리면 원장이 읽을 수 있는 문장으로 던진다. */
export function validateFixedTuitionInput(input: FixedTuitionInput): FixedTuitionDraft {
    const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
    if (!studentId) throw new FixedTuitionError("학생을 찾지 못했습니다. 화면을 새로고침해 주세요.");
    // 금액: «150,000» 처럼 쉼표가 섞여 와도 받는다. 정수·0 이상·상한 이하만.
    const amount = typeof input.amount === "number" ? input.amount : Number(String(input.amount ?? "").replace(/[,\s원]/g, ""));
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > FIXED_TUITION_MAX_AMOUNT) {
        throw new FixedTuitionError(`월 수강료는 0원부터 ${FIXED_TUITION_MAX_AMOUNT.toLocaleString("ko-KR")}원까지 원 단위 숫자로 적어 주세요.`);
    }
    const startMonth = typeof input.startMonth === "string" ? input.startMonth.trim() : "";
    if (!MONTH_RE.test(startMonth)) throw new FixedTuitionError("시작 달을 골라 주세요.");
    const endRaw = typeof input.endMonth === "string" ? input.endMonth.trim() : "";
    const endMonth = endRaw ? endRaw : null;
    if (endMonth !== null && !MONTH_RE.test(endMonth)) throw new FixedTuitionError("끝 달 형식이 올바르지 않습니다.");
    if (endMonth !== null && endMonth < startMonth) throw new FixedTuitionError("끝 달은 시작 달과 같거나 뒤여야 합니다.");
    const memoRaw = typeof input.memo === "string" ? input.memo.trim() : "";
    if (memoRaw.length > FIXED_TUITION_MEMO_MAX) throw new FixedTuitionError(`메모는 ${FIXED_TUITION_MEMO_MAX}자까지 적을 수 있습니다.`);
    return { studentId, amount, startMonth, endMonth, memo: memoRaw || null };
}

/** 두 기간(끝 없음 = 무한)이 한 달이라도 겹치는가 */
export function fixedTuitionOverlaps(a: { startMonth: string; endMonth: string | null }, b: { startMonth: string; endMonth: string | null }): boolean {
    const aEndsBeforeB = a.endMonth !== null && a.endMonth < b.startMonth;
    const bEndsBeforeA = b.endMonth !== null && b.endMonth < a.startMonth;
    return !aEndsBeforeB && !bEndsBeforeA;
}

type Db = {
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};
type TxDb = Db & { $transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> };

/** 표가 아직 없는 DB(운영 적용 전)인가 — Postgres «표 없음» 오류(42P01) */
const isMissingTable = (error: unknown) => {
    const text = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""} ${(error as { meta?: { code?: string } }).meta?.code ?? ""}` : String(error);
    return /42P01|does not exist/.test(text);
};

const SELECT_COLUMNS = `id,"studentId",amount,"startMonth","endMonth",memo,to_char("createdAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS "createdAt"`;

/** 그 학생의 고정 수강료 목록(최근 시작 달 먼저). 표가 없으면 빈 목록 + ready=false. */
export async function listFixedTuition(db: Db, studentId: string): Promise<{ ready: boolean; rows: FixedTuitionRow[] }> {
    try {
        const rows = await db.$queryRawUnsafe<FixedTuitionRow[]>(
            `SELECT ${SELECT_COLUMNS} FROM "StudentFixedTuition" WHERE "studentId"=$1 ORDER BY "startMonth" DESC, "createdAt" DESC, id LIMIT 50`, studentId);
        return { ready: true, rows: rows.map(r => ({ ...r, amount: Number(r.amount) })) };
    } catch (error) {
        if (isMissingTable(error)) return { ready: false, rows: [] };
        throw error;
    }
}

/**
 * 고정 수강료 한 건 추가. 같은 학생의 다른 기간과 겹치면 거절한다(바꾸려면 기존 것을 지우고 다시 추가).
 * 학생 행을 잠가서(FOR UPDATE) 두 창에서 동시에 저장해도 겹치지 않게 한다.
 */
export async function addFixedTuition(db: TxDb, input: FixedTuitionInput, actorUserId: string): Promise<FixedTuitionRow> {
    const draft = validateFixedTuitionInput(input);
    if (!actorUserId) throw new FixedTuitionError("원장 확인이 필요합니다.");
    return db.$transaction(async tx => {
        const student = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT s.id FROM "Student" s WHERE s.id=$1 AND ${notMergedStudent("s")} FOR UPDATE`, draft.studentId);
        if (!student.length) throw new FixedTuitionError("학생을 찾지 못했습니다. 화면을 새로고침해 주세요.");
        const existing = await tx.$queryRawUnsafe<Array<{ startMonth: string; endMonth: string | null }>>(
            `SELECT "startMonth","endMonth" FROM "StudentFixedTuition" WHERE "studentId"=$1`, draft.studentId);
        const clash = existing.find(row => fixedTuitionOverlaps(row, draft));
        if (clash) {
            throw new FixedTuitionError(`이미 ${clash.startMonth}~${clash.endMonth ?? "끝 없음"} 고정 수강료가 있어 기간이 겹칩니다. 기존 것을 지우거나 기간을 바꿔 주세요.`);
        }
        const id = randomUUID();
        const rows = await tx.$queryRawUnsafe<FixedTuitionRow[]>(
            `INSERT INTO "StudentFixedTuition" (id,"studentId",amount,"startMonth","endMonth",memo,"actorUserId","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING ${SELECT_COLUMNS}`,
            id, draft.studentId, draft.amount, draft.startMonth, draft.endMonth, draft.memo, actorUserId);
        return { ...rows[0], amount: Number(rows[0].amount) };
    });
}

/** 고정 수강료 한 건 삭제(그 학생 것만 — 다른 학생 id 로 지우지 못하게 둘 다 맞춘다). 지운 건수를 돌려준다. */
export async function deleteFixedTuition(db: Db, id: string, studentId: string): Promise<number> {
    if (!id || !studentId) throw new FixedTuitionError("지울 항목을 찾지 못했습니다.");
    return db.$executeRawUnsafe(`DELETE FROM "StudentFixedTuition" WHERE id=$1 AND "studentId"=$2`, id, studentId);
}
