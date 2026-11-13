/**
 * 백업 «보관용 업무 자료» 순수 규칙 (2026-11-13 원장 지시 f12 — 학생·결제·출결까지 백업).
 *
 * 왜 «넣을 표 목록»이 아니라 «DB 의 전체 표 − 제외 목록»인가:
 *   표가 새로 생길 때마다 백업 목록에 추가하는 걸 잊으면, 그 표는 조용히 백업에서 빠진다.
 *   그래서 DB 에 실제로 있는 표(information_schema)를 전부 담고, 빼는 표만 이유와 함께 적는다.
 *   새 표는 아무것도 하지 않아도 자동으로 들어간다.
 *
 * 복원과의 관계 (위험해서 범위를 넓히지 않는다):
 *   파일 복원·클라우드 복원·seed 는 기존대로 설정 7개 표(RESTORABLE_TABLES)만 되살린다.
 *   여기서 모은 표는 백업 파일의 `archive` 칸에만 들어가는 «보관용»이다 — 복원 코드는 이 칸을 읽지 않는다.
 *   사고가 나면 사람이 파일을 열어 필요한 줄만 골라 되살린다(자동 덮어쓰기 금지).
 *
 * 이 파일은 DB·Next 를 import 하지 않는다(테스트에서 그대로 실행). DB 연결부 = ./archive.ts
 */

// 기존 복원 코드가 되살리는 설정 표 — 백업 파일의 기존 칸(programs·coaches 등)에 이미 들어가므로 archive 에 중복으로 넣지 않는다.
export const RESTORABLE_TABLES = [
    "AcademySettings",
    "Program",
    "Coach",
    "ClassSlotOverride",
    "CustomClassSlot",
    "Route",
    "Stop",
] as const;

// 백업에서 빼는 표 — 순수 캐시·짧은 인증 세션·횟수 제한 로그·비밀값 표만. 업무 기록은 여기 넣지 않는다.
// 새로 넣을 때는 반드시 이유를 적는다(테스트가 빈 이유와 스키마에 없는 표 이름을 막는다).
export const ARCHIVE_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
    _prisma_migrations: "Prisma 마이그레이션 관리 표 — prisma/migrations 파일로 다시 만든다",
    SheetSlotCache: "구글 시트 시간표 캐시 — 시트에서 다시 가져오면 된다",
    PushSubscription: "브라우저 푸시 구독 키(비밀값) — 앱을 다시 열면 재구독된다",
    DriverLocation: "기사 실시간 위치 한 칸 덮어쓰기 — 기록이 아니고 위치 개인정보다",
    ParentSignupOtpSend: "가입 인증번호 발송 횟수 제한 로그",
    ParentAccountClaimOtpSend: "계정 연결 인증번호 발송 횟수 제한 로그",
    ParentPasswordResetOtpSend: "비밀번호 찾기 인증번호 발송 횟수 제한 로그",
    StaffInvitationOtpSend: "직원 초대 인증번호 발송 횟수 제한 로그",
    StaffPhoneVerificationSend: "직원 휴대폰 인증 발송 횟수 제한 로그",
    StaffInvitationAuthAttempt: "직원 초대 로그인 시도 횟수 제한 로그",
    ParentPasswordReset: "비밀번호 찾기 진행 중 세션(짧은 수명·인증값)",
    StaffPhoneVerification: "직원 휴대폰 인증 진행 중 세션(짧은 수명·인증값)",
    ChildIdentityChallenge: "자녀 연결 본인확인 진행 중 세션(짧은 수명·인증값)",
};

export type BackupTableKind = "restore" | "archive" | "exclude";

/** 표 하나가 백업에서 어떻게 다뤄지는지 — 복원 대상 / 보관용 / 제외. 모르는 표는 «보관용»(자동 포함). */
export function classifyBackupTable(table: string): BackupTableKind {
    if ((RESTORABLE_TABLES as readonly string[]).includes(table)) return "restore";
    if (Object.hasOwn(ARCHIVE_EXCLUDED_TABLES, table)) return "exclude";
    return "archive";
}

