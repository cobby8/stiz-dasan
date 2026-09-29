/**
 * 토스POS ↔ 사이트 결제 자동 대사(對査) — 서버 실행부
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 이 파일이 하는 일 / 절대 하지 않는 일
 * ─────────────────────────────────────────────────────────────────────────
 * 하는 일  : ① 토스POS 주문을 **조회만** 한다 ② 사이트 결제를 **조회만** 한다
 *           ③ 둘을 맞춰 본 결과를 `PosReconcileRun` 에 **한 줄 INSERT** 한다.
 * 안 하는 일: Payment · PaymentInvoice · Enrollment · Student 를 **절대 쓰지 않는다.**
 *           돈은 이 단계에서 손대지 않는다. 여기는 "맞춰 보고 보여주기"까지다.
 *           (이 불변식은 tests/pos-reconcile-service.test.mjs 가 소스에서 직접 검사한다.)
 *
 * 계산 로직은 `./tossplace-match.mjs` 한 벌뿐이다 — CLI 도 같은 파일을 쓴다.
 * 사본을 만들면 한쪽만 고쳐져서 "어제까지 맞던 금액"이 조용히 갈린다.
 *
 * 시간대: `Payment.paidDate` 는 **시간대 없는 UTC**(timestamp) 라 KST 로 바꿀 때
 *        `AT TIME ZONE 'UTC'` → `AT TIME ZONE 'Asia/Seoul'` 로 **두 번** 건다.
 *        한 번만 걸면 9시간 밀린 '그럴듯한 날짜'가 나와 아무도 못 알아챈다.
 *        `PosReconcileRun` 쪽은 timestamptz 라 한 번만 건다.
 */

import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { fetchTossOrders } from "./tossplaceClient";
import {
    MATCHED_CATEGORIES,
    buildReconciliation,
    classifyBranch,
    flattenTossOrders,
    formatKstDateTime,
    isValidMonth,
    monthRange,
    normalizeSiteRow,
    redactSecrets,
    renderMarkdown,
} from "./tossplace-match.mjs";

export const MERCHANT_LABEL = "스티즈농구교실 다산2호점";

/**
 * 계산 모듈은 순수 JS(.mjs)라 타입스크립트가 인자 타입을 `never[]` 로 좁게 추론한다.
 * 값은 그대로 넘기고, 이 한 줄에서만 느슨한 시그니처를 선언해 둔다.
 * (계산 자체의 회귀는 tests/tossplace-match.test.mjs 가 실제 실행으로 지킨다.)
 */
const reconcile = buildReconciliation as (input: {
    month: string;
    siteRows: unknown[];
    tossPayments: unknown[];
    students: unknown[];
}) => any;

/** 대조표가 아무리 커도 이 길이까지만 저장한다(화면·DB 를 지키는 안전선). */
const MAX_REPORT_CHARS = 400_000;

export type PosReconcileSource = "CRON" | "MANUAL";

export type PosReconcileSummary = {
    targetMonth: string;
    status: "OK" | "FAILED";
    error: string | null;
    source: PosReconcileSource;
    siteCount: number;
    siteAmount: number;
    posCount: number;
    posAmount: number;
    matchedCount: number;
    heldCount: number;
    siteOnlyCount: number;
    posOnlyCount: number;
    diffAmount: number;
};

export type PosReconcileResult = {
    runId: string;
    summary: PosReconcileSummary;
};

// ───────────────────────── 조회 SQL (읽기 전용) ─────────────────────────

/**
 * 대사 대상 = 카드로 받은 돈. 토스 단말/POS 로 찍힌 것도 함께 본다.
 * 기간은 앞뒤 3일 버퍼를 포함한다(월 경계에서 하루 이틀 밀려 기록된 건을 "후보"로만 보여주려고).
 */
const SITE_ROWS_SQL = `SELECT p.id,
                              p."studentId",
                              p.amount,
                              p.status,
                              p.method,
                              p."paidProvider",
                              p."providerOrderId",
                              p."providerPaymentKey",
                              p.year,
                              p.month,
                              p.description,
                              to_char((p."paidDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul',
                                      'YYYY-MM-DD HH24:MI:SS.MS') AS kst_date_time,
                              s.name AS student_name,
                              s.branch,
                              s."mergedIntoStudentId"
                         FROM "Payment" p
                         JOIN "Student" s ON s.id = p."studentId"
                        WHERE p."paidDate" IS NOT NULL
                          AND (p.method = 'CARD' OR p."paidProvider" IN ('TOSS_TERMINAL','TOSS_POS'))
                          AND ((p."paidDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date
                              BETWEEN $1::date AND $2::date
                        ORDER BY p."paidDate" ASC`;

