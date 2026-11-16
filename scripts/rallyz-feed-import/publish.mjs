#!/usr/bin/env node
/**
 * 이관 수업 «알림 없이» 발행 — 원장이 관리자 «수업 피드»에서 확인한 뒤 실행.
 * 관리자·선생님 «발행» 버튼도 이관 수업이면 알림을 건너뛰지만(src/lib/feed/importedSession.ts),
 * 수백 개를 한 번에 보내려면 이 스크립트가 편하다. 바꾸는 것은 published·publishedAt 뿐.
 *
 *   node scripts/rallyz-feed-import/publish.mjs --batch rz-feed-20261116-1530            (SQL 파일만)
 *   node scripts/rallyz-feed-import/publish.mjs --batch rz-feed-20261116-1530 --apply    (바로 반영)
 *   --from/--to 로 이관 수업 전체 중 기간만 고를 수도 있다(--batch 대신).
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, parseArgs, workDir, connectDb, ymdArg } from "./common.mjs";
import { IMPORT_SOURCE, sqlText } from "./lib.mjs";

loadEnv();
const args = parseArgs();
const from = ymdArg(args, "from");
const to = ymdArg(args, "to");
if (!args.batch && !(from && to)) {
  console.error("사용법: publish.mjs --batch <batch> [--apply]  또는  --from YYYY-MM-DD --to YYYY-MM-DD [--apply]");
  process.exit(1);
}
const day = `(((s.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date)`;
const scope = args.batch
  ? `s.id IN (SELECT "sessionId" FROM "RallyzFeedImport" WHERE batch = ${sqlText(args.batch)})`
  : `${day} BETWEEN ${sqlText(from)}::date AND ${sqlText(to)}::date`;
const sql = `-- 이관 수업 알림 없이 발행 (${args.batch ? `batch ${args.batch}` : `${from}~${to}`})
-- 되돌림: 같은 조건으로 published = false (publishedAt 은 그대로 두면 다음 발행 때도 «처음»이 아니다)
UPDATE "Session" s SET published = true, "publishedAt" = COALESCE(s."publishedAt", NOW()), "updatedAt" = NOW()
 WHERE ${scope} AND s."importSource" = ${sqlText(IMPORT_SOURCE)} AND s.status = 'COMPLETED' AND s.published = false
RETURNING s.id;
`;
const file = path.join(workDir(args), `publish-${args.batch || `${from}_${to}`}.sql`);
fs.writeFileSync(file, sql, "utf8");
console.log(`SQL → ${file}`);
if (args.apply) {
  const client = await connectDb();
  try {
    const { rowCount } = await client.query(sql);
    console.log(`발행 ${rowCount}개 수업(학부모 알림 없음).`);
  } finally {
    await client.end();
  }
}