// 비밀값 칸 이름 — 토큰·해시·비밀번호·키. 칸 이름(그리고 JSON 안의 키 이름)이 맞으면 값을 가린다.
// 해시도 가린다: 전화번호 해시는 대입으로 되돌릴 수 있고, 보관용 파일에서 쓸 일이 없다.
// 결제 키(paymentKey)는 환불·대조 증빙이라 남긴다 — 토스 비밀키 없이는 쓸 수 없다.
const SECRET_NAME = /(hash$|token$|secret|password|passwd|apikey|api_key|accesskey|access_key|privatekey|private_key|credential|billingkey|billing_key|authorization|^p256dh$|^auth$)/i;

export const MASKED_VALUE = "[가림]";

export function isSecretColumnName(name: string): boolean {
    return SECRET_NAME.test(name);
}

/** 값 안의 비밀 칸을 가린다. JSON 칸(웹훅 원문·설정 JSON) 속 키도 재귀로 가린다. 원본은 바꾸지 않는다. */
export function maskSecretValues(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined || depth > 20) return value;
    if (Array.isArray(value)) return value.map((item) => maskSecretValues(item, depth + 1));
    // Date·Decimal 같은 객체는 JSON 변환(toJSON)에 맡긴다 — 평범한 객체만 열어본다.
    if (typeof value !== "object") return value;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSecretColumnName(key)
            ? (inner === null || inner === undefined ? inner : MASKED_VALUE)
            : maskSecretValues(inner, depth + 1);
    }
    return out;
}

