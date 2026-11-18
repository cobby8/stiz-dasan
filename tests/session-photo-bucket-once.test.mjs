// 수업 사진 보관함(버킷) 확인은 서버가 켜져 있는 동안 한 번만(2026-11-18 속도 개선)
//
// 왜: 사진 한 장마다 저장소에 «만들기 시도 + 설정 맞추기» 두 번을 물어, 깨어 있는 서버에서도 올리기가 1초를 넘었다(운영 p75 1.1~1.5초).
//     다시 «올릴 때마다 확인»으로 돌아가지 않게, 그리고 실패를 기억해 영영 막히지 않게 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 가짜 저장소 — 부른 횟수를 세고, 테스트가 정한 대로 답한다
const fake = (globalThis.__photoBucketFake = { calls: [], createError: null, updateError: null });
const adminMock = `data:text/javascript,${encodeURIComponent(`
  const fake = globalThis.__photoBucketFake;
  export function createAdminClient() {
    return { storage: {
      async createBucket(name, options) { fake.calls.push(["create", name, options]); return { error: fake.createError }; },
      async updateBucket(name, options) { fake.calls.push(["update", name, options]); return { error: fake.updateError }; },
    } };
  }
`)}`;
// 같은 조립은 한 번만 올라가므로(모듈 상태 공유) 테스트마다 기억을 지우고 시작한다
const loaded = await loadTsModule("src/lib/sessionPhotoStorage.ts", { overrides: { "@/lib/supabase/admin": adminMock } });
const load = async () => loaded;
const reset = () => { fake.calls.length = 0; fake.createError = null; fake.updateError = null; loaded.forgetPrivateSessionPhotoBucketCheck(); };

test("여러 장을 올려도 보관함 확인은 한 번만 — 동시에 불러도 한 번", async () => {
  reset();
  const storage = await load();
  await Promise.all([storage.ensurePrivateSessionPhotoBucket(), storage.ensurePrivateSessionPhotoBucket()]);
  await storage.ensurePrivateSessionPhotoBucket();
  assert.deepEqual(fake.calls.map((call) => call[0]), ["create", "update"]);
  // 보관함 설정은 예전 그대로(비공개·1MB·사진 형식 3종)
  for (const call of fake.calls) {
    assert.equal(call[1], "staff-session-private");
    assert.deepEqual(call[2], { public: false, fileSizeLimit: 1024 * 1024, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
  }
});

test("이미 있는 보관함(already exists)은 실패가 아니다", async () => {
  reset();
  fake.createError = { message: "The resource already exists" };
  const storage = await load();
  await storage.ensurePrivateSessionPhotoBucket();
  assert.deepEqual(fake.calls.map((call) => call[0]), ["create", "update"]);
});

test("확인이 실패하면 기억하지 않는다 — 다음 올리기가 다시 확인한다", async () => {
  reset();
  fake.updateError = new Error("저장소 일시 오류");
  const storage = await load();
  await assert.rejects(storage.ensurePrivateSessionPhotoBucket(), /저장소 일시 오류/);
  fake.updateError = null;
  await storage.ensurePrivateSessionPhotoBucket();
  assert.deepEqual(fake.calls.map((call) => call[0]), ["create", "update", "create", "update"]);
  await storage.ensurePrivateSessionPhotoBucket();
  assert.equal(fake.calls.length, 4, "성공한 뒤에는 다시 묻지 않는다");
});

test("올리기가 실패해 기억을 지우면 다음에 다시 확인한다", async () => {
  reset();
  const storage = await load();
  await storage.ensurePrivateSessionPhotoBucket();
  storage.forgetPrivateSessionPhotoBucketCheck();
  await storage.ensurePrivateSessionPhotoBucket();
  assert.equal(fake.calls.length, 4);
});

test("올리기 길 — 압축과 보관함 확인을 함께 기다리고, 올리기 실패 때 기억을 지운다", () => {
  const src = readFileSync("src/app/api/staff/sessions/[sessionId]/photos/route.ts", "utf8");
  assert.equal((src.match(/ensurePrivateSessionPhotoBucket\(\)/g) ?? []).length, 1);
  assert.match(src, /const \[encoded\] = await Promise\.all\(\[\s*sharp\([\s\S]*?\.toBuffer\(\),\s*ensurePrivateSessionPhotoBucket\(\),\s*\]\);/);
  // 순서는 그대로: 정리 예약을 먼저 영구 기록한 뒤에 파일을 올린다
  const reserveAt = src.indexOf("await reserveSessionPhotoCleanup(");
  const uploadAt = src.indexOf(".upload(");
  const ensureAt = src.indexOf("ensurePrivateSessionPhotoBucket(),");
  assert.ok(ensureAt > 0 && reserveAt > ensureAt && uploadAt > reserveAt);
  assert.match(src, /if \(uploadError\) \{[\s\S]*?forgetPrivateSessionPhotoBucketCheck\(\);\s*throw new Error\("사진 저장소 업로드에 실패했습니다\."\);/);
});
