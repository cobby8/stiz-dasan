/**
 * 백업 «보관용 업무 자료» 순수 규칙 (2026-11-13 원장 지시 f12 — 학생·결제·출결까지 백업).
 *
 * 왜 «넣을 표 목록»이 아니라 «DB 의 전체 표 − 제외 목록»인가:
 *   표가 새로 생길 때마다 백업 목록에 추가하는 걸 잊으면, 그 표는 조용히 백업에서 빠진다.
 *   그래서 DB 에 실제로 있는 표(information_schema)를 전부 담고, 빼는 표만 이유와 함께 적는다.
 *   새 표는 아무것도 하지 않아도 자동으로 들어간다.
 *
 * 파일 두 개로 나눈다 (운영 실측: 업무 자료가 수십~수백 MB):
 *   - 설정 파일 `stiz-backup-<시각>.json` — 기존 그대로(설정 7개 표). 복원 3경로가 읽는 유일한 파일.
 *   - 업무 자료 파일 `stiz-archive-<시각>.json.gz` — gzip 압축. 복원 코드는 이 파일을 읽지 않는다(«보관용»).
 *     사고가 나면 사람이 파일을 풀어 필요한 줄만 골라 되살린다(자동 덮어쓰기 금지).
 *
 * 이 파일은 DB·Next 를 import 하지 않는다(테스트에서 그대로 실행). DB 연결부 = ./archive.ts
 */
import { gzipSync } from "node:zlib";

// 기존 복원 코드가 되살리는 설정 표 — 설정 파일에 이미 들어가므로 업무 자료 파일에 중복으로 넣지 않는다.
export const RESTORABLE_TABLES = [
    "AcademySettings",
    "Program",
    "Coach",
    "ClassSlotOverride",
    "CustomClassSlot",
    "Route",
    "Stop",
] as const;

// 백업에서 빼는 표 — 순수 캐시·재생성 가능한 가져오기 부산물·짧은 인증 세션·횟수 제한 로그·비밀값 표만.
// 업무 기록은 여기 넣지 않는다. 새로 넣을 때는 반드시 이유를 적는다(테스트가 빈 이유·스키마에 없는 이름을 막는다).
export const ARCHIVE_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
    _prisma_migrations: "Prisma 마이그레이션 관리 표 — prisma/migrations 파일로 다시 만든다",
    SheetSlotCache: "구글 시트 시간표 캐시 — 시트에서 다시 가져오면 된다",
    // 운영 실측 2026-11-13: 65,935줄/110MB. 학생 시트 가져오기(api/admin/import-students)가 시트 행을 rawJSON 으로 그대로 복사해 둔 원본.
    // 업무 결과(StudentRegistrationLedger·StudentShuttleRide 등)는 따로 백업된다. 그 표의 rawRowId 는 이 표를 가리키는 참조일 뿐이다.
    StudentSheetRawRow: "구글 시트 가져오기 원본 행 복사본 — 시트에서 다시 가져오면 된다(가져온 결과 표는 백업됨)",
    StudentSheetImportIssue: "구글 시트 가져오기 오류 기록 — 가져오기를 다시 돌리면 다시 생긴다",
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

// 이름만으로는 비밀이 아니지만 «그 표에서는» 접근 권한 역할을 하는 칸 — 표+칸으로 콕 집는다.
// (code 칸 전체를 가리면 SpecialProgramOffering.code 같은 분류용 코드까지 사라진다)
export const SECRET_COLUMNS_BY_TABLE: Readonly<Record<string, readonly string[]>> = {
    EnrollmentShortLink: ["code"], // 짧은 링크 코드 = 아는 사람은 신청 링크로 바로 들어간다
};

/** 이 표의 이 칸을 가려야 하나 — 이름 규칙 또는 표별 지정 목록 */
export function isSecretColumn(table: string, column: string): boolean {
    return isSecretColumnName(column) || (SECRET_COLUMNS_BY_TABLE[table]?.includes(column) ?? false);
}

/** 한 줄의 비밀 칸을 가린다 — 표별 지정 칸(맨 위 칸) + 이름 규칙(JSON 속 키까지) */
export function maskRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
    const out = maskSecretValues(row) as Record<string, unknown>;
    for (const column of SECRET_COLUMNS_BY_TABLE[table] ?? []) {
        if (out[column] !== null && out[column] !== undefined) out[column] = MASKED_VALUE;
    }
    return out;
}

