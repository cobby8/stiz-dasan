#!/usr/bin/env node
/**
 * 이관 되돌림(실행 묶음 batch 단위) — 장부(RallyzFeedImport)를 보고 «덧붙인 것만» 정확히 뺀다.
 * 사진 파일은 삭제 대기열(SessionPhotoDeletionJob)로, 유튜브 영상은 지움 표시 → 사이트 크론이 지운다.
 *
 *   node scripts/rallyz-feed-import/rollback.mjs --batch rz-feed-20261116-1530            (SQL 파일만 — PM 이 MCP 로 적용)
 *   node scripts/rallyz-feed-import/rollback.mjs --batch rz-feed-20261116-1530 --apply
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, parseArgs, workDir, connectDb } from "./common.mjs";
import { buildRollbackSql } from "./lib.mjs";

loadEnv();
const args = parseArgs();
if (typeof args.batch !== "string") {
  console.error("사용법: rollback.mjs --batch <batch> [--apply]");
  process.exit(1);
}
const sql = buildRollbackSql(args.batch);
const file = path.join(workDir(args), `rollback-${args.batch}.sql`);
fs.writeFileSync(file, sql, "utf8");
console.log(`SQL → ${file}`);
if (args.apply) {
  const client = await connectDb();
  try {
    await client.query(sql);
    console.log(`되돌림 끝 — batch ${args.batch}`);
  } finally {
    await client.end();
  }
}