/** POS 메모에 적힌 이름을 대조할 원생 명단(수강 중인 반 이름 포함). 조회 전용. */
const ROSTER_SQL = `SELECT s.id,
                           s.name,
                           s.branch,
                           COALESCE(string_agg(c.name, ', ' ORDER BY c.name), '') AS classes
                      FROM "Student" s
                      LEFT JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
                      LEFT JOIN "Class" c ON c.id = e."classId"
                     WHERE s."mergedIntoStudentId" IS NULL
                     GROUP BY s.id, s.name, s.branch`;

/** 실행 기록 한 줄. 이 파일에서 나가는 **유일한 쓰기**다. */
const INSERT_RUN_SQL = `INSERT INTO "PosReconcileRun" (
        "id", "targetMonth", "status", "error", "source",
        "siteCount", "siteAmount", "posCount", "posAmount",
        "matchedCount", "heldCount", "siteOnlyCount", "posOnlyCount", "diffAmount",
        "reportMarkdown", "startedAt", "finishedAt"
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6::int, $7::bigint, $8::int, $9::bigint,
        $10::int, $11::int, $12::int, $13::int, $14::bigint,
        $15, $16::timestamptz, $17::timestamptz
      )`;

// ───────────────────────────── 도우미 ─────────────────────────────

const readEnv = (name: string) =>
    typeof process.env[name] === "string" ? (process.env[name] as string).trim() : "";

/** 이번 달(KST). 서버는 UTC 라 `new Date()` 의 월을 그냥 쓰면 매월 1일 새벽에 지난달이 나온다. */
export function currentMonthKst(nowMs: number = Date.now()): string {
    return todayKst(nowMs).slice(0, 7);
}