export type ArchiveQuery = (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

export type BackupArchive = {
    version: 1;
    /** 자동 복원 안 함 — 파일 복원·클라우드 복원·seed 는 이 칸을 읽지 않는다 */
    restore: "MANUAL_ONLY";
    note: string;
    complete: boolean;
    tables: Record<string, Record<string, unknown>[]>;
    rowCounts: Record<string, number>;
    /** 기존 칸(programs 등)으로 따로 담기고 복원되는 설정 표 */
    restorableTables: string[];
    excluded: Record<string, string>;
    maskedColumns: Record<string, string[]>;
    failed: { table: string; reason: "LIST_FAILED" | "READ_FAILED" | "TIME_LIMIT" | "SIZE_LIMIT" }[];
};

export const ARCHIVE_PAGE_SIZE = 2000;
// Vercel 함수 60초 안에 설정 조회·업로드·정리까지 끝나야 한다 — 표 읽기에는 35초만 쓴다.
export const ARCHIVE_TIME_BUDGET_MS = 35_000;
// Supabase Storage 파일 한 개 상한(기본 50MB)보다 여유 있게.
export const BACKUP_MAX_BYTES = 45 * 1024 * 1024;
// 브라우저 다운로드는 Vercel 함수 응답 상한(4.5MB) 안이어야 한다 — 넘으면 보관용 표 내용은 빼고 설정만 내려준다.
// 전체 업무 자료 사본은 클라우드 백업(자동·«지금 저장»)에 있다.
export const DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024;

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * DB 의 모든 표를 읽어 보관용 묶음을 만든다. 예외를 던지지 않는다 — 실패한 표는 failed 에 남기고
 * complete=false 로 표시한다(설정 백업까지 잃지 않게). 오류 원문은 남기지 않는다(연결정보·자료 노출 방지).
 * id 칸이 있는 표는 id 순서로 나눠 읽는다(한 번에 큰 표를 통째로 메모리에 올리지 않게).
 */
export async function collectArchive(
    query: ArchiveQuery,
    options: { pageSize?: number; timeBudgetMs?: number; now?: () => number } = {},
): Promise<BackupArchive> {
    const pageSize = options.pageSize ?? ARCHIVE_PAGE_SIZE;
    const now = options.now ?? Date.now;
    const deadline = now() + (options.timeBudgetMs ?? ARCHIVE_TIME_BUDGET_MS);
    const archive: BackupArchive = {
        version: 1,
        restore: "MANUAL_ONLY",
        note: "보관용 업무 자료 — 파일 복원·클라우드 복원·seed 는 이 칸을 되살리지 않는다. 필요한 줄만 사람이 확인해 되살린다.",
        complete: true,
        tables: {},
        rowCounts: {},
        restorableTables: [...RESTORABLE_TABLES],
        excluded: {},
        maskedColumns: {},
        failed: [],
    };

    let columnsByTable: Map<string, string[]>;
    try {
        const tableRows = await query(
            `SELECT table_name AS "tableName" FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
        );
        const columnRows = await query(
            `SELECT table_name AS "tableName", column_name AS "columnName" FROM information_schema.columns
             WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
        );
        columnsByTable = new Map(tableRows.map((row) => [String(row.tableName), [] as string[]]));
        for (const row of columnRows) columnsByTable.get(String(row.tableName))?.push(String(row.columnName));
    } catch {
        archive.complete = false;
        archive.failed.push({ table: "*", reason: "LIST_FAILED" });
        return archive;
    }

    for (const [table, columns] of columnsByTable) {
        const kind = classifyBackupTable(table);
        if (kind === "restore") continue;
        if (kind === "exclude") {
            archive.excluded[table] = ARCHIVE_EXCLUDED_TABLES[table];
            continue;
        }
        if (now() > deadline) {
            archive.complete = false;
            archive.failed.push({ table, reason: "TIME_LIMIT" });
            continue;
        }
        const masked = columns.filter(isSecretColumnName);
        if (masked.length > 0) archive.maskedColumns[table] = masked;
        try {
            const rows: Record<string, unknown>[] = [];
            const from = `SELECT * FROM ${quoteIdent(table)}`;
            if (columns.includes("id")) {
                // id 순서로 나눠 읽기 — 마지막 id 다음부터 이어 읽는다(OFFSET 보다 빠르고 줄이 밀리지 않는다).
                let lastId: unknown = undefined;
                for (;;) {
                    if (now() > deadline) throw new Error("TIME_LIMIT");
                    const page = lastId === undefined
                        ? await query(`${from} ORDER BY "id" ASC LIMIT ${pageSize}`)
                        : await query(`${from} WHERE "id" > $1 ORDER BY "id" ASC LIMIT ${pageSize}`, lastId);
                    rows.push(...page);
                    if (page.length < pageSize) break;
                    lastId = page[page.length - 1].id;
                }
            } else {
                // id 가 없는 표(연결표 등)는 작다 — 한 번에 읽는다.
                rows.push(...(await query(from)));
            }
            archive.tables[table] = rows.map((row) => maskSecretValues(row) as Record<string, unknown>);
            archive.rowCounts[table] = rows.length;
        } catch (error) {
            archive.complete = false;
            archive.failed.push({ table, reason: error instanceof Error && error.message === "TIME_LIMIT" ? "TIME_LIMIT" : "READ_FAILED" });
        }
    }
    return archive;
}

function replacer(_: string, v: unknown) {
    return typeof v === "bigint" ? Number(v) : v;
}

export type BackupArchiveSummary = { tables: number; rows: number; complete: boolean; failedTables: string[] };

export function summarizeArchive(archive: BackupArchive | null | undefined): BackupArchiveSummary {
    if (!archive) return { tables: 0, rows: 0, complete: false, failedTables: [] };
    // 실제로 파일에 담긴 표·행만 센다(크기 초과로 비운 경우 0 이 된다).
    const stored = Object.values(archive.tables);
    return {
        tables: stored.length,
        rows: stored.reduce((sum, rows) => sum + rows.length, 0),
        complete: archive.complete,
        failedTables: archive.failed.map((f) => f.table),
    };
}

/**
 * 백업 객체를 JSON 문자열로 만든다. 크기가 상한을 넘으면 보관용 표 내용만 비우고(행 수·제외 목록은 남김)
 * 설정 부분은 그대로 저장한다 — 큰 표 때문에 설정 백업까지 실패하지 않게. 공백 없는 JSON 으로 크기를 줄인다.
 */
export function serializeBackup(
    snapshot: Record<string, unknown> & { archive?: BackupArchive },
    maxBytes = BACKUP_MAX_BYTES,
): { body: string; summary: BackupArchiveSummary } {
    let body = JSON.stringify(snapshot, replacer);
    const archive = snapshot.archive;
    if (archive && Buffer.byteLength(body, "utf8") > maxBytes) {
        archive.tables = {};
        archive.complete = false;
        archive.failed.push({ table: "*", reason: "SIZE_LIMIT" });
        body = JSON.stringify(snapshot, replacer);
    }
    return { body, summary: summarizeArchive(archive) };
}
