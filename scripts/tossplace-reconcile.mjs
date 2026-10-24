#!/usr/bin/env node
/**
 * 토스플레이스(POS) 카드결제 ↔ 사이트 "Payment" 월별 대사 스크립트 — **읽기 전용**
 *
 * 사용법:
 *   node scripts/tossplace-reconcile.mjs --month 2026-09
 *   node scripts/tossplace-reconcile.mjs --month 2026-09 --toss-json ./orders.json   (오프라인 검증)
 *   node scripts/tossplace-reconcile.mjs --month 2026-09 --save-toss-json ./orders.json
 *
 * 안전장치(이 스크립트가 절대 하지 않는 것):
 *   - DB 쓰기: 모든 조회를 `BEGIN READ ONLY` 트랜잭션 안에서 하고 항상 ROLLBACK 한다.
 *              대사 전후로 Payment 건수·최종수정시각을 찍어 "안 건드렸다"는 증빙을 리포트에 남긴다.
 *   - 토스 쓰기: HTTP 클라이언트가 GET 이외의 메서드와 주문목록 외 경로를 "보내기 전에" 예외로 막는다.
 *   - 비밀값 출력: 키·접속문자열은 화면·파일·에러 어디에도 찍지 않는다(redactSecrets 로 한 번 더 거른다).
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import nextEnv from "@next/env";
import pg from "pg";
import {
  billingMonthsToLoad,
  buildReconciliation,
  classifyBranch,
  flattenTossOrders,
  formatKstDateTime,
  formatWon,
  isValidMonth,
  monthRange,
  normalizeSiteRow,
  redactSecrets,
  renderCsv,
  renderMarkdown,
  sumAmount,
} from "../src/lib/pos/tossplace-match.mjs";
// 토스 조회 클라이언트는 웹앱(자동 대사)과 **같은 한 벌**을 쓴다. 사본을 만들면 한쪽만 고쳐진다.
// node 가 .ts 의 타입을 걷어내고 그대로 실행한다(node 22.18+ / 25.x).
import { fetchTossOrders } from "../src/lib/pos/tossplaceClient.ts";

const DEFAULT_MERCHANT_ID = "324744";
const MERCHANT_LABEL = "스티즈농구교실 다산2호점";

// ───────────────────────── 인자 파싱 ─────────────────────────

function parseArgs(argv) {
  const options = {
    month: "",
    tossJson: "",
    saveTossJson: "",
    naiveTz: "KST",
    outDir: "outputs/reconcile",
    merchantId: "",
  };
  const map = {
    "--month": "month",
    "--toss-json": "tossJson",
    "--save-toss-json": "saveTossJson",
    "--toss-naive-tz": "naiveTz",
    "--out-dir": "outDir",
    "--merchant-id": "merchantId",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const key = eq > 0 ? token.slice(0, eq) : token;
    const field = map[key];
    if (!field) throw new Error(`알 수 없는 옵션입니다: ${token}`);
    const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
    if (value == null) throw new Error(`${key} 옵션에 값이 필요합니다.`);
    options[field] = value;
  }
  if (!isValidMonth(options.month)) {
    throw new Error("--month 는 YYYY-MM 형식이어야 합니다. 예: --month 2026-09");
  }
  options.naiveTz = String(options.naiveTz).toUpperCase();
  if (options.naiveTz !== "KST" && options.naiveTz !== "UTC") {
    throw new Error("--toss-naive-tz 는 KST 또는 UTC 만 됩니다.");
  }
  return options;
}

// ───────────────────────── 환경변수 ─────────────────────────

function loadEnv() {
  // Next.js 와 같은 규칙(.env.local → .env)으로 읽는다. 값은 절대 출력하지 않는다.
  nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });
}

const readEnv = (name) => (typeof process.env[name] === "string" ? process.env[name].trim() : "");

// ───────────────────── 사이트 DB (읽기 전용) ─────────────────────

const SNAPSHOT_SQL = `SELECT count(*)::int AS payment_count,
                             COALESCE(to_char(max("updatedAt"), 'YYYY-MM-DD HH24:MI:SS.US'), '(없음)') AS max_updated
                        FROM "Payment"`;

const COLUMN_TYPE_SQL = `SELECT column_name, data_type
                           FROM information_schema.columns
                          WHERE table_name = 'Payment' AND column_name IN ('paidDate','updatedAt')`;

// POS 메모의 이름을 대조할 원생 명단(대표 행만 + 수강 중인 반). 이것도 조회 전용이다.
const ROSTER_SQL = `SELECT s.id,
                           s.name,
                           s.branch,
                           COALESCE(string_agg(c.name, ', ' ORDER BY c.name), '') AS classes
                      FROM "Student" s
                      LEFT JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
                      LEFT JOIN "Class" c ON c.id = e."classId"
                     WHERE s."mergedIntoStudentId" IS NULL
                     GROUP BY s.id, s.name, s.branch`;

// ⚠️ paidDate 는 "시간대 없는(timestamp) UTC 값"이라 KST 변환에 **두 번** 건다.
//    한 번만 걸면 9시간이 밀린 '그럴듯한 날짜'가 나와서 아무도 못 알아챈다.
const ROWS_SQL = `SELECT p.id,
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

// 청구월(year/month) 기준 월 수강료 기록 — 결제수단·결제일과 무관하게(NULL 포함) 가져온다.
// 사이트는 랠리즈를 뒤따라 채워지는 사본이라, 카드로 표시되지 않은 납부 기록이 있다(박찬민·손지형 실측).
// 년·월은 숫자 검증을 거친 값만 리터럴로 넣는다(PgBouncer 에서도 그대로 동작).
function invoiceSql(months) {
  const pairs = months
    .map(({ year, monthNo }) => {
      if (!Number.isInteger(year) || !Number.isInteger(monthNo)) throw new Error("청구월 형식 오류");
      return `(p.year = ${year} AND p.month = ${monthNo})`;
    })
    .join(" OR ");
  return `SELECT p.id,
                 p."studentId",
                 p.amount,
                 p.status,
                 p.method,
                 p."paidProvider",
                 p."providerOrderId",
                 p."providerPaymentKey",
                 p.year,
                 p.month,
                 p.type,
                 p.description,
                 to_char((p."paidDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul',
                         'YYYY-MM-DD HH24:MI:SS.MS') AS kst_date_time,
                 s.name AS student_name,
                 s.branch,
                 s."mergedIntoStudentId"
            FROM "Payment" p
            JOIN "Student" s ON s.id = p."studentId"
           WHERE p.type = 'MONTHLY'
             AND (${pairs})`;
}

/** PgBouncer(트랜잭션 모드)에서 파라미터 쿼리가 막히면 검증된 리터럴로 되돌린다. */
function inlineDateLiteralSql(sql, from, to) {
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`날짜 형식 오류: ${value}`);
  }
  return sql.replace("$1::date", `'${from}'::date`).replace("$2::date", `'${to}'::date`);
}

