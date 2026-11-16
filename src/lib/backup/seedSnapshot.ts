/**
 * 핵심 데이터(seed) 스냅샷 — 프로그램·수업 칸 설정·이용약관.
 *
 * 왜 있는가(2026-11-16 원장 지시): 예전에는 원장이 «seed 내보내기»로 받은 파일을
 * prisma/seed-data.ts 에 덮어쓰고 커밋해야 «seed 복구»가 최신이 됐다. 사람이 잊으면 복구 자료가 낡는다.
 * → 매일 도는 백업(cron)이 같은 실행에서 이 스냅샷을 Storage 에 저장하고, 복구가 그 최신본을 먼저 쓴다.
 *
 * 이 파일은 다른 모듈을 가져오지 않는다(테스트에서 그대로 불러 쓰려고).
 *   - 날짜는 호출하는 쪽이 `@/lib/datetime/kst` 로 만들어 «YYYY-MM-DD» 글자로 넘긴다.
 *   - Storage 는 호출하는 쪽이 `supabase.storage.from("backups")` 를 넘긴다.
 *
 * 범위는 예전 export-seed 와 같다 — 학생·학부모 자료나 비밀값은 담지 않는다(칸을 하나씩 골라 담는다).
 */

/** 백업 버킷 안의 폴더 이름. 버킷 맨 위 목록에는 이 이름의 «폴더 칸»이 보인다(파일 아님). */
export const SEED_DIR = "seed";
export const SEED_LATEST_NAME = "seed-latest.json";
/** 복구가 읽는 최신본 — 매일 덮어쓴다. */
export const SEED_LATEST_PATH = `${SEED_DIR}/${SEED_LATEST_NAME}`;
/** 날짜별 사본 이름(seed-2026-11-16.json). 하루에 한 개 — 같은 날 다시 저장하면 덮어쓴다. */
export const SEED_DATED_NAME = /^seed-(\d{4}-\d{2}-\d{2})\.json$/;
/** 날짜별 사본 보관 기간 — 기존 백업과 같은 30일. */
export const SEED_KEEP_DAYS = 30;
/** 표에 붙는 이름(보고·응답용). */
export const SEED_TABLES = ["Program", "ClassSlotOverride", "AcademySettings.termsOfService"] as const;

export interface SeedProgram {
    id: string;
    name: string;
    targetAge: string | null;
    description: string | null;
    days: string | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    order: number;
    // 아래 다섯 칸(2026-11-16 검수 반영)은 «새로 넣는 줄»에만 쓴다 — 이미 있는 줄은 복구가 건드리지 않는다.
    // 없으면 숨긴 프로그램이 되살아나거나(deletedAt) 셔틀 운행 값이 기본 true 로 돌아간다(runsShuttle).
    frequency: string | null;
    weeklyFrequency: string | null;
    imageUrl: string | null;
    runsShuttle: boolean;
    /** 숨긴 시각(ISO 글자). 숨기지 않았으면 null. */
    deletedAt: string | null;
}

export interface SeedSlotOverride {
    id: string;
    slotKey: string;
    label: string | null;
    note: string | null;
    isHidden: boolean;
    capacity: number;
    startTimeOverride: string | null;
    endTimeOverride: string | null;
    coachId: string | null;
    programId: string | null;
}

export interface SeedSnapshot {
    _meta: {
        kind: "SEED_SNAPSHOT";
        version: 1;
        /** 만든 시각(ISO, UTC 기준 글자) */
        exportedAt: string;
        /** cron(매일 자동) · manual(«전체 백업 지금 저장») · export(수동 내려받기) */
        source: string;
        tables: readonly string[];
    };
    programs: SeedProgram[];
    classSlotOverrides: SeedSlotOverride[];
    termsOfService: string | null;
}

type Row = Record<string, unknown>;

