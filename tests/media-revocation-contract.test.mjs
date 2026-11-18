import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queue = readFileSync(new URL("../src/lib/mediaRevocationQueue.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/sql/add_media_revocation_queue.sql", import.meta.url), "utf8");
const publishing = readFileSync(new URL("../src/lib/socialPostPublishing.ts", import.meta.url), "utf8");
const drafts = readFileSync(new URL("../src/lib/socialDrafts.ts", import.meta.url), "utf8");

test("재철회 세대별로 같은 게시물 회수 작업을 다시 만들 수 있다", () => {
  assert.match(queue, /ON CONFLICT \("consentId", "draftId", channel\) DO NOTHING/);
  assert.match(migration, /\("consentId", "draftId", channel\)/);
});

test("대상 학생 판정은 안전 JSON 파서와 jsonb exact key 연산자를 사용한다", () => {
  assert.match(migration, /FUNCTION stiz_try_jsonb/);
  assert.match(queue, /stiz_try_jsonb\(d\."subjectStudentIdsJSON"\) \?/);
  assert.doesNotMatch(queue, /strpos\(d\."subjectStudentIdsJSON"/);
});

test("DB 미디어 참조를 먼저 제거하고 공개 사본은 durable 삭제 작업으로 넘긴다", () => {
  assert.match(queue, /INSERT INTO "StorageDeletionJob"/);
  assert.match(queue, /processStorageDeletionQueue/);
  assert.match(queue, /"mediaJSON" = '\[\]'/);
});

test("게시 대상 snapshot과 provider 결과를 durable attempt에 기록한다", () => {
  assert.match(publishing, /withSocialDraftPublicationReservation/);
  // 갤러리 게시도 시도 기록에 결과(갤러리 게시물 id)를 남긴다
  assert.match(publishing, /state='PUBLISHED', "providerMediaId"=\$2/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "SocialPublishAttempt"/);
  // 2026-11-18: 인스타 게시(«결과 불명확» 자동 재발행 중단 포함)는 결정표 insta-auto-publish «안 쓴다»로 지웠다.
  // 응답 없이 멈춘 시도를 «불명확»으로 돌리는 회수 작업은 철회 대기열에 그대로 남는다.
  assert.match(queue, /SET state='AMBIGUOUS'[\s\S]{0,160}WHERE state='PUBLISHING' AND "updatedAt" < NOW\(\)-INTERVAL '5 minutes'/);
});

test("저장소 삭제 worker는 lease 만료 PROCESSING을 회수한다", () => {
  assert.match(queue, /status='PROCESSING' AND "lockedAt" < NOW\(\)-INTERVAL '5 minutes'/);
  assert.match(queue, /"lockedAt"=date_trunc\('milliseconds', NOW\(\)\)/);
  assert.match(queue, /status='PROCESSING' AND "lockedAt"=\$3/);
  assert.match(migration, /"lockedAt" TIMESTAMPTZ\(6\)/);
});

test("관리자 반려는 외부 직접 삭제 대신 같은 transaction에 삭제 job을 넣는다", () => {
  assert.match(drafts, /INSERT INTO "StorageDeletionJob"/);
  assert.match(drafts, /pg_advisory_xact_lock/);
  assert.doesNotMatch(drafts, /DELETE FROM "GalleryPost"/);
});

test("원본 동의와 초안이 삭제돼도 불변 스냅샷으로 회수를 계속한다", () => {
  assert.match(queue, /consentSnapshotJSON/);
  assert.match(queue, /snapshotConsentIsRevoked/);
  assert.match(queue, /snapshotDraftMediaJSON/);
  assert.match(queue, /collectPublishedMediaCopyPaths\(job\.draftId, durableMediaJSON\)/);
  assert.match(migration, /'mediaJSON', d\."mediaJSON"/);
  assert.match(migration, /snapshot_immutable_trigger/);
});