/** 화면·로그 어디에도 키가 새지 않도록 한 번 더 거른다. */
function redact(message: string): string {
    const secrets = [
        process.env.TOSS_PLACE_ACCESS_KEY,
        process.env.TOSS_PLACE_ACCESS_SECRET,
        process.env.DATABASE_URL,
        process.env.DIRECT_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    return redactSecrets(message, secrets);
}

// ───────────────────────────── 본체 ─────────────────────────────

/**
 * 한 달치를 대조하고 결과를 **한 줄** 기록한다.
 * 실패해도 예외를 밖으로 던지지 않는다 — 실패 자체를 FAILED 기록으로 남겨야
 * 원장이 화면에서 "어제 대조가 왜 안 됐는지"를 볼 수 있다.
 */
export async function runPosReconcile(options: {
    month?: string;
    source?: PosReconcileSource;
} = {}): Promise<PosReconcileResult> {
    const source: PosReconcileSource = options.source === "MANUAL" ? "MANUAL" : "CRON";
    const startedAt = new Date();
    const requestedMonth = options.month ?? currentMonthKst();
    // 월 형식이 깨지면 DB CHECK 제약에 걸려 기록조차 못 남는다. 여기서 이번 달로 되돌린다.
    const targetMonth = isValidMonth(requestedMonth) ? requestedMonth : currentMonthKst();
    const monthWarning = isValidMonth(requestedMonth)
        ? ""
        : `요청한 월(${String(requestedMonth)}) 형식이 올바르지 않아 이번 달(${targetMonth})로 대조했습니다.`;

    try {
        const accessKey = readEnv("TOSS_PLACE_ACCESS_KEY");
        const secretKey = readEnv("TOSS_PLACE_ACCESS_SECRET");
        const merchantId = readEnv("TOSS_PLACE_MERCHANT_ID");

        // 키가 없으면 "0건 대조 성공"처럼 보이는 결과가 나와선 안 된다. 실패로 분명히 남긴다.
        const missing = [
            accessKey ? "" : "TOSS_PLACE_ACCESS_KEY",
            secretKey ? "" : "TOSS_PLACE_ACCESS_SECRET",
            merchantId ? "" : "TOSS_PLACE_MERCHANT_ID",
        ].filter(Boolean);
        if (missing.length > 0) {
            return await recordRun({
                targetMonth,
                status: "FAILED",
                source,
                startedAt,
                error:
                    `토스플레이스 접속 정보가 설정되지 않아 대조하지 못했습니다. ` +
                    `배포 환경변수에 ${missing.join(", ")} 을(를) 등록해 주세요.`,
                reportMarkdown: null,
            });
        }
        if (!/^\d+$/.test(merchantId)) {
            return await recordRun({
                targetMonth,
                status: "FAILED",
                source,
                startedAt,
                error: "가맹점 번호(TOSS_PLACE_MERCHANT_ID)가 숫자가 아닙니다. 값을 확인해 주세요.",
                reportMarkdown: null,
            });
        }

        const range = monthRange(targetMonth);

        // ① 토스POS 주문 조회 (GET 전용 · 429 는 클라이언트가 기다렸다 재시도)
        const { orders, eventId } = await fetchTossOrders({
            merchantId,
            from: range.fetchFromIso,
            to: range.fetchToIso,
            accessKey,
            secretKey,
        });
        // 토스 응답 시각은 실측상 UTC(Z) 표기다. 표기가 없는 값만 CLI 와 같은 기준(KST)으로 해석한다.
        const flattened = flattenTossOrders(orders, { naiveTz: "KST" });

        // ② 사이트 결제 + 원생 명단 조회 (읽기 전용 · PgBouncer 라 raw 만 쓴다)
        const siteRaw = await prisma.$queryRawUnsafe<SiteRow[]>(
            SITE_ROWS_SQL,
            range.bufferFrom,
            range.bufferTo,
        );
        const rosterRaw = await prisma.$queryRawUnsafe<RosterRow[]>(ROSTER_SQL);

        // 메모 이름 대조는 2호점(및 지점 미상) 원생만 본다 — 다른 지점 동명이인이 섞이면 오히려 흐려진다.
        const students = rosterRaw
            .filter((s) => classifyBranch(s.branch) !== "OTHER")
            .map((s) => ({
                id: String(s.id),
                name: String(s.name ?? ""),
                branch: s.branch ?? "",
                classes: String(s.classes ?? ""),
            }));

        const siteRows = siteRaw.map((row) =>
            normalizeSiteRow({
                ...row,
                studentId: row.studentId,
                paidProvider: row.paidProvider,
                providerOrderId: row.providerOrderId,
                providerPaymentKey: row.providerPaymentKey,
                mergedIntoStudentId: row.mergedIntoStudentId,
                studentName: row.student_name,
                kstDateTimeRaw: row.kst_date_time,
            }),
        );

        // ③ 대조
        const result = reconcile({
            month: targetMonth,
            siteRows,
            tossPayments: flattened.rows,
            students,
        });

        const s = result.mainSummary;
        const siteResults = result.main.siteResults as Array<{ category: string }>;
        const tossResults = result.main.tossResults as Array<{ category: string }>;
        // "맞춰진 건수"는 POS 기준으로 센다(짝이므로 양쪽을 더하면 중복된다).
        const matchedCount = tossResults.filter((e) => MATCHED_CATEGORIES.has(e.category)).length;
        const heldCount = [...siteResults, ...tossResults].filter((e) =>
            e.category.startsWith("HELD"),
        ).length;
        const siteOnlyCount = siteResults.filter((e) => e.category === "SITE_ONLY").length;
        const posOnlyCount = tossResults.filter((e) => e.category === "POS_ONLY").length;

        let markdown = renderMarkdown(result, {
            generatedAtKst: formatKstDateTime(new Date()),
            merchantId,
            merchantLabel: MERCHANT_LABEL,
            tossSource: `토스플레이스 Open API 조회 (주문 ${orders.length}건, 이벤트 ID ${eventId})`,
            naiveTz: "KST",
            noWriteProof:
                "이 대조는 조회만 합니다. 결제·청구서·원생 정보는 한 건도 바꾸지 않았습니다(기록표에만 한 줄 남습니다).",
            assumedCount: flattened.rows.filter((row: { timeAssumed?: boolean }) => row.timeAssumed).length,
        });
        if (flattened.invalid.length > 0) {
            markdown +=
                `\n> 해석하지 못한 토스 데이터 ${flattened.invalid.length}건이 있습니다: ` +
                `${flattened.invalid
                    .map((x: { orderId: string; reason: string }) => `${x.orderId}(${x.reason})`)
                    .join(", ")}\n`;
        }
        if (monthWarning) markdown = `> ⚠️ ${monthWarning}\n\n${markdown}`;

        return await recordRun({
            targetMonth,
            status: "OK",
            source,
            startedAt,
            error: monthWarning || null,
            reportMarkdown: markdown,
            siteCount: s.siteCount,
            siteAmount: s.siteTotal,
            posCount: s.tossCount,
            posAmount: s.tossTotal,
            matchedCount,
            heldCount,
            siteOnlyCount,
            posOnlyCount,
            diffAmount: s.difference,
        });
    } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const httpStatus = (error as { httpStatus?: number })?.httpStatus;
        const message =
            httpStatus === 401 || httpStatus === 403
                ? `토스플레이스 조회 권한이 없습니다. 개발자센터에서 '주문 조회' 권한과 가맹점 연결을 확인해 주세요. (${redact(raw)})`
                : redact(raw);
        // 기록을 남기는 것까지 실패하면 그때는 어쩔 수 없이 던진다(호출부가 500 으로 처리).
        return await recordRun({
            targetMonth,
            status: "FAILED",
            source,
            startedAt,
            error: message,
            reportMarkdown: null,
        });
    }
}

