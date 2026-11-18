// 2026-11-16 랠리즈 2026 수업 피드(다산2호점) → 사이트 수업 피드 이관(원장 결정표 v1~v5).
// 2026-11-18 결정표(rallyz-switch «완전히 지운다»): 이관 스크립트(scripts/rallyz-feed-import/**)와 그 규칙 검사는 지웠다.
// 이미 옮긴 수업은 남아 있으므로 사이트 쪽 연결만 계속 지킨다:
//  - importSource 상수(RALLYZ_FEED) = DB CHECK, 발행 두 경로(관리자·선생님) 모두 알림 건너뛰기
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(p, "utf8");

test("이관 스크립트·안내 문서는 지워졌다", () => {
  assert.equal(existsSync("scripts/rallyz-feed-import"), false);
  assert.equal(existsSync("docs/rallyz-feed-import.md"), false);
});

test("이관 표시 값 = DB CHECK, 발행 두 경로 모두 알림 건너뛰기", () => {
  const mod = read("src/lib/feed/importedSession.ts");
  assert.match(mod, /export const IMPORT_SOURCE_RALLYZ_FEED = "RALLYZ_FEED";/);
  const migration = read("prisma/migrations/20261116500000_rallyz_feed_import/migration.sql");
  assert.match(migration, /CHECK \("importSource" IS NULL OR "importSource" IN \('RALLYZ_FEED'\)\)/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "RallyzFeedImport_kind_sourceKey_key"/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(read("prisma/schema.prisma"), /importSource\s+String\?/);
  // 관리자 발행: 이관 수업이면 받는 사람 조회 자체를 비운다
  const admin = read("src/app/actions/admin.ts");
  const pub = admin.slice(admin.indexOf("export async function publishSessionReport"), admin.indexOf("export async function publishSessionReport") + 2500);
  assert.match(pub, /await isImportedSessionForNotice\(sessionId\) \? \[\] :/);
  // 선생님 발행: 처음 발행이어도 이관 수업이면 알림 없음
  const staff = read("src/app/actions/staff-sessions.ts");
  assert.match(staff, /const notifyParents = firstPublish && !\(await isImportedSessionForNotice\(input\.sessionId\)\);/);
  assert.match(staff, /if \(notifyParents\) \{\s*const ymd/);
  // 판정은 조회 실패 시 «이관 아님»(마이그레이션 전에도 사이트가 그대로 동작)
  assert.match(mod, /catch \{\s*return false;/);
});

test("순수 판정 skipsPublishNotice", async () => {
  // importedSession.ts 는 prisma 를 import 해서 로더에 가짜 모듈을 쓴다
  const src = read("src/lib/feed/importedSession.ts");
  const fn = src.slice(src.indexOf("export function skipsPublishNotice"), src.indexOf("/** 이 수업이 이관 수업인가"));
  assert.match(fn, /SESSION_IMPORT_SOURCES as readonly string\[\]\)\.includes\(importSource\)/);
});