async function readSiteRows({ connectionString, from, to, invoiceMonths }) {
  const client = new pg.Client({ connectionString, query_timeout: 30_000 });
  await client.connect();
  try {
    // 읽기 전용 트랜잭션: 실수로 쓰기 구문이 섞여도 DB가 거부한다.
    await client.query("BEGIN READ ONLY");
    const before = (await client.query(SNAPSHOT_SQL)).rows[0];
    const columnTypes = (await client.query(COLUMN_TYPE_SQL)).rows;

    let rows;
    let queryMode = "파라미터 바인딩";
    try {
      rows = (await client.query(ROWS_SQL, [from, to])).rows;
    } catch (error) {
      // PgBouncer 가 extended protocol 을 막는 경우에 대비한 폴백
      queryMode = `리터럴 치환(파라미터 실패: ${error.code ?? error.message})`;
      rows = (await client.query(inlineDateLiteralSql(ROWS_SQL, from, to))).rows;
    }
    const students = (await client.query(ROSTER_SQL)).rows;
    const invoices = (await client.query(invoiceSql(invoiceMonths))).rows;
    await client.query("ROLLBACK");

    await client.query("BEGIN READ ONLY");
    const after = (await client.query(SNAPSHOT_SQL)).rows[0];
    await client.query("ROLLBACK");

    return { rows, students, invoices, before, after, columnTypes, queryMode };
  } finally {
    await client.end();
  }
}