// DB 드라이버에 따라 칸 이름이 소문자로 올 때가 있어 둘 다 본다(예전 export-seed 와 같은 방식).
function col(row: Row, name: string): unknown {
    return row[name] ?? row[name.toLowerCase()];
}
function text(v: unknown): string | null {
    return v == null ? null : String(v);
}
function num(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

// DB 에서는 Date 로, 파일에서는 글자로 온다. 읽을 수 없는 값은 null(숨김 아님)로 둔다.
function isoOrNull(v: unknown): string | null {
    if (v == null) return null;
    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toProgram(row: Row): SeedProgram {
    return {
        id: String(col(row, "id") ?? ""),
        name: String(col(row, "name") ?? ""),
        targetAge: text(col(row, "targetAge")),
        description: text(col(row, "description")),
        days: text(col(row, "days")),
        priceWeek1: num(col(row, "priceWeek1")),
        priceWeek2: num(col(row, "priceWeek2")),
        priceWeek3: num(col(row, "priceWeek3")),
        priceDaily: num(col(row, "priceDaily")),
        shuttleFeeOverride: num(col(row, "shuttleFeeOverride")),
        order: num(col(row, "order")) ?? 0,
        // 옛 모양 스냅샷(이 칸이 없는 파일)은 기본값 — 숨김 아님·셔틀 운행(DB 기본값과 같다)
        frequency: text(col(row, "frequency")),
        weeklyFrequency: text(col(row, "weeklyFrequency")),
        imageUrl: text(col(row, "imageUrl")),
        runsShuttle: col(row, "runsShuttle") !== false,
        deletedAt: isoOrNull(col(row, "deletedAt")),
    };
}

function toSlot(row: Row): SeedSlotOverride {
    return {
        id: String(col(row, "id") ?? ""),
        slotKey: String(col(row, "slotKey") ?? ""),
        label: text(col(row, "label")),
        note: text(col(row, "note")),
        isHidden: col(row, "isHidden") === true,
        capacity: num(col(row, "capacity")) ?? 12,
        startTimeOverride: text(col(row, "startTimeOverride")),
        endTimeOverride: text(col(row, "endTimeOverride")),
        coachId: text(col(row, "coachId")),
        programId: text(col(row, "programId")),
    };
}

/**
 * DB 에서 읽은 줄을 스냅샷 모양으로 만든다.
 * `SELECT *` 로 읽은 줄을 넘겨도 여기 적힌 칸만 남는다(다른 칸은 버린다).
 */
export function buildSeedSnapshot(
    input: { programRows: Row[]; slotRows: Row[]; termsOfService: unknown },
    meta: { exportedAt: string; source: string },
): SeedSnapshot {
    return {
        _meta: { kind: "SEED_SNAPSHOT", version: 1, exportedAt: meta.exportedAt, source: meta.source, tables: SEED_TABLES },
        programs: input.programRows.map(toProgram),
        classSlotOverrides: input.slotRows.map(toSlot),
        termsOfService: typeof input.termsOfService === "string" ? input.termsOfService : null,
    };
}

export type SeedValidation = { ok: true; snapshot: SeedSnapshot } | { ok: false; reason: string };

function isObject(v: unknown): v is Row {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): boolean {
    return typeof v === "string" && v.trim().length > 0;
}
function numberOrNull(v: unknown): boolean {
    return v === null || (typeof v === "number" && Number.isFinite(v));
}

/**
 * 스냅샷 모양 검사 — 저장하기 전과 복구에 쓰기 전에 둘 다 거친다.
 *
 * 프로그램이 0줄이면 쓰지 않는다:
 *   - 저장할 때: DB 가 비어 버린 날 밤에 «빈 스냅샷»이 최신본을 덮어쓰지 않게(마지막 정상본을 지킨다).
 *   - 복구할 때: 빈 자료로 «복구했다»고 답하지 않게(seed-data.ts 로 넘어간다).
 * 통과하면 정해진 칸만 다시 골라 담은 스냅샷을 돌려준다(모르는 칸은 버린다).
 */
export function validateSeedSnapshot(value: unknown): SeedValidation {
    if (!isObject(value)) return { ok: false, reason: "NOT_OBJECT" };
    const meta = value._meta;
    if (!isObject(meta) || meta.kind !== "SEED_SNAPSHOT" || meta.version !== 1) return { ok: false, reason: "BAD_META" };
    if (typeof meta.exportedAt !== "string" || Number.isNaN(Date.parse(meta.exportedAt))) return { ok: false, reason: "BAD_EXPORTED_AT" };
    if (!Array.isArray(value.programs)) return { ok: false, reason: "PROGRAMS_NOT_ARRAY" };
    if (!Array.isArray(value.classSlotOverrides)) return { ok: false, reason: "SLOTS_NOT_ARRAY" };
    if (value.termsOfService !== null && typeof value.termsOfService !== "string") return { ok: false, reason: "BAD_TERMS" };
    if (value.programs.length === 0) return { ok: false, reason: "NO_PROGRAMS" };

    for (const p of value.programs) {
        if (!isObject(p) || !nonEmptyString(p.id) || !nonEmptyString(p.name)) return { ok: false, reason: "BAD_PROGRAM_ROW" };
        // 가격 칸은 «있어야» 한다(값은 숫자 또는 null) — 칸이 아예 없는 줄은 스냅샷이 아닌 다른 파일이다.
        for (const key of ["priceWeek1", "priceWeek2", "priceWeek3", "priceDaily", "shuttleFeeOverride"]) {
            if (!(key in p) || !numberOrNull(p[key])) return { ok: false, reason: "BAD_PROGRAM_ROW" };
        }
        // 나중에 생긴 칸은 없어도 된다(옛 모양 스냅샷). 있으면 모양만 본다.
        for (const key of ["frequency", "weeklyFrequency", "imageUrl", "deletedAt"]) {
            if (p[key] != null && typeof p[key] !== "string") return { ok: false, reason: "BAD_PROGRAM_ROW" };
        }
        if (p.runsShuttle != null && typeof p.runsShuttle !== "boolean") return { ok: false, reason: "BAD_PROGRAM_ROW" };
        if (typeof p.deletedAt === "string" && Number.isNaN(Date.parse(p.deletedAt))) return { ok: false, reason: "BAD_PROGRAM_ROW" };
    }
    for (const s of value.classSlotOverrides) {
        if (!isObject(s) || !nonEmptyString(s.id) || !nonEmptyString(s.slotKey)) return { ok: false, reason: "BAD_SLOT_ROW" };
    }

    return {
        ok: true,
        snapshot: buildSeedSnapshot(
            { programRows: value.programs as Row[], slotRows: value.classSlotOverrides as Row[], termsOfService: value.termsOfService },
            { exportedAt: meta.exportedAt, source: typeof meta.source === "string" ? meta.source : "unknown" },
        ),
    };
}

/** 날짜별 사본 이름 — ymd 는 KST «YYYY-MM-DD». */
export function seedDatedName(ymd: string): string {
    return `seed-${ymd}.json`;
}

/**
 * 지울 날짜별 사본 고르기 — 이름의 날짜가 cutoffYmd 보다 «앞»인 것만.
 * 이름 규칙에 안 맞는 파일(최신본 seed-latest.json 포함)은 절대 고르지 않는다.
 */
export function expiredSeedNames(names: string[], cutoffYmd: string): string[] {
    return names.filter((name) => {
        const match = SEED_DATED_NAME.exec(name);
        return match !== null && match[1] < cutoffYmd;
    });
}

/**
 * 가장 최근 날짜별 사본 — «마지막으로 저장된 때»를 판정하는 기준(대시보드·점검 봇).
 * 최신본(seed-latest.json)의 «고친 시각»은 덮어쓰기 때 안 바뀔 수 있어 믿지 않는다.
 * 날짜는 파일 이름에서 읽는다. createdAt 은 있으면 같이 돌려준다(없으면 null).
 */
export function latestSeedDated(
    files: { name: string; created_at?: string | null }[],
): { name: string; ymd: string; createdAt: string | null } | null {
    let best: { name: string; ymd: string; createdAt: string | null } | null = null;
    for (const f of files) {
        const match = SEED_DATED_NAME.exec(f.name);
        if (!match) continue;
        if (!best || match[1] > best.ymd) {
            const createdAt = typeof f.created_at === "string" && !Number.isNaN(Date.parse(f.created_at)) ? f.created_at : null;
            best = { name: f.name, ymd: match[1], createdAt };
        }
    }
    return best;
}

/** 이 모듈이 쓰는 Storage 기능만 적은 모양 — `supabase.storage.from("backups")` 가 그대로 들어맞는다. */
export interface SeedBucket {
    upload(path: string, body: string, options: { contentType: string; upsert: boolean }): Promise<{ error: unknown }>;
    download(path: string): Promise<{ data: { text(): Promise<string> } | null; error: unknown }>;
    list(path: string, options?: { limit?: number }): Promise<{ data: { name: string }[] | null; error: unknown }>;
    remove(paths: string[]): Promise<{ data: { name: string }[] | null; error: unknown }>;
}

export interface SeedSaveResult {
    /** 최신본(seed-latest.json)이 저장됐는가 */
    saved: boolean;
    /** 저장하지 못한 이유(코드). 원문 오류는 담지 않는다 — 연결정보가 섞일 수 있다. */
    reason: string | null;
    latestPath: string;
    datedPath: string | null;
    datedSaved: boolean;
    programs: number;
    classSlotOverrides: number;
    /** 직전 최신본의 프로그램 수(읽지 못했으면 null) — 급감 판정에 쓴 값 */
    previousPrograms: number | null;
    /** 30일 정리에서 Storage 가 «실제로 지웠다»고 답한 파일 이름 */
    deleted: string[];
    /** 30일 정리를 끝내지 못했는가(목록·삭제 실패, 일부만 삭제) — 저장 결과와는 무관 */
    cleanupFailed: boolean;
}

/**
 * 프로그램 수가 직전 최신본의 «절반 미만»으로 줄었는가.
 * 그렇다면 자료가 일부 사라진 것일 수 있어 최신본을 덮어쓰지 않는다(날짜별 사본만 남긴다).
 */
export function isSeedShrunk(previousPrograms: number, currentPrograms: number): boolean {
    return currentPrograms * 2 < previousPrograms;
}

/**
 * 스냅샷을 Storage 에 저장한다 — 날짜별 사본 → 30일 지난 사본 정리 → 급감 확인 → 최신본(덮어쓰기).
 *
 * 절대 예외를 던지지 않는다. 본 백업과 서로 영향을 주지 않게 하려는 것(실패는 결과 값으로만 알린다).
 * getBucket 을 함수로 받는 이유: Storage 클라이언트를 만드는 것 자체가 실패해도 여기서 잡으려고.
 */
export async function saveSeedSnapshot(
    getBucket: () => SeedBucket,
    snapshot: SeedSnapshot,
    dates: { todayYmd: string; cutoffYmd: string },
): Promise<SeedSaveResult> {
    const result: SeedSaveResult = {
        saved: false, reason: null, latestPath: SEED_LATEST_PATH, datedPath: null, datedSaved: false,
        programs: snapshot.programs.length, classSlotOverrides: snapshot.classSlotOverrides.length,
        previousPrograms: null, deleted: [], cleanupFailed: false,
    };
    // 빈(또는 모양이 이상한) 스냅샷은 저장하지 않는다 — 마지막 정상본을 덮어쓰지 않게.
    const checked = validateSeedSnapshot(snapshot);
    if (!checked.ok) return { ...result, reason: `SKIPPED_${checked.reason}` };

    try {
        const bucket = getBucket();
        const body = JSON.stringify(checked.snapshot, null, 2);
        const options = { contentType: "application/json", upsert: true };

        // 1) 날짜별 사본 — 실패해도 최신본 저장은 계속한다.
        const datedPath = `${SEED_DIR}/${seedDatedName(dates.todayYmd)}`;
        result.datedPath = datedPath;
        try {
            const { error } = await bucket.upload(datedPath, body, options);
            result.datedSaved = !error;
        } catch {
            result.datedSaved = false;
        }

        // 2) 30일 지난 날짜별 사본 정리 — 실패해도 저장 결과는 바뀌지 않는다(다음 날 다시 시도된다).
        //    deleted 에는 Storage 가 «지웠다»고 답한 것만 적는다(경로째로 오든 이름만 오든 맞춘다).
        try {
            const { data: files, error: listError } = await bucket.list(SEED_DIR, { limit: 200 });
            if (listError || !files) {
                result.cleanupFailed = true;
            } else {
                const expired = expiredSeedNames(files.map((f) => f.name), dates.cutoffYmd);
                if (expired.length > 0) {
                    const { data: removed, error: removeError } = await bucket.remove(expired.map((name) => `${SEED_DIR}/${name}`));
                    const removedNames = removeError || !Array.isArray(removed) ? [] : removed.map((f) => f?.name);
                    result.deleted = expired.filter((name) => removedNames.includes(`${SEED_DIR}/${name}`) || removedNames.includes(name));
                    result.cleanupFailed = result.deleted.length !== expired.length;
                }
            }
        } catch {
            result.cleanupFailed = true;
        }

        // 3) 급감 확인 — 직전 최신본보다 프로그램이 절반 미만이면 최신본을 덮어쓰지 않는다(위의 날짜별 사본은 남는다).
        //    직전 것을 못 읽으면(처음·읽기 실패·모양 이상) 비교하지 않고 저장한다.
        const previous = await loadLatestSeedSnapshot(() => bucket);
        if (previous.ok) {
            result.previousPrograms = previous.snapshot.programs.length;
            if (isSeedShrunk(result.previousPrograms, result.programs)) return { ...result, reason: "SKIPPED_SHRUNK" };
        }

        // 4) 최신본 — 복구가 읽는 파일.
        const { error: latestError } = await bucket.upload(SEED_LATEST_PATH, body, options);
        if (latestError) return { ...result, reason: "LATEST_UPLOAD_FAILED" };
        result.saved = true;
        return result;
    } catch {
        return { ...result, reason: result.saved ? null : "STORAGE_FAILED" };
    }
}

/**
 * Storage 의 최신 스냅샷을 읽어 검사까지 마친다. 예외를 던지지 않는다.
 * 없음·읽기 실패·모양 이상이면 ok:false 와 이유 코드 — 복구는 그때 seed-data.ts 로 넘어간다.
 */
export async function loadLatestSeedSnapshot(getBucket: () => SeedBucket): Promise<SeedValidation> {
    let raw: string;
    try {
        const { data, error } = await getBucket().download(SEED_LATEST_PATH);
        if (error || !data) return { ok: false, reason: "DOWNLOAD_FAILED" };
        raw = await data.text();
    } catch {
        return { ok: false, reason: "DOWNLOAD_FAILED" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: "PARSE_FAILED" };
    }
    return validateSeedSnapshot(parsed);
}

// seed-data.ts 는 백틱 문자열로 값을 적는다 — 역슬래시·백틱·${ 를 풀어 써서 코드가 깨지지 않게 한다.
function quote(v: unknown): string {
    if (v == null) return "null";
    const s = String(v).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    return "`" + s + "`";
}

/**
 * 스냅샷을 prisma/seed-data.ts 에 그대로 넣을 수 있는 코드로 바꾼다(수동 내려받기용 — 예전 출력과 같은 모양).
 * exportedLabel: 머리말에 적을 «마지막 내보내기» 시각 글자.
 */
export function renderSeedDataTs(snapshot: SeedSnapshot, exportedLabel: string): string {
    const lines: string[] = [
        `/**`,
        ` * 시드 데이터 - 프로그램 목록 영구 보존용`,
        ` *`,
        ` * 이 파일은 프로그램 데이터를 기록합니다.`,
        ` * DB 데이터가 필요할 때 /api/admin/seed POST로 복구합니다.`,
        ` * (복구는 Storage 의 최신 자동 스냅샷을 먼저 쓰고, 없을 때만 이 파일을 씁니다.)`,
        ` *`,
        ` * 마지막 내보내기: ${exportedLabel}`,
        ` */`,
        ``,
        `export interface SeedProgram {`,
        `    id: string;`,
        `    name: string;`,
        `    targetAge: string | null;`,
        `    description: string | null;`,
        `    days: string | null;`,
        `    priceWeek1: number | null;`,
        `    priceWeek2: number | null;`,
        `    priceWeek3: number | null;`,
        `    priceDaily: number | null;`,
        `    shuttleFeeOverride: number | null;`,
        `    order: number;`,
        `    frequency?: string | null;`,
        `    weeklyFrequency?: string | null;`,
        `    imageUrl?: string | null;`,
        `    runsShuttle?: boolean;`,
        `    deletedAt?: string | null;`,
        `}`,
        ``,
        `export const PROGRAMS: SeedProgram[] = [`,
    ];
    for (const p of snapshot.programs) {
        lines.push(`    {`);
        lines.push(`        id: ${quote(p.id)},`);
        lines.push(`        name: ${quote(p.name)},`);
        lines.push(`        targetAge: ${quote(p.targetAge)},`);
        lines.push(`        description: ${quote(p.description)},`);
        lines.push(`        days: ${quote(p.days)},`);
        lines.push(`        priceWeek1: ${p.priceWeek1},`);
        lines.push(`        priceWeek2: ${p.priceWeek2},`);
        lines.push(`        priceWeek3: ${p.priceWeek3},`);
        lines.push(`        priceDaily: ${p.priceDaily},`);
        lines.push(`        shuttleFeeOverride: ${p.shuttleFeeOverride},`);
        lines.push(`        order: ${p.order},`);
        lines.push(`        frequency: ${quote(p.frequency)},`);
        lines.push(`        weeklyFrequency: ${quote(p.weeklyFrequency)},`);
        lines.push(`        imageUrl: ${quote(p.imageUrl)},`);
        lines.push(`        runsShuttle: ${p.runsShuttle},`);
        lines.push(`        deletedAt: ${quote(p.deletedAt)},`);
        lines.push(`    },`);
    }
    lines.push(`];`);
    lines.push(``);
    lines.push(`export const CLASS_SLOT_OVERRIDES: any[] = [`);
    for (const s of snapshot.classSlotOverrides) {
        lines.push(`    {`);
        lines.push(`        id: ${quote(s.id)},`);
        lines.push(`        slotKey: ${quote(s.slotKey)},`);
        lines.push(`        label: ${quote(s.label)},`);
        lines.push(`        note: ${quote(s.note)},`);
        lines.push(`        isHidden: ${s.isHidden},`);
        lines.push(`        capacity: ${s.capacity},`);
        lines.push(`        startTimeOverride: ${quote(s.startTimeOverride)},`);
        lines.push(`        endTimeOverride: ${quote(s.endTimeOverride)},`);
        lines.push(`        coachId: ${quote(s.coachId)},`);
        lines.push(`        programId: ${quote(s.programId)},`);
        lines.push(`    },`);
    }
    lines.push(`];`);
    lines.push(``);
    lines.push(`/** 이용약관 (AcademySettings.termsOfService) */`);
    lines.push(`export const TERMS_OF_SERVICE: string | null = ${quote(snapshot.termsOfService)};`);
    lines.push(``);
    return lines.join("\n");
}
