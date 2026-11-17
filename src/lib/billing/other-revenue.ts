/**
 * 기타 매출(OtherRevenue) — 읽기·추가·수정·삭제(db 인자) + 월별 합계(통계용).
 *
 * 왜 있나(2026-11-17): 학교 스포츠클럽 강사료, 사이트 학생이 아닌 특강생 입금처럼 학생 청구서(Payment)가 없는
 *   수입을 적을 곳이 없었다. 원장이 /admin/other-revenue 에서 직접 적고, 통계 «수납» 탭에 따로 보인다.
 *   수강료 매출(Payment) 숫자에는 섞지 않는다.
 *
 * 권한: 원장(ADMIN)만. 권한 확인은 서버 동작(src/app/actions/other-revenue.ts)·화면(page.tsx)이 맡고 이 모듈은 DB 일만 한다.
 * DB: PgBouncer 라 $queryRawUnsafe/$executeRawUnsafe 만 쓴다.
 * 표가 아직 운영 DB 에 없으면(42P01) 읽기는 빈 목록·0원, 쓰기는 «준비 중» 안내로 버틴다.
 */
import {
    OtherRevenueError,
    otherRevenueMonthRange,
    validateOtherRevenueInput,
    type OtherRevenueCategory,
    type OtherRevenueInput,
    type OtherRevenueMethod,
} from "@/lib/billing/other-revenue-rules";

/** 기타 매출 한 건(화면·서버 동작이 주고받는 모양) */
export type OtherRevenueRow = {
    id: string;
    revenueDate: string;
    category: OtherRevenueCategory;
    title: string;
    amount: number;
    method: OtherRevenueMethod;
    note: string | null;
};

type Db = {
    $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/** 표가 아직 없는 DB(운영 적용 전)인가 — Postgres «표 없음» 오류(42P01) */
export function isMissingOtherRevenueTable(error: unknown): boolean {
    const text = error instanceof Error
        ? `${error.message} ${(error as { code?: string }).code ?? ""} ${(error as { meta?: { code?: string } }).meta?.code ?? ""}`
        : String(error);
    return /42P01|relation "OtherRevenue" does not exist/.test(text);
}

/** 표가 없을 때 쓰기에서 보이는 안내 */
export const OTHER_REVENUE_NOT_READY = "기능을 준비 중입니다. 잠시 후 다시 시도해 주세요.";

const SELECT_COLUMNS = `id,"revenueDate",category,title,amount,method,note`;

const toRow = (r: OtherRevenueRow): OtherRevenueRow => ({ ...r, amount: Number(r.amount) });

/** 그 달("YYYY-MM")의 기타 매출 목록(날짜 최근 순). 표가 없으면 빈 목록 + ready=false. */
export async function listOtherRevenue(db: Db, ym: string): Promise<{ ready: boolean; rows: OtherRevenueRow[] }> {
    const range = otherRevenueMonthRange(ym);
    if (!range) throw new OtherRevenueError("달을 다시 골라 주세요.");
    try {
        // 날짜는 "YYYY-MM-DD" 문자열이라 문자열 비교가 곧 날짜 비교다(시간대 개입 없음)
        const rows = await db.$queryRawUnsafe<OtherRevenueRow[]>(
            `SELECT ${SELECT_COLUMNS} FROM "OtherRevenue"
             WHERE "revenueDate" >= $1 AND "revenueDate" < $2
             ORDER BY "revenueDate" DESC, "createdAt" DESC, id
             LIMIT 500`,
            range.from, range.to);
        return { ready: true, rows: rows.map(toRow) };
    } catch (error) {
        if (isMissingOtherRevenueTable(error)) return { ready: false, rows: [] };
        throw error;
    }
}

/** 기타 매출 한 건 추가 */
export async function addOtherRevenue(db: Db, input: OtherRevenueInput, actorUserId: string): Promise<OtherRevenueRow> {
    const draft = validateOtherRevenueInput(input);
    if (!actorUserId) throw new OtherRevenueError("원장 확인이 필요합니다.");
    try {
        const rows = await db.$queryRawUnsafe<OtherRevenueRow[]>(
            `INSERT INTO "OtherRevenue" ("revenueDate",category,title,amount,method,note,"createdByUserId","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING ${SELECT_COLUMNS}`,
            draft.revenueDate, draft.category, draft.title, draft.amount, draft.method, draft.note, actorUserId);
        return toRow(rows[0]);
    } catch (error) {
        if (isMissingOtherRevenueTable(error)) throw new OtherRevenueError(OTHER_REVENUE_NOT_READY);
        throw error;
    }
}

/** 기타 매출 한 건 수정. 없으면 null(이미 지워짐). */
export async function updateOtherRevenue(db: Db, id: string, input: OtherRevenueInput): Promise<OtherRevenueRow | null> {
    if (!id) throw new OtherRevenueError("고칠 항목을 찾지 못했습니다.");
    const draft = validateOtherRevenueInput(input);
    try {
        const rows = await db.$queryRawUnsafe<OtherRevenueRow[]>(
            `UPDATE "OtherRevenue"
             SET "revenueDate"=$2, category=$3, title=$4, amount=$5, method=$6, note=$7, "updatedAt"=NOW()
             WHERE id=$1 RETURNING ${SELECT_COLUMNS}`,
            id, draft.revenueDate, draft.category, draft.title, draft.amount, draft.method, draft.note);
        return rows[0] ? toRow(rows[0]) : null;
    } catch (error) {
        if (isMissingOtherRevenueTable(error)) throw new OtherRevenueError(OTHER_REVENUE_NOT_READY);
        throw error;
    }
}

/** 기타 매출 한 건 삭제. 지운 행을 돌려준다(없으면 null) — 감사 기록에 무엇을 지웠는지 남기려고 */
export async function deleteOtherRevenue(db: Db, id: string): Promise<OtherRevenueRow | null> {
    if (!id) throw new OtherRevenueError("지울 항목을 찾지 못했습니다.");
    try {
        const rows = await db.$queryRawUnsafe<OtherRevenueRow[]>(
            `DELETE FROM "OtherRevenue" WHERE id=$1 RETURNING ${SELECT_COLUMNS}`, id);
        return rows[0] ? toRow(rows[0]) : null;
    } catch (error) {
        if (isMissingOtherRevenueTable(error)) throw new OtherRevenueError(OTHER_REVENUE_NOT_READY);
        throw error;
    }
}

/**
 * 통계용 — fromYm("YYYY-MM") 달부터 월별 기타 매출 합계·건수. 키 = "YYYY-MM".
 * 표가 없으면 빈 Map(= 모두 0원). 지점 구분이 없다(학생에 붙은 돈이 아니므로).
 */
export async function loadOtherRevenueMonthly(db: Db, fromYm: string): Promise<Map<string, { amount: number; count: number }>> {
    const range = otherRevenueMonthRange(fromYm);
    if (!range) return new Map();
    try {
        const rows = await db.$queryRawUnsafe<{ ym: string; amount: number | string; count: number }[]>(
            `SELECT LEFT("revenueDate", 7) AS ym, COALESCE(SUM(amount), 0)::bigint AS amount, COUNT(*)::int AS count
             FROM "OtherRevenue"
             WHERE "revenueDate" >= $1
             GROUP BY 1`,
            range.from);
        return new Map(rows.map((r) => [r.ym, { amount: Number(r.amount) || 0, count: Number(r.count) || 0 }]));
    } catch (error) {
        if (isMissingOtherRevenueTable(error)) return new Map();
        throw error;
    }
}