/** 값 안의 비밀 칸을 가린다. JSON 칸(웹훅 원문·설정 JSON) 속 키도 재귀로 가린다. 원본은 바꾸지 않는다. */
export function maskSecretValues(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined || depth > 20) return value;
    if (Array.isArray(value)) return value.map((item) => maskSecretValues(item, depth + 1));
    if (typeof value !== "object") return value;
    // Date·Decimal 같은 객체는 JSON 변환(toJSON)에 맡긴다 — 평범한 객체만 열어본다.
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

/** bigint 를 숫자로 바꿔 JSON 으로 만든다(Postgres COUNT·BIGINT 칸). */
export function backupReplacer(_: string, v: unknown) {
    return typeof v === "bigint" ? Number(v) : v;
}

export type ArchiveQuery = (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;

export type ArchiveFailure = { table: string; reason: "LIST_FAILED" | "READ_FAILED" | "TIME_LIMIT" | "SIZE_LIMIT" };

export type BackupArchive = {
    version: 1;
    /** 자동 복원 안 함 — 파일 복원·클라우드 복원·seed 는 업무 자료 파일을 읽지 않는다 */
    restore: "MANUAL_ONLY";
    note: string;
    complete: boolean;
    /** 표별 gzip 조각 — 풀면 `"표이름":[줄,줄,…]`. 파일로 만들 때(packArchive) 이어 붙인다 */
    chunks: Record<string, Uint8Array>;
    rowCounts: Record<string, number>;
    /** 설정 파일에 따로 담기고 복원되는 설정 표 */
    restorableTables: string[];
    excluded: Record<string, string>;
    maskedColumns: Record<string, string[]>;
    failed: ArchiveFailure[];
};

// 운영 실측: 큰 표가 3~3.5만 줄 — 5000줄씩이면 표당 7번 안팎이다.
export const ARCHIVE_PAGE_SIZE = 5000;
// 백업 함수는 maxDuration 300초(vercel.json). 표 읽기에 200초, 나머지(압축·업로드·정리)에 여유를 둔다.
export const ARCHIVE_TIME_BUDGET_MS = 200_000;
// Supabase Storage 파일 한 개 상한(기본 50MB)보다 여유 있게 — 압축 후 크기 기준.
export const ARCHIVE_MAX_BYTES = 45 * 1024 * 1024;

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function gz(text: string): Uint8Array {
    return gzipSync(Buffer.from(text, "utf8"));
}

/**
 * DB 의 모든 표를 읽어 보관용 묶음을 만든다. 예외를 던지지 않는다 — 실패한 표는 failed 에 남기고
 * complete=false 로 표시한다(설정 백업까지 잃지 않게). 오류 원문은 남기지 않는다(연결정보·자료 노출 방지).
 * id 칸이 있는 표는 id 순서로 나눠 읽고, 한 번 읽을 때마다 바로 압축해 메모리에 큰 표를 통째로 올리지 않는다.
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
        note: "보관용 업무 자료 — 파일 복원·클라우드 복원·seed 는 이 파일을 되살리지 않는다. 필요한 줄만 사람이 확인해 되살린다.",
        complete: true,
        chunks: {},
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
        const masked = columns.filter((column) => isSecretColumn(table, column));
        if (masked.length > 0) archive.maskedColumns[table] = masked;
        try {
            // 표 하나 = gzip 조각 여러 개(머리 `"표":[` + 페이지마다 줄들 + 꼬리 `]`). gzip 은 이어 붙여도 하나로 풀린다.
            const parts: Uint8Array[] = [gz(`${JSON.stringify(table)}:[`)];
            let count = 0;
            const addPage = (page: Record<string, unknown>[]) => {
                if (page.length === 0) return;
                const text = page.map((row) => JSON.stringify(maskRow(table, row), backupReplacer)).join(",");
                parts.push(gz((count > 0 ? "," : "") + text));
                count += page.length;
            };
            const from = `SELECT * FROM ${quoteIdent(table)}`;
            if (columns.includes("id")) {
                // id 순서로 나눠 읽기 — 마지막 id 다음부터 이어 읽는다(OFFSET 보다 빠르고 줄이 밀리지 않는다).
                // id 를 text 로 바꿔 비교·정렬한다: id 가 uuid·int 인 표도 있어 `uuid > text` 오류가 나지 않게(검수 MED-2).
                let lastId: unknown = undefined;
                for (;;) {
                    if (now() > deadline) throw new Error("TIME_LIMIT");
                    const page = lastId === undefined
                        ? await query(`${from} ORDER BY "id"::text ASC LIMIT ${pageSize}`)
                        : await query(`${from} WHERE "id"::text > $1 ORDER BY "id"::text ASC LIMIT ${pageSize}`, lastId);
                    addPage(page);
                    if (page.length < pageSize) break;
                    lastId = String(page[page.length - 1].id);
                }
            } else {
                // id 가 없는 표(연결표 등)는 작다 — 한 번에 읽는다.
                addPage(await query(from));
            }
            parts.push(gz("]"));
            archive.chunks[table] = Buffer.concat(parts);
            archive.rowCounts[table] = count;
        } catch (error) {
            archive.complete = false;
            archive.failed.push({ table, reason: error instanceof Error && error.message === "TIME_LIMIT" ? "TIME_LIMIT" : "READ_FAILED" });
        }
    }
    return archive;
}

export type BackupArchiveSummary = { tables: number; rows: number; bytes: number; complete: boolean; failedTables: string[] };

/**
 * 업무 자료 파일(gzip)을 만든다. 압축 후 크기가 상한을 넘으면 «전체 비우기»가 아니라
 * 큰 표부터 하나씩 빼고(SIZE_LIMIT 로 기록) 나머지는 저장한다.
 * 풀면: {"version":1,…,"rowCounts":{…},"failed":[…],"tables":{"표":[…],…}}
 */
export function packArchive(
    archive: BackupArchive,
    meta: Record<string, unknown> = {},
    maxBytes = ARCHIVE_MAX_BYTES,
): { body: Buffer; summary: BackupArchiveSummary } {
    const sep = gz(",");
    const headerAllowance = 64 * 1024; // 머리말(행 수·제외 목록) 몫
    const stored = Object.keys(archive.chunks).sort();
    const sizeOf = (names: string[]) =>
        names.reduce((sum, name) => sum + archive.chunks[name].length + sep.length, headerAllowance);
    // 큰 표부터 빼기
    const bySizeDesc = [...stored].sort((a, b) => archive.chunks[b].length - archive.chunks[a].length);
    for (const name of bySizeDesc) {
        if (sizeOf(stored) <= maxBytes) break;
        stored.splice(stored.indexOf(name), 1);
        archive.complete = false;
        archive.failed.push({ table: name, reason: "SIZE_LIMIT" });
    }
    const header = {
        version: archive.version,
        restore: archive.restore,
        note: archive.note,
        ...meta,
        complete: archive.complete,
        storedTables: stored,
        rowCounts: archive.rowCounts,
        restorableTables: archive.restorableTables,
        excluded: archive.excluded,
        maskedColumns: archive.maskedColumns,
        failed: archive.failed,
    };
    const headerText = JSON.stringify(header, backupReplacer);
    const parts: Uint8Array[] = [gz(`${headerText.slice(0, -1)},"tables":{`)];
    stored.forEach((name, index) => {
        if (index > 0) parts.push(sep);
        parts.push(archive.chunks[name]);
    });
    parts.push(gz("}}"));
    const body = Buffer.concat(parts);
    return {
        body,
        summary: {
            tables: stored.length,
            rows: stored.reduce((sum, name) => sum + (archive.rowCounts[name] ?? 0), 0),
            bytes: body.length,
            complete: archive.complete,
            failedTables: archive.failed.map((f) => f.table),
        },
    };
}

/** 설정 파일 이름(stiz-backup-<시각>.json)과 같은 시각의 업무 자료 파일 이름 */
export function archiveFilenameFor(settingsFilename: string): string {
    return settingsFilename.replace(/^stiz-backup-/, "stiz-archive-").replace(/\.json$/, ".json.gz");
}

// 30일 정리·목록 구분에 쓰는 이름 규칙 — 설정 파일 / 업무 자료 파일
export const SETTINGS_BACKUP_NAME = /^stiz-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/;
export const ARCHIVE_BACKUP_NAME = /^stiz-archive-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json\.gz$/;