// ─────────────────── 기록 한 줄 (이 파일의 유일한 쓰기) ───────────────────

type RecordRunInput = {
    targetMonth: string;
    status: "OK" | "FAILED";
    source: PosReconcileSource;
    startedAt: Date;
    error: string | null;
    reportMarkdown: string | null;
    siteCount?: number;
    siteAmount?: number;
    posCount?: number;
    posAmount?: number;
    matchedCount?: number;
    heldCount?: number;
    siteOnlyCount?: number;
    posOnlyCount?: number;
    diffAmount?: number;
};

const int = (value: number | undefined) => (Number.isFinite(value) ? Math.trunc(value as number) : 0);

async function recordRun(input: RecordRunInput): Promise<PosReconcileResult> {
    const runId = crypto.randomUUID();
    const finishedAt = new Date();
    const summary: PosReconcileSummary = {
        targetMonth: input.targetMonth,
        status: input.status,
        error: input.error,
        source: input.source,
        siteCount: int(input.siteCount),
        siteAmount: int(input.siteAmount),
        posCount: int(input.posCount),
        posAmount: int(input.posAmount),
        matchedCount: int(input.matchedCount),
        heldCount: int(input.heldCount),
        siteOnlyCount: int(input.siteOnlyCount),
        posOnlyCount: int(input.posOnlyCount),
        diffAmount: int(input.diffAmount),
    };

    await prisma.$executeRawUnsafe(
        INSERT_RUN_SQL,
        runId,
        summary.targetMonth,
        summary.status,
        input.error,
        summary.source,
        summary.siteCount,
        summary.siteAmount,
        summary.posCount,
        summary.posAmount,
        summary.matchedCount,
        summary.heldCount,
        summary.siteOnlyCount,
        summary.posOnlyCount,
        summary.diffAmount,
        input.reportMarkdown ? input.reportMarkdown.slice(0, MAX_REPORT_CHARS) : null,
        input.startedAt.toISOString(),
        finishedAt.toISOString(),
    );

    return { runId, summary };
}

// ───────────────────────── 화면이 읽는 조회 ─────────────────────────

export type PosReconcileRunRow = {
    id: string;
    targetMonth: string;
    status: string;
    error: string | null;
    source: string;
    siteCount: number;
    siteAmount: string;
    posCount: number;
    posAmount: string;
    matchedCount: number;
    heldCount: number;
    siteOnlyCount: number;
    posOnlyCount: number;
    diffAmount: string;
    startedAtKst: string;
    finishedAtKst: string | null;
};

/**
 * 최근 실행 기록. 금액 칸은 BIGINT 라 **문자열로 받아 온다** —
 * 자바스크립트 숫자로 바꾸는 순간 큰 값에서 오차가 생길 수 있어 표시는 문자열로 한다.
 * startedAt/finishedAt 은 timestamptz 라 KST 변환을 **한 번만** 건다.
 */
export async function listPosReconcileRuns(limit = 12): Promise<PosReconcileRunRow[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 12, 1), 100);
    return prisma.$queryRawUnsafe<PosReconcileRunRow[]>(
        `SELECT id, "targetMonth", status, error, source,
                "siteCount", "siteAmount"::text AS "siteAmount",
                "posCount", "posAmount"::text AS "posAmount",
                "matchedCount", "heldCount", "siteOnlyCount", "posOnlyCount",
                "diffAmount"::text AS "diffAmount",
                to_char("startedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "startedAtKst",
                to_char("finishedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "finishedAtKst"
           FROM "PosReconcileRun"
          ORDER BY "startedAt" DESC
          LIMIT ${safeLimit}`,
    );
}

/** 가장 최근 실행의 대조표 전문. 화면에서 다시 계산하지 않는다. */
export async function getPosReconcileReport(runId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<Array<{ reportMarkdown: string | null }>>(
        `SELECT "reportMarkdown" FROM "PosReconcileRun" WHERE id = $1 LIMIT 1`,
        runId,
    );
    return rows[0]?.reportMarkdown ?? null;
}

// ───────────────────────────── 내부 타입 ─────────────────────────────

type SiteRow = {
    id: string;
    studentId: string;
    amount: number;
    status: string;
    method: string | null;
    paidProvider: string | null;
    providerOrderId: string | null;
    providerPaymentKey: string | null;
    year: number | null;
    month: number | null;
    description: string | null;
    kst_date_time: string | null;
    student_name: string | null;
    branch: string | null;
    mergedIntoStudentId: string | null;
};

type RosterRow = {
    id: string;
    name: string | null;
    branch: string | null;
    classes: string | null;
};
