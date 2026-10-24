import { pathToFileURL } from "node:url";
import pg from "pg";

export const REQUIRED_REGULAR_SHUTTLE_COLUMNS = {
  RegularShuttleStop: [
    "id", "weekday", "direction", "studentName", "studentPhone", "parentPhone",
    "serviceMonth", "studentId", "classTime", "arriveTime", "stopName", "sortOrder", "latitude", "longitude",
  ],
  RegularDispatchRoute: [
    "serviceMonth", "dayOfWeek", "direction", "payload", "classStart", "classEnd", "updatedAt",
  ],
};

export function findMissingRegularShuttleColumns(rows) {
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_REGULAR_SHUTTLE_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );
}

export async function checkRegularShuttleColumns({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");

  const client = new Client({
    connectionString,
    application_name: "stiz-regular-shuttle-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  try {
    await client.connect();
    // 구조 확인만 수행하며 운영 데이터를 변경하지 않는 읽기 전용 트랜잭션이다.
    await client.query("BEGIN READ ONLY");
    const result = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [Object.keys(REQUIRED_REGULAR_SHUTTLE_COLUMNS)],
    );
    await client.query("ROLLBACK");
    return findMissingRegularShuttleColumns(result.rows);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--skip-db")) {
    console.warn("[건너뜀] 정규 셔틀 DB 구조 검사를 명시적으로 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 정규 셔틀 DB 구조를 확인할 연결 정보가 없습니다. DIRECT_URL 또는 DATABASE_URL을 설정하세요.");
    return 1;
  }

  try {
    const missing = await checkRegularShuttleColumns({ connectionString });
    if (missing.length > 0) {
      console.error(`[실패] 정규 셔틀 필수 DB 컬럼 ${missing.length}개가 없습니다.`);
      missing.forEach(({ table, column }) => console.error(`- ${table}.${column}`));
      console.error("배포 전에 아래 정규 셔틀 마이그레이션 디렉터리를 순서대로 적용하세요.");
      console.error("- prisma/migrations/20260727120000_add_regular_shuttle_stop");
      console.error("- prisma/migrations/20260727120000_add_regular_dispatch_route");
      console.error("- prisma/migrations/20260826193000_add_regular_shuttle_month");
      console.error("- prisma/migrations/20260827223000_add_regular_shuttle_student_identity");
      console.error("이 검사는 information_schema를 읽기만 하며 DB를 자동 변경하지 않습니다.");
      return 1;
    }
    const count = Object.values(REQUIRED_REGULAR_SHUTTLE_COLUMNS).flat().length;
    console.log(`[통과] 정규 셔틀 필수 DB 컬럼 ${count}개의 존재를 확인했습니다.`);
    return 0;
  } catch (error) {
    console.error(`[실패] 정규 셔틀 DB 구조 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