// ───────────────────────── 메인 ─────────────────────────

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnv();

  const merchantId = options.merchantId || readEnv("TOSS_PLACE_MERCHANT_ID") || DEFAULT_MERCHANT_ID;
  if (!/^\d+$/.test(merchantId)) throw new Error("가맹점 ID(TOSS_PLACE_MERCHANT_ID)가 숫자가 아닙니다.");

  const range = monthRange(options.month);

  // 1) 토스 주문 가져오기 (파일 우선 → 없으면 API 조회)
  let rawOrders;
  let tossSource;
  if (options.tossJson) {
    const parsed = JSON.parse(fs.readFileSync(options.tossJson, "utf8"));
    rawOrders = Array.isArray(parsed) ? parsed : parsed?.success ?? [];
    if (!Array.isArray(rawOrders)) throw new Error("--toss-json 파일은 주문 배열(Order[])이어야 합니다.");
    tossSource = `저장된 파일 ${path.basename(options.tossJson)} (${rawOrders.length}건)`;
    console.log(`[1/4] 토스 주문 ${rawOrders.length}건을 파일에서 읽었습니다.`);
  } else {
    const accessKey = readEnv("TOSS_PLACE_ACCESS_KEY");
    const secretKey = readEnv("TOSS_PLACE_ACCESS_SECRET");
    if (!accessKey || !secretKey) {
      throw new Error("토스플레이스 API 키가 없습니다. .env.local 에 TOSS_PLACE_ACCESS_KEY / TOSS_PLACE_ACCESS_SECRET 를 설정하세요.");
    }
    console.log(`[1/4] 토스플레이스에서 ${range.fetchFromIso} ~ ${range.fetchToIso} 주문을 조회합니다.`);
    const { orders, eventId } = await fetchTossOrders({
      merchantId,
      from: range.fetchFromIso,
      to: range.fetchToIso,
      accessKey,
      secretKey,
    });
    rawOrders = orders;
    tossSource = `토스플레이스 Open API 실시간 조회 (주문 ${orders.length}건, 이벤트 ID ${eventId})`;
    console.log(`      → 주문 ${orders.length}건을 받았습니다.`);
  }

  if (options.saveTossJson) {
    fs.mkdirSync(path.dirname(path.resolve(options.saveTossJson)), { recursive: true });
    fs.writeFileSync(options.saveTossJson, JSON.stringify(rawOrders, null, 2), "utf8");
    console.log(`      → 원본 주문을 ${options.saveTossJson} 에 저장했습니다.`);
  }

  const flattened = flattenTossOrders(rawOrders, { naiveTz: options.naiveTz });

  // 2) 사이트 DB 조회 (읽기 전용)
  const connectionString = readEnv("DATABASE_URL");
  if (!connectionString) throw new Error("DATABASE_URL 이 없습니다. .env.local 을 확인하세요.");
  console.log(`[2/4] 사이트 DB에서 ${range.bufferFrom} ~ ${range.bufferTo} 결제를 읽습니다(읽기 전용).`);
  const invoiceMonths = billingMonthsToLoad(options.month);
  const db = await readSiteRows({ connectionString, from: range.bufferFrom, to: range.bufferTo, invoiceMonths });
  console.log(`      → 결제 ${db.rows.length}건, 원생 명단 ${db.students.length}명 (조회 방식: ${db.queryMode})`);
  console.log(
    `      → 청구월 ${invoiceMonths.map((m) => m.month).join("·")} 월 수강료 기록 ${db.invoices.length}건(결제수단·결제일 무관)`,
  );

  const paidDateType = db.columnTypes.find((c) => c.column_name === "paidDate")?.data_type ?? "(확인 불가)";
  if (paidDateType !== "timestamp without time zone") {
    console.warn(
      `[주의] Payment.paidDate 컬럼 타입이 예상(timestamp without time zone)과 다릅니다: ${paidDateType}. ` +
        "KST 변환(두 번 걸기) 가정이 맞는지 확인이 필요합니다.",
    );
  }

  // 메모 이름 대조는 2호점(및 지점 미상) 원생만 대상으로 한다 — 다른 지점 동명이인이 섞이면 오히려 흐려진다.
  const students = db.students
    .filter((s) => classifyBranch(s.branch) !== "OTHER")
    .map((s) => ({ id: String(s.id), name: String(s.name ?? ""), branch: s.branch ?? "", classes: String(s.classes ?? "") }));

  const toSiteRow = (row) =>
    normalizeSiteRow({
      ...row,
      studentName: row.student_name,
      kstDateTimeRaw: row.kst_date_time,
    });
  const siteRows = db.rows.map(toSiteRow);
  const invoiceRows = db.invoices.map(toSiteRow);

  // 3) 대사 계산
  console.log("[3/4] 대사 계산 중…");
  const result = buildReconciliation({
    month: options.month,
    siteRows,
    tossPayments: flattened.rows,
    students,
    invoiceRows,
    invoiceMonths: invoiceMonths.map((m) => m.month),
  });

  const sameCount = db.before.payment_count === db.after.payment_count;
  const sameUpdated = db.before.max_updated === db.after.max_updated;
  const noWriteProof =
    `Payment 건수 ${db.before.payment_count} → ${db.after.payment_count}, ` +
    `최종수정시각 ${db.before.max_updated} → ${db.after.max_updated} ` +
    `(${sameCount && sameUpdated ? "동일 — 이 스크립트는 읽기 전용 트랜잭션만 사용했습니다" : "⚠️ 달라짐 — 다른 사용자의 변경일 수 있습니다(이 스크립트는 쓰기 불가)"})`;

  const meta = {
    generatedAtKst: formatKstDateTime(new Date()),
    merchantId,
    merchantLabel: MERCHANT_LABEL,
    tossSource,
    naiveTz: options.naiveTz,
    noWriteProof,
    // 시간대 표시가 없어 "가정"으로 해석한 건수 — 0이면 전부 확실한 UTC(Z) 표기였다는 뜻
    assumedCount: flattened.rows.filter((row) => row.timeAssumed).length,
  };

  let markdown = renderMarkdown(result, meta);
  if (flattened.invalid.length > 0) {
    markdown += `\n> 해석하지 못한 토스 데이터 ${flattened.invalid.length}건이 있습니다: ` +
      `${flattened.invalid.map((x) => `${x.orderId}(${x.reason})`).join(", ")}\n`;
  }

  // 4) 리포트 저장
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `tossplace-${options.month}.md`);
  const csvPath = path.join(outDir, `tossplace-${options.month}.csv`);
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(csvPath, renderCsv(result), "utf8");

  const s = result.mainSummary;
  console.log("[4/4] 리포트를 저장했습니다.");
  console.log(`      - ${mdPath}`);
  console.log(`      - ${csvPath}`);
  console.log("");
  console.log(`사이트 결제완료 ${s.siteCount}건 ${formatWon(s.siteTotal)} / 토스 카드승인 ${s.tossCount}건 ${formatWon(s.tossTotal)}`);
  console.log(`차이: ${formatWon(s.difference)} (항목별 차이 합계와 ${s.reconciles ? "일치" : "불일치 ❗"})`);
  console.log(`토스POS에만 있음 ${result.main.tossResults.filter((e) => e.category === "POS_ONLY").length}건 · ` +
    `사이트에만 있음 ${result.main.siteResults.filter((e) => e.category === "SITE_ONLY").length}건 · ` +
    `확인 필요 ${[...result.main.siteResults, ...result.main.tossResults].filter((e) => e.category.startsWith("HELD")).length}건`);
  const tossCount = (category) => result.main.tossResults.filter((e) => e.category === category).length;
  console.log(
    `사이트 기존 납부 기록과 맞춤 ${tossCount("MATCHED_BY_MEMO_EXISTING_RECORD")}건 · ` +
      `POS로 받았는데 사이트는 미납 ${tossCount("POS_PAID_SITE_UNPAID")}건 · ` +
      `사이트에 그 달 청구서 없음 ${tossCount("POS_ONLY_NO_SITE_INVOICE")}건`,
  );
  console.log(`다른 지점 제외 ${result.site.otherBranch.length}건 (${formatWon(sumAmount(result.site.otherBranch))})`);
  console.log(`쓰기 없음 증빙: ${noWriteProof}`);
}

main().catch((error) => {
  const secrets = [
    process.env.TOSS_PLACE_ACCESS_KEY,
    process.env.TOSS_PLACE_ACCESS_SECRET,
    process.env.DATABASE_URL,
    process.env.DIRECT_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter((value) => typeof value === "string" && value.length > 0);

  console.error("");
  if (error?.httpStatus === 401 || error?.httpStatus === 403) {
    console.error("[실패] 토스플레이스 조회 권한이 없습니다.");
    console.error(`- ${redactSecrets(error.message, secrets)}`);
    console.error("- 토스플레이스 개발자센터에서 이 앱에 '주문 조회' 권한이 켜져 있는지, 가맹점 연결이 되어 있는지 확인해 주세요.");
    console.error("- 권한 문제라 리포트를 만들지 않았습니다(잘못된 대사 결과가 나가는 것을 막기 위함입니다).");
  } else {
    console.error(`[실패] ${redactSecrets(error?.message ?? String(error), secrets)}`);
  }
  process.exitCode = 1;
});
