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
        for (const key of ["priceWeek1", "priceWeek2", "priceWeek3", "priceDaily", "shuttleFeeOverride"]) {
            if (!numberOrNull(p[key] ?? null)) return { ok: false, reason: "BAD_PROGRAM_ROW" };
        }
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

/** 이 모듈이 쓰는 Storage 기능만 적은 모양 — `supabase.storage.from("backups")` 가 그대로 들어맞는다. */
export interface SeedBucket {
    upload(path: string, body: string, options: { contentType: string; upsert: boolean }): Promise<{ error: unknown }>;
    download(path: string): Promise<{ data: { text(): Promise<string> } | null; error: unknown }>;
    list(path: string, options?: { limit?: number }): Promise<{ data: { name: string }[] | null; error: unknown }>;
    remove(paths: string[]): Promise<{ data: unknown; error: unknown }>;
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
    deleted: string[];
}

/**
 * 스냅샷을 Storage 에 저장한다 — 날짜별 사본 → 최신본(덮어쓰기) → 30일 지난 사본 정리.
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
        programs: snapshot.programs.length, classSlotOverrides: snapshot.classSlotOverrides.length, deleted: [],
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

        // 2) 최신본 — 복구가 읽는 파일.
        const { error: latestError } = await bucket.upload(SEED_LATEST_PATH, body, options);
        if (latestError) return { ...result, reason: "LATEST_UPLOAD_FAILED" };
        result.saved = true;

        // 3) 30일 지난 날짜별 사본 정리 — 실패해도 저장 결과는 바뀌지 않는다(다음 날 다시 시도된다).
        try {
            const { data: files, error: listError } = await bucket.list(SEED_DIR, { limit: 200 });
            if (!listError && files) {
                const expired = expiredSeedNames(files.map((f) => f.name), dates.cutoffYmd);
                if (expired.length > 0) {
                    const { error: removeError } = await bucket.remove(expired.map((name) => `${SEED_DIR}/${name}`));
                    if (!removeError) result.deleted = expired;
                }
            }
        } catch {
            // 정리 실패는 조용히 넘긴다.
        }
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
