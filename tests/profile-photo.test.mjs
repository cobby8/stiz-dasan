// 학생·학부모 프로필 사진(2026-11-15 원장 요청) — 실제로 불러 실행해 확인한다.
//  ① 순수 규칙: 경로(정상·남의 폴더·«..»·대소문자)·형식·크기·캐시 버전·사진 주소
//  ② 다시 만들기: 512·128px JPEG, 촬영 정보(EXIF) 제거, 가짜 파일·허용하지 않는 형식 거부
//  ③ 저장·지우기: 새 파일 → DB → 옛 파일 순서, 옛 파일 삭제 실패는 성공, DB 실패는 새 파일 회수
//  ④ 올리기·지우기 API: 내 아이만(남의 아이·병합 학생·없는 id·비로그인 거부), 경로는 서버가 만든다
//  ⑤ 보기 API: 보호자·담당 선생님·관리자만, 그 밖(다른 학부모·담당 아닌 선생님·기사 전용·비로그인)은 404
//  ⑥ 화면: 아바타 부품(사진 없음 → 첫 글자, 아이콘 없음)·올리기 칸·안내 문구·화면 연결
//  ⑦ 마이그레이션·스키마
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const sharp = require("sharp");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 파일을 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
// 한 번의 load 안에서는 같은 파일을 한 번만 올린다(오류 클래스 instanceof 가 맞게).
function load(path, mocks = {}, cache = new Map()) {
  const absolute = resolve(path);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  cache.set(absolute, mod);
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p));
      if (file) return load(file, mocks, cache);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const rules = load("src/lib/profilePhoto/rules.ts");
const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// ── ① 순수 규칙 ────────────────────────────────────────────────────────────

test("① 경로: 학생·사용자 폴더와 작은 사진 이름", () => {
  const big = rules.buildProfilePhotoPath({ kind: "student", id: "kid-1" }, UUID_A);
  assert.equal(big, `students/kid-1/${UUID_A}.jpg`);
  assert.equal(rules.smallProfilePhotoPath(big), `students/kid-1/${UUID_A}-s.jpg`);
  assert.equal(rules.buildProfilePhotoPath({ kind: "user", id: "parent_9" }, UUID_A), `users/parent_9/${UUID_A}.jpg`);
  assert.equal(rules.PROFILE_PHOTO_BUCKET, "profile-private");
  assert.equal(rules.PROFILE_PHOTO_LARGE_PX, 512);
  assert.equal(rules.PROFILE_PHOTO_SMALL_PX, 128);
});

test("① 경로 만들기: 이상한 id·파일 이름은 만들지 않는다", () => {
  for (const id of ["", "..", "a/b", "kid/../other", "kid 1", "a".repeat(65), "kid.1"]) {
    assert.throws(() => rules.buildProfilePhotoPath({ kind: "student", id }, UUID_A), /INVALID_PROFILE_PHOTO_PATH/, id);
  }
  for (const uuid of ["", "x", "../x", UUID_B.toUpperCase(), `${UUID_A}.jpg`]) {
    assert.throws(() => rules.buildProfilePhotoPath({ kind: "student", id: "kid-1" }, uuid), /INVALID_PROFILE_PHOTO_PATH/, uuid);
  }
  assert.throws(() => rules.buildProfilePhotoPath({ kind: "class", id: "kid-1" }, UUID_A), /INVALID_PROFILE_PHOTO_PATH/);
});

test("① 경로 검증: 내 폴더만 통과 — 남의 폴더·«..»·대소문자·작은 사진·다른 확장자 거부", () => {
  const owner = { kind: "student", id: "kid-1" };
  assert.equal(rules.isValidProfilePhotoPath(`students/kid-1/${UUID_A}.jpg`, owner), true);
  const bad = [
    `students/kid-2/${UUID_A}.jpg`, // 남의 아이 폴더
    `users/kid-1/${UUID_A}.jpg`, // 다른 종류 폴더
    `students/kid-1/../kid-2/${UUID_A}.jpg`, // «..»
    `students/../students/kid-1/${UUID_A}.jpg`,
    `../students/kid-1/${UUID_A}.jpg`,
    `Students/kid-1/${UUID_A}.jpg`, // 폴더 대소문자
    `students/KID-1/${UUID_A}.jpg`, // id 대소문자
    `students/kid-1/${UUID_B.toUpperCase()}.jpg`, // 파일 이름 대소문자
    `students/kid-1/${UUID_A}.JPG`,
    `students/kid-1/${UUID_A}-s.jpg`, // 작은 사진 경로는 «큰 사진 경로»가 아니다
    `students/kid-1/${UUID_A}.png`,
    `students/kid-1/sub/${UUID_A}.jpg`,
    `/students/kid-1/${UUID_A}.jpg`,
    `students/kid-1/${UUID_A}.jpg/`,
    "students/kid-1/",
    "",
    null,
    undefined,
    42,
  ];
  for (const path of bad) assert.equal(rules.isValidProfilePhotoPath(path, owner), false, String(path));
  // 주인 id 자체가 이상하면 어떤 경로도 통과하지 않는다
  assert.equal(rules.isValidProfilePhotoPath(`students/../${UUID_A}.jpg`, { kind: "student", id: ".." }), false);
});

test("① 형식·크기: JPEG·PNG·WebP 3MB 까지만", () => {
  assert.equal(rules.profilePhotoUploadProblem({ type: "image/jpeg", size: 1000 }), null);
  assert.equal(rules.profilePhotoUploadProblem({ type: "image/png", size: 3 * 1024 * 1024 }), null);
  assert.equal(rules.profilePhotoUploadProblem({ type: "image/webp", size: 1 }), null);
  for (const type of ["image/gif", "image/svg+xml", "image/heic", "application/pdf", "", "IMAGE/JPEG"]) {
    assert.match(rules.profilePhotoUploadProblem({ type, size: 1000 }), /JPG, PNG, WebP/, type);
  }
  assert.match(rules.profilePhotoUploadProblem({ type: "image/jpeg", size: 3 * 1024 * 1024 + 1 }), /3MB/);
  assert.match(rules.profilePhotoUploadProblem({ type: "image/jpeg", size: 0 }), /비어/);
  assert.equal(rules.isAllowedProfilePhotoFormat("jpeg"), true);
  assert.equal(rules.isAllowedProfilePhotoFormat("gif"), false);
  assert.equal(rules.isAllowedProfilePhotoFormat("svg"), false);
  assert.equal(rules.isAllowedProfilePhotoFormat(undefined), false);
});

test("① 캐시 버전·사진 주소: 사진이 없으면 null, 바꾸면 주소가 달라진다", () => {
  const v1 = rules.profilePhotoVersion(new Date("2026-11-15T01:02:03.000Z"));
  const v2 = rules.profilePhotoVersion("2026-11-15T01:02:04.000Z");
  assert.match(v1, /^[0-9a-z]+$/);
  assert.notEqual(v1, v2);
  for (const empty of [null, undefined, "", "날짜 아님"]) assert.equal(rules.profilePhotoVersion(empty), null, String(empty));
  assert.equal(rules.profilePhotoUrl({ kind: "student", id: "kid-1" }, v1), `/api/profile-photo/student/kid-1?v=${v1}`);
  assert.equal(rules.profilePhotoUrl({ kind: "user", id: "p-1" }, v1, true), `/api/profile-photo/user/p-1?v=${v1}&s=1`);
  assert.equal(rules.profilePhotoUrl({ kind: "student", id: "kid-1" }, null), null, "사진 없음");
  assert.equal(rules.profilePhotoUrl({ kind: "student", id: "kid-1" }, "a&b=1"), null, "버전에 이상한 글자");
  assert.equal(rules.profilePhotoUrl({ kind: "student", id: "../x" }, v1), null, "이상한 id");
  assert.equal(rules.profilePhotoUpdatedAtSql("s"), `CASE WHEN s."photoPath" IS NOT NULL THEN s."photoUpdatedAt" END`);
  assert.throws(() => rules.profilePhotoUpdatedAtSql(`s"; DROP`), /INVALID/);
});

// ── 가짜 DB·저장소·로그인 ───────────────────────────────────────────────────

/**
 * 학원 하나를 흉내 낸다.
 *  kid-mine(내 아이·A반) · kid-other(남의 아이·B반) · kid-merged(내 아이였지만 병합돼 사라진 옛 학생)
 *  coach-a 선생님 = A반 담당, coach-b 선생님 = B반 담당
 */
function world() {
  const state = {
    students: {
      "kid-mine": { parentId: "parent-me", merged: false, photoPath: `students/kid-mine/${UUID_A}.jpg` },
      "kid-other": { parentId: "parent-other", merged: false, photoPath: `students/kid-other/${UUID_B}.jpg` },
      "kid-merged": { parentId: "parent-me", merged: true, photoPath: `students/kid-merged/${UUID_A}.jpg` },
      "kid-nophoto": { parentId: "parent-me", merged: false, photoPath: null },
    },
    users: {
      "parent-me": { photoPath: `users/parent-me/${UUID_A}.jpg` },
      "parent-other": { photoPath: `users/parent-other/${UUID_B}.jpg` },
    },
    enrollments: [
      { studentId: "kid-mine", classId: "class-a", status: "ACTIVE" },
      { studentId: "kid-other", classId: "class-b", status: "ACTIVE" },
      { studentId: "kid-merged", classId: "class-a", status: "ACTIVE" },
      { studentId: "kid-nophoto", classId: "class-a", status: "ACTIVE" },
    ],
    coaches: { "teacher-a": "coach-a", "teacher-b": "coach-b" }, // userId → coachId
    classCoach: { "class-a": "coach-a", "class-b": "coach-b" },
    files: new Set(),
    uploads: [],
    removed: [],
    downloads: [],
    sql: [],
    failUpload: null, // (path) => boolean
    failRemove: false,
    failDbUpdate: false,
    /** 지금 로그인한 사람 — null 이면 비로그인 */
    actor: null,
  };
  for (const row of [...Object.values(state.students), ...Object.values(state.users)]) {
    if (row.photoPath) { state.files.add(row.photoPath); state.files.add(row.photoPath.replace(/\.jpg$/, "-s.jpg")); }
  }

  const tableOf = (sql) => (/"Student"/.test(sql) ? state.students : state.users);

  const prisma = {
    async $queryRawUnsafe(sql, ...p) {
      state.sql.push({ sql, p });
      // 사진 저장·지우기(UPDATE … RETURNING)
      if (/UPDATE "(Student|User)" t SET "photoPath"/.test(sql)) {
        if (state.failDbUpdate) throw new Error("db down");
        const setNull = /"photoPath" = NULL/.test(sql);
        const id = setNull ? p[0] : p[1];
        const row = tableOf(sql)[id];
        if (!row) return [];
        const oldPath = row.photoPath;
        row.photoPath = setNull ? null : p[0];
        return [{ oldPath, photoUpdatedAt: new Date("2026-11-15T03:00:00.000Z") }];
      }
      // 사진 읽기(경로)
      if (/^SELECT "photoPath" FROM/.test(sql.trim())) {
        const row = tableOf(sql)[p[0]];
        if (!row) return [];
        if (/"Student"/.test(sql) && /"mergedIntoStudentId" IS NULL/.test(sql) && row.merged) return [];
        return [{ photoPath: row.photoPath }];
      }
      // 내 아이인가(parentOwnsStudent) — SQL 에 소유·병합 조건이 «있을 때만» 그 조건을 적용한다(빠지면 테스트가 잡는다)
      if (/^SELECT s\.id FROM "Student" s\s+WHERE s\.id = \$2/.test(sql.trim())) {
        const row = state.students[p[1]];
        if (!row) return [];
        if (/s\."parentId" = \$1/.test(sql) && row.parentId !== p[0]) return [];
        if (/s\."mergedIntoStudentId" IS NULL/.test(sql) && row.merged) return [];
        return [{ id: p[1] }];
      }
      // 선생님 ↔ 코치 연결
      if (/FROM "Coach"/.test(sql)) return state.coaches[p[0]] ? [{ coachId: state.coaches[p[0]] }] : [];
      // 담당 반인가(requireStaffClassAccess)
      if (/FROM "Class" c/.test(sql) && /WHERE c\.id = \$1/.test(sql)) return state.classCoach[p[0]] === p[1] ? [{ id: p[0] }] : [];
      // 그 반에 다니는 학생인가(requireStaffStudentAccess)
      if (/WHERE s\.id = \$1\s+AND e\."classId" = \$2/.test(sql)) {
        return state.enrollments.some((e) => e.studentId === p[0] && e.classId === p[1] && e.status === "ACTIVE") ? [{ id: p[0] }] : [];
      }
      // 학부모의 아이들이 다니는 반(사용자 사진 보기)
      if (/AS "classId", s\.id AS "studentId"/.test(sql)) {
        return state.enrollments
          .filter((e) => e.status === "ACTIVE" && state.students[e.studentId]?.parentId === p[0] && !state.students[e.studentId].merged)
          .map((e) => ({ classId: e.classId, studentId: e.studentId }));
      }
      // 학생이 다니는 반(아이 사진 보기)
      if (/SELECT DISTINCT e\."classId" AS "classId"/.test(sql)) {
        return state.enrollments
          .filter((e) => e.status === "ACTIVE" && e.studentId === p[0] && !(/"mergedIntoStudentId" IS NULL/.test(sql) && state.students[e.studentId]?.merged))
          .map((e) => ({ classId: e.classId }));
      }
      throw new Error(`가짜 DB 가 모르는 SQL: ${sql.slice(0, 80)}`);
    },
  };

  const storage = {
    from(bucket) {
      assert.equal(bucket, "profile-private", "비공개 버킷만 쓴다");
      return {
        async upload(path, body, options) {
          if (state.failUpload?.(path)) return { error: new Error("storage down") };
          state.uploads.push({ path, body, options });
          state.files.add(path);
          return { error: null };
        },
        async remove(paths) {
          if (state.failRemove) return { error: new Error("remove failed") };
          for (const path of paths) { state.removed.push(path); state.files.delete(path); }
          return { error: null };
        },
        async download(path) {
          state.downloads.push(path);
          if (!state.files.has(path)) return { data: null, error: new Error("not found") };
          return { data: { arrayBuffer: async () => new TextEncoder().encode(`FILE:${path}`).buffer }, error: null };
        },
      };
    },
  };

  const mocks = {
    "@/lib/prisma": { prisma },
    "@/lib/supabase/admin": { createAdminClient: () => ({ storage }) },
    // 가족 연결 표가 없는 환경과 같은 조건(대표 보호자만) — 실제 함수가 돌려주는 옛 조건 그대로
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
    "@/lib/auth-guard": {
      requireVerifiedParent: async () => {
        if (!state.actor?.parentId) throw new Error("인증이 필요합니다.");
        return { appUserId: state.actor.parentId, appUserName: "보호자", appUserRole: "PARENT" };
      },
      requireStaff: async () => {
        if (!state.actor?.staff) throw new Error("Staff permission is required.");
        return state.actor.staff;
      },
    },
    // 대타 지정·수업일 조각은 이 기능과 무관 — 대타는 «없음»으로 둔다
    "@/lib/staff/classSubstitute": { SUBSTITUTE_TEACHER_SQL: "TRUE", substituteAllowedNow: () => false },
    "@/lib/feed/rules": { sessionKstDateSql: () => "NOW()" },
  };
  return { state, mocks };
}

const ACTORS = {
  parentMe: { parentId: "parent-me" },
  parentOther: { parentId: "parent-other" },
  teacherA: { staff: { appUserId: "teacher-a", appUserRole: "INSTRUCTOR", roles: { admin: false, teacher: true, driver: false, parent: false } } },
  teacherB: { staff: { appUserId: "teacher-b", appUserRole: "INSTRUCTOR", roles: { admin: false, teacher: true, driver: false, parent: false } } },
  admin: { staff: { appUserId: "admin-1", appUserRole: "ADMIN", roles: { admin: true, teacher: true, driver: false, parent: false } } },
  viceAdmin: { staff: { appUserId: "admin-2", appUserRole: "VICE_ADMIN", roles: { admin: true, teacher: true, driver: false, parent: false } } },
  // 기사님 전용 계정 — 실수로 코치 연결이 있어도 선생님 역할이 없으면 못 본다
  driver: { staff: { appUserId: "teacher-a", appUserRole: "DRIVER", roles: { admin: false, teacher: false, driver: true, parent: false } } },
};

async function pngBuffer(width = 900, height = 600) {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
}

// ── ② 다시 만들기 ──────────────────────────────────────────────────────────

test("② 다시 만들기: 512·128px 정사각형 JPEG, 촬영 정보(EXIF)는 남지 않는다", async () => {
  const { mocks } = world();
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  // 위치 정보가 든 가로로 긴 JPEG
  const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "누군가", Make: "PhoneMaker" } })
    .toBuffer();
  assert.ok((await sharp(source).metadata()).exif, "원본에는 EXIF 가 있다");

  const { large, small } = await server.encodeProfilePhoto(source);
  const bigMeta = await sharp(large).metadata();
  const smallMeta = await sharp(small).metadata();
  assert.deepEqual([bigMeta.format, bigMeta.width, bigMeta.height], ["jpeg", 512, 512]);
  assert.deepEqual([smallMeta.format, smallMeta.width, smallMeta.height], ["jpeg", 128, 128]);
  assert.equal(bigMeta.exif, undefined, "큰 사진에 EXIF 없음");
  assert.equal(smallMeta.exif, undefined, "작은 사진에 EXIF 없음");
});

test("② 다시 만들기: 이름만 사진인 파일·GIF·SVG 는 거부(적어 보낸 형식이 아니라 실제 내용으로 판정)", async () => {
  const { mocks } = world();
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).gif().toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`);
  for (const [label, buffer] of [["글자 파일", Buffer.from("이건 사진이 아니다")], ["빈 파일", Buffer.alloc(0)], ["GIF", gif], ["SVG", svg]]) {
    await assert.rejects(() => server.encodeProfilePhoto(buffer), (error) => error instanceof server.ProfilePhotoUnreadableError, label);
  }
});

// ── ③ 저장·지우기 ──────────────────────────────────────────────────────────

test("③ 저장: 새 파일 2개 → DB 경로 갱신 → 옛 파일 2개 삭제", async () => {
  const { state, mocks } = world();
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const oldPath = state.students["kid-mine"].photoPath;
  const result = await server.saveProfilePhoto({ kind: "student", id: "kid-mine" }, await pngBuffer());

  assert.equal(state.uploads.length, 2);
  const [big, small] = state.uploads.map((u) => u.path);
  assert.match(big, /^students\/kid-mine\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(small, big.replace(/\.jpg$/, "-s.jpg"));
  assert.notEqual(big, oldPath, "새 UUID 로 만든다");
  for (const upload of state.uploads) {
    assert.equal(upload.options.contentType, "image/jpeg");
    assert.equal(upload.options.upsert, false);
  }
  assert.equal(state.students["kid-mine"].photoPath, big, "DB 에는 큰 사진 경로만");
  assert.deepEqual(state.removed, [oldPath, oldPath.replace(/\.jpg$/, "-s.jpg")]);
  assert.match(result.version, /^[0-9a-z]+$/);
  // DB 문장은 매개변수로만 값을 넣는다
  const update = state.sql.find((q) => /UPDATE "Student"/.test(q.sql));
  assert.deepEqual(update.p, [big, "kid-mine"]);
  assert.match(update.sql, /FOR UPDATE/);
});

test("③ 저장: 옛 파일 삭제가 실패해도 성공이다(기록만)", async () => {
  const { state, mocks } = world();
  state.failRemove = true;
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const result = await server.saveProfilePhoto({ kind: "user", id: "parent-me" }, await pngBuffer());
    assert.ok(result.version);
  } finally {
    console.error = original;
  }
  assert.match(state.users["parent-me"].photoPath, /^users\/parent-me\//);
  assert.equal(logged.length, 1);
  // 남은 파일을 나중에 찾아 지울 수 있게 버킷 경로(주인 종류·id 포함)를 남긴다
  assert.ok(logged[0].includes(`profile-private/users/parent-me/${UUID_A}.jpg, profile-private/users/parent-me/${UUID_A}-s.jpg`), logged[0]);
  assert.match(logged[0], /replace-old/);
});

test("③ 저장: DB 가 실패하면 방금 올린 파일을 치우고, 옛 사진은 그대로", async () => {
  const { state, mocks } = world();
  state.failDbUpdate = true;
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const oldPath = state.students["kid-mine"].photoPath;
  await assert.rejects(async () => server.saveProfilePhoto({ kind: "student", id: "kid-mine" }, await pngBuffer()));
  assert.equal(state.students["kid-mine"].photoPath, oldPath);
  assert.deepEqual(state.removed.sort(), state.uploads.map((u) => u.path).sort(), "새 파일 2개만 치운다");
  assert.ok(state.files.has(oldPath), "옛 사진 파일은 남아 있다");
});

test("③ 저장: 두 번째 파일 올리기가 실패하면 첫 파일을 치우고 DB 는 건드리지 않는다", async () => {
  const { state, mocks } = world();
  state.failUpload = (path) => path.endsWith("-s.jpg");
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  await assert.rejects(async () => server.saveProfilePhoto({ kind: "student", id: "kid-mine" }, await pngBuffer()));
  assert.equal(state.uploads.length, 1);
  assert.deepEqual(state.removed, [state.uploads[0].path]);
  assert.equal(state.sql.some((q) => /UPDATE/.test(q.sql)), false);
});

test("③ 저장·지우기: DB 의 옛 경로가 남의 폴더면 그 파일은 지우지 않는다", async () => {
  const { state, mocks } = world();
  state.students["kid-mine"].photoPath = `students/kid-other/${UUID_B}.jpg`; // 잘못 들어간 값
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  await server.saveProfilePhoto({ kind: "student", id: "kid-mine" }, await pngBuffer());
  assert.deepEqual(state.removed, []);
  assert.ok(state.files.has(`students/kid-other/${UUID_B}.jpg`));

  state.students["kid-mine"].photoPath = `students/kid-mine/../kid-other/${UUID_B}.jpg`;
  assert.equal(await server.deleteProfilePhoto({ kind: "student", id: "kid-mine" }), true);
  assert.deepEqual(state.removed, []);
  assert.equal(state.students["kid-mine"].photoPath, null);
});

test("③ 지우기: DB 경로를 비우고 파일 2개를 지운다. 사진이 없었으면 false", async () => {
  const { state, mocks } = world();
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const oldPath = state.students["kid-mine"].photoPath;
  assert.equal(await server.deleteProfilePhoto({ kind: "student", id: "kid-mine" }), true);
  assert.equal(state.students["kid-mine"].photoPath, null);
  assert.deepEqual(state.removed, [oldPath, oldPath.replace(/\.jpg$/, "-s.jpg")]);
  assert.equal(await server.deleteProfilePhoto({ kind: "student", id: "kid-nophoto" }), false);
});

// ── ④ 올리기·지우기 API ────────────────────────────────────────────────────

async function uploadRequest(fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  if (file) form.set("file", file);
  return new Request("http://localhost/api/mypage/profile-photo", { method: "POST", body: form });
}
const pngFile = async (type = "image/png") => new File([await pngBuffer()], "photo.png", { type });

test("④ 올리기: 내 아이는 허용 — 경로는 서버가 만들고 응답에 저장소 경로가 없다", async () => {
  const { state, mocks } = world();
  state.actor = ACTORS.parentMe;
  const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
  // 화면이 경로·남의 id 를 끼워 보내도 쓰지 않는다
  const response = await route.POST(await uploadRequest({ target: "student", studentId: "kid-mine", path: `students/kid-other/${UUID_B}.jpg`, userId: "parent-other" }, await pngFile()));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^\/api\/profile-photo\/student\/kid-mine\?v=[0-9a-z]+$/);
  assert.doesNotMatch(JSON.stringify(body), /students\/|profile-private/, "저장소 경로·버킷을 내보내지 않는다");
  assert.ok(state.uploads.every((u) => u.path.startsWith("students/kid-mine/")));
  assert.match(state.students["kid-mine"].photoPath, /^students\/kid-mine\//);
  assert.equal(state.students["kid-other"].photoPath, `students/kid-other/${UUID_B}.jpg`, "남의 아이는 그대로");
  // 소유 확인 SQL 은 로그인 보호자와 학생 id 를 같은 문장에서 묶고, 병합 학생을 뺀다
  const owned = state.sql.find((q) => /^SELECT s\.id FROM "Student" s/.test(q.sql.trim()));
  assert.deepEqual(owned.p, ["parent-me", "kid-mine"]);
  assert.match(owned.sql, /s\."parentId" = \$1/);
  assert.match(owned.sql, /s\."mergedIntoStudentId" IS NULL/);
});

test("④ 올리기: 남의 아이·병합된 옛 학생·없는 id 는 같은 404, 아무것도 올리지 않는다", async () => {
  for (const studentId of ["kid-other", "kid-merged", "kid-없는아이", "../kid-mine", ""]) {
    const { state, mocks } = world();
    state.actor = ACTORS.parentMe;
    const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
    const response = await route.POST(await uploadRequest({ target: "student", studentId }, await pngFile()));
    assert.equal(response.status, 404, studentId);
    assert.deepEqual(await response.json(), { error: "학생을 찾을 수 없습니다." }, studentId);
    assert.equal(state.uploads.length, 0, studentId);
    assert.equal(state.sql.some((q) => /UPDATE/.test(q.sql)), false, studentId);
  }
});

test("④ 올리기: 비로그인은 401, 대상이 이상하면 400", async () => {
  const { state, mocks } = world();
  const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
  const signedOut = await route.POST(await uploadRequest({ target: "student", studentId: "kid-mine" }, await pngFile()));
  assert.equal(signedOut.status, 401);
  assert.equal((await route.DELETE(new Request("http://localhost/api/mypage/profile-photo?target=me", { method: "DELETE" }))).status, 401);
  assert.equal(state.sql.length, 0, "로그인 전에는 DB 를 읽지 않는다");

  state.actor = ACTORS.parentMe;
  assert.equal((await route.POST(await uploadRequest({ target: "admin" }, await pngFile()))).status, 400);
  assert.equal((await route.POST(await uploadRequest({ target: "me" }))).status, 400, "파일 없음");
  assert.equal(state.uploads.length, 0);
});

test("④ 올리기: 형식·크기 거부 — 적어 보낸 형식이 맞아도 내용이 사진이 아니면 400", async () => {
  const { state, mocks } = world();
  state.actor = ACTORS.parentMe;
  const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
  const cases = [
    ["GIF", new File([await pngBuffer()], "a.gif", { type: "image/gif" }), /JPG, PNG, WebP/],
    ["3MB 초과", new File([Buffer.alloc(3 * 1024 * 1024 + 1)], "a.jpg", { type: "image/jpeg" }), /3MB/],
    ["가짜 JPEG", new File([Buffer.from("<script>alert(1)</script>")], "a.jpg", { type: "image/jpeg" }), /읽지 못했어요/],
    ["JPEG 라고 적은 SVG", new File([`<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>`], "a.jpg", { type: "image/jpeg" }), /읽지 못했어요/],
  ];
  for (const [label, file, message] of cases) {
    const response = await route.POST(await uploadRequest({ target: "me" }, file));
    assert.equal(response.status, 400, label);
    assert.match((await response.json()).error, message, label);
  }
  assert.equal(state.uploads.length, 0);
});

test("④ 내 사진: 주인은 항상 로그인한 본인 — 화면이 남의 id 를 보내도 내 폴더에만 저장한다", async () => {
  const { state, mocks } = world();
  state.actor = ACTORS.parentMe;
  const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
  const response = await route.POST(await uploadRequest({ target: "me", studentId: "kid-other", userId: "parent-other", id: "parent-other" }, await pngFile("image/webp")));
  assert.equal(response.status, 200);
  assert.ok(state.uploads.every((u) => u.path.startsWith("users/parent-me/")));
  assert.equal(state.users["parent-other"].photoPath, `users/parent-other/${UUID_B}.jpg`);
  assert.match((await response.json()).url, /^\/api\/profile-photo\/user\/parent-me\?v=/);
});

test("④ 지우기: 내 아이·내 사진만. 남의 아이·병합 학생은 404 로 그대로 남는다", async () => {
  const { state, mocks } = world();
  state.actor = ACTORS.parentMe;
  const route = load("src/app/api/mypage/profile-photo/route.ts", mocks);
  const del = (query) => route.DELETE(new Request(`http://localhost/api/mypage/profile-photo?${query}`, { method: "DELETE" }));

  for (const studentId of ["kid-other", "kid-merged", "nobody"]) {
    assert.equal((await del(`target=student&studentId=${studentId}`)).status, 404, studentId);
  }
  assert.equal(state.removed.length, 0);
  assert.equal(state.students["kid-other"].photoPath, `students/kid-other/${UUID_B}.jpg`);

  const mine = await del("target=student&studentId=kid-mine");
  assert.equal(mine.status, 200);
  assert.deepEqual(await mine.json(), { ok: true, version: null });
  assert.equal(state.students["kid-mine"].photoPath, null);

  // 내 사진 지우기 — 주소에 남의 id 를 붙여도 내 것만
  assert.equal((await del("target=me&studentId=kid-other&userId=parent-other")).status, 200);
  assert.equal(state.users["parent-me"].photoPath, null);
  assert.equal(state.users["parent-other"].photoPath, `users/parent-other/${UUID_B}.jpg`);
  assert.ok(state.removed.every((path) => path.startsWith("students/kid-mine/") || path.startsWith("users/parent-me/")));
});

// ── ⑤ 보기 API ─────────────────────────────────────────────────────────────

async function view(kind, id, actor, query = "", tweak) {
  const { state, mocks } = world();
  state.actor = actor;
  tweak?.(state);
  const route = load(`src/app/api/profile-photo/${kind}/[id]/route.ts`, mocks);
  const response = await route.GET(new Request(`http://localhost/api/profile-photo/${kind}/${id}${query}`), { params: Promise.resolve({ id }) });
  return { response, state };
}

test("⑤ 아이 사진 보기: 보호자·담당 선생님·관리자만 200", async () => {
  for (const [label, actor] of [["보호자", ACTORS.parentMe], ["담당 선생님", ACTORS.teacherA], ["원장", ACTORS.admin], ["부원장", ACTORS.viceAdmin]]) {
    const { response, state } = await view("student", "kid-mine", actor);
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get("content-type"), "image/jpeg", label);
    assert.equal(response.headers.get("cache-control"), "private, max-age=600", label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    assert.equal(await response.text(), `FILE:students/kid-mine/${UUID_A}.jpg`, label);
    assert.deepEqual(state.downloads, [`students/kid-mine/${UUID_A}.jpg`], label);
  }
});

test("⑤ 아이 사진 보기: 다른 학부모·담당 아닌 선생님·기사 전용·비로그인은 404 — 파일을 내려받지도 않는다", async () => {
  for (const [label, actor] of [["다른 학부모", ACTORS.parentOther], ["담당 아닌 선생님", ACTORS.teacherB], ["기사 전용", ACTORS.driver], ["비로그인", null]]) {
    const { response, state } = await view("student", "kid-mine", actor);
    assert.equal(response.status, 404, label);
    assert.equal(await response.text(), "", `${label}: 본문 없음`);
    assert.equal(response.headers.get("cache-control"), "private, no-store", label);
    assert.deepEqual(state.downloads, [], label);
  }
});

test("⑤ 아이 사진 보기: 사진 없음·없는 학생·병합 학생·이상한 id 는 권한 없음과 똑같은 404", async () => {
  const denied = await view("student", "kid-mine", ACTORS.parentOther);
  const cases = [
    ["사진 없음(보호자)", "kid-nophoto", ACTORS.parentMe],
    ["사진 없음(관리자)", "kid-nophoto", ACTORS.admin],
    ["없는 학생(관리자)", "kid-ghost", ACTORS.admin],
    ["병합 학생(보호자)", "kid-merged", ACTORS.parentMe],
    ["병합 학생(선생님)", "kid-merged", ACTORS.teacherA],
    ["병합 학생(관리자)", "kid-merged", ACTORS.admin],
    ["이상한 id", "..", ACTORS.admin],
    ["이상한 id 2", "kid-mine%2F..", ACTORS.admin],
  ];
  for (const [label, id, actor] of cases) {
    const { response, state } = await view("student", id, actor);
    assert.equal(response.status, denied.response.status, label);
    assert.equal(await response.text(), "", label);
    assert.deepEqual(state.downloads, [], label);
  }
});

test("⑤ 아이 사진 보기: ?s=1 은 작은 사진, DB 경로가 남의 폴더면 내려받지 않는다", async () => {
  const small = await view("student", "kid-mine", ACTORS.parentMe, "?s=1&v=abc");
  assert.equal(small.response.status, 200);
  assert.deepEqual(small.state.downloads, [`students/kid-mine/${UUID_A}-s.jpg`]);

  const crossed = await view("student", "kid-mine", ACTORS.parentMe, "", (state) => { state.students["kid-mine"].photoPath = `students/kid-other/${UUID_B}.jpg`; });
  assert.equal(crossed.response.status, 404);
  assert.deepEqual(crossed.state.downloads, []);
});

test("⑤ 아이 사진 보기: 휴원·퇴원으로 그 반 수강이 끝난 학생은 선생님에게 보이지 않는다", async () => {
  const { response } = await view("student", "kid-mine", ACTORS.teacherA, "", (state) => { state.enrollments[0].status = "PAUSED"; });
  assert.equal(response.status, 404);
});

test("⑤ 학부모 사진 보기: 본인·관리자·그 학부모의 아이를 맡은 선생님만 200", async () => {
  for (const [label, actor] of [["본인", ACTORS.parentMe], ["원장", ACTORS.admin], ["아이 담당 선생님", ACTORS.teacherA]]) {
    const { response, state } = await view("user", "parent-me", actor);
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get("cache-control"), "private, max-age=600", label);
    assert.deepEqual(state.downloads, [`users/parent-me/${UUID_A}.jpg`], label);
  }
  for (const [label, actor] of [["다른 학부모", ACTORS.parentOther], ["담당 아닌 선생님", ACTORS.teacherB], ["기사 전용", ACTORS.driver], ["비로그인", null]]) {
    const { response, state } = await view("user", "parent-me", actor);
    assert.equal(response.status, 404, label);
    assert.deepEqual(state.downloads, [], label);
  }
  // 없는 사용자도 같은 404
  assert.equal((await view("user", "ghost", ACTORS.admin)).response.status, 404);
});

test("⑤ 보기: DB 조회가 실패하면 «아니오»(404) — 실패가 권한을 넓히지 않는다", async () => {
  const { state, mocks } = world();
  state.actor = ACTORS.teacherA;
  mocks["@/lib/prisma"].prisma.$queryRawUnsafe = async () => { throw new Error("db down"); };
  const route = load("src/app/api/profile-photo/student/[id]/route.ts", mocks);
  const response = await route.GET(new Request("http://localhost/api/profile-photo/student/kid-mine"), { params: Promise.resolve({ id: "kid-mine" }) });
  assert.equal(response.status, 404);
  assert.deepEqual(state.downloads, []);
});

// ── ⑥ 화면 ─────────────────────────────────────────────────────────────────

test("⑥ 아바타: 사진이 없으면 이름 첫 글자, 아이콘·이모지 없이 토큰 색", () => {
  const avatar = load("src/components/common/ProfileAvatar.tsx");
  const html = renderToStaticMarkup(React.createElement(avatar.default, { name: "김하늘", src: null, size: 64 }));
  assert.match(html, />김</);
  assert.doesNotMatch(html, /<img|<svg|material-symbols|icon/i);
  assert.match(html, /aria-label="김하늘"/);
  assert.match(html, /width:64px;height:64px/);
  assert.match(html, /var\(--color-academy-secondary-soft\)/);
  assert.match(html, /var\(--color-academy-secondary-ink\)/);
  assert.match(html, /font-semibold/);
  assert.equal(avatar.profileInitial("  이서준 "), "이");
  assert.equal(avatar.profileInitial("Kim"), "K");
  assert.equal(avatar.profileInitial(""), "?");
  // 소스 가드: 굵기 600, 색 코드 직접 쓰지 않음, 불러오기 실패 대비
  const source = read("src/components/common/ProfileAvatar.tsx");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|font-bold|font-black|font-extrabold/);
  assert.match(source, /onError/);
});

test("⑥ 아바타: 사진이 있으면 이름을 alt 로, 늦게 불러오고 크기를 고정한다", () => {
  const avatar = load("src/components/common/ProfileAvatar.tsx");
  const html = renderToStaticMarkup(React.createElement(avatar.default, { name: "김하늘", src: "/api/profile-photo/student/kid-1?v=abc&s=1", size: 28 }));
  assert.match(html, /<img[^>]+alt="김하늘"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /width="28"/);
  assert.match(html, /height="28"/);
  assert.match(html, /src="\/api\/profile-photo\/student\/kid-1\?v=abc&amp;s=1"/);
  // 이름이 바로 옆에 있는 자리(칩·제목)는 장식으로 — 낭독기가 이름을 두 번 읽지 않는다
  const decorative = renderToStaticMarkup(React.createElement(avatar.default, { name: "김하늘", src: null, decorative: true }));
  assert.match(decorative, /aria-hidden="true"/);
  assert.doesNotMatch(decorative, /aria-label/);
});

function renderEditor(props) {
  const editor = load("src/components/parent/ProfilePhotoEditor.tsx", {
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
  });
  return renderToStaticMarkup(React.createElement(editor.default, props));
}

test("⑥ 올리기 칸: 사진이 없으면 «사진 올리기»만, 있으면 «사진 바꾸기»·«사진 지우기» + 안내 한 줄", () => {
  const empty = renderEditor({ target: "student", studentId: "kid-1", ownerId: "kid-1", name: "김하늘", initialVersion: null });
  assert.match(empty, /사진 올리기/);
  assert.doesNotMatch(empty, /사진 지우기|사진 바꾸기|<img/);
  assert.match(empty, /사진은 학부모님과 담당 선생님·학원 관리자에게만 보입니다\./);
  assert.match(empty, /accept="image\/jpeg,image\/png,image\/webp"/);

  const filled = renderEditor({ target: "me", ownerId: "parent-1", name: "보호자", initialVersion: "abc123" });
  assert.match(filled, /사진 바꾸기/);
  assert.match(filled, /사진 지우기/);
  assert.match(filled, /src="\/api\/profile-photo\/user\/parent-1\?v=abc123&amp;s=1"/);
  for (const html of [empty, filled]) assert.doesNotMatch(html, /material-symbols|<svg/);
});

test("⑥ 올리기 칸 소스: 먼저 줄이고, 지우기는 그 자리에서 묻고, 진행·실패를 글자로 알린다", () => {
  const source = read("src/components/parent/ProfilePhotoEditor.tsx");
  assert.match(source, /compressImageForUpload/);
  assert.match(source, /사진을 지울까요\?/);
  assert.match(source, /사진을 줄이는 중/);
  assert.match(source, /사진을 올리는 중/);
  assert.match(source, /role=\{status\.tone === "error" \? "alert" : "status"\}/);
  assert.match(source, /method: "DELETE"/);
  // 버튼은 공용 등급 + 터치 44px(같은 속성은 끝에 «!»)
  assert.match(source, /academy-button-secondary min-h-11!/);
  assert.match(source, /academy-button-danger min-h-11!/);
  assert.match(source, /academy-button-text min-h-11!/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|font-bold|font-black|font-extrabold|material-symbols/);
  // 경로를 서버로 보내지 않는다
  assert.doesNotMatch(source, /form\.set\("path"|storagePath|photoPath/);
});

test("⑥ 화면 연결: 홈 히어로 64·자녀 칩 28, 아이 기록 제목 64·형제 칩 28·아이 정보 칸, 설정 «내 사진»", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /<ProfileAvatar decorative name=\{child\.name\} size=\{64\}/);
  assert.match(home, /<ProfileAvatar decorative name=\{c\.name\} size=\{28\}/);
  const record = read("src/app/mypage/record/ChildRecordClient.tsx");
  assert.match(record, /<ProfileAvatar decorative name=\{record\.student\.name\} size=\{64\}/);
  assert.match(record, /<ProfileAvatar decorative name=\{c\.name\} size=\{28\}/);
  assert.match(record, /photo=\{\{ name: record\.student\.name, version: record\.student\.photoVersion \?\? null \}\}/);
  const sections = read("src/app/mypage/record/ChildProfileSections.tsx");
  assert.match(sections, /<ProfilePhotoEditor target="student" studentId=\{studentId\}/);
  const settings = read("src/app/mypage/settings/SettingsClient.tsx");
  assert.match(settings, /내 사진/);
  assert.match(settings, /<ProfilePhotoEditor target="me"/);
  const page = read("src/app/mypage/settings/page.tsx");
  assert.match(page, /<MyPhotoRow userId=\{parent\.appUserId\}/);
  // 조회: 사진이 있을 때만 버전을 만든다(자녀 목록·아이 기록)
  const queries = read("src/lib/queries.ts");
  assert.match(queries, /photoVersion: profilePhotoVersion\(/);
  const recordQuery = read("src/lib/parent/childRecordQuery.ts");
  assert.equal((recordQuery.match(/profilePhotoUpdatedAtSql\("s"\)/g) ?? []).length, 2);
});

test("⑥ 권한 판정은 한 곳(access.ts)에서 — API 가 기존 공용 함수로 소유·담당을 본다", () => {
  const access = read("src/lib/profilePhoto/access.ts");
  assert.match(access, /childAccessSql\("s", "\$1"\)/);
  assert.match(access, /notMergedStudent\("s"\)/);
  assert.match(access, /requireStaffStudentAccess\(/);
  assert.match(access, /requireVerifiedParent\(\)/);
  const upload = read("src/app/api/mypage/profile-photo/route.ts");
  assert.match(upload, /requireVerifiedParent\(\)/);
  assert.match(upload, /parentOwnsStudent\(parent\.appUserId, studentId\)/);
  // DB 는 raw SQL 만(PgBouncer) — ORM 기본 메서드 금지
  for (const file of ["src/lib/profilePhoto/server.ts", "src/lib/profilePhoto/access.ts"]) {
    assert.doesNotMatch(read(file), /prisma\.(student|user)\.|findMany|findUnique|\.update\(/, file);
  }
  // 서명 주소·공개 주소를 만들지 않는다
  assert.doesNotMatch(read("src/lib/profilePhoto/server.ts"), /createSignedUrl|getPublicUrl/);
});

// ── ⑦ 마이그레이션·스키마 ──────────────────────────────────────────────────

test("⑦ 마이그레이션: 열 4개를 IF NOT EXISTS 로, 버킷은 비공개(public=false), 되돌림 SQL 주석", () => {
  const sql = read("prisma/migrations/20261115010000_profile_photo/migration.sql");
  const live = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const table of ["Student", "User"]) {
    assert.match(live, new RegExp(`ALTER TABLE public\\."${table}" ADD COLUMN IF NOT EXISTS "photoPath" TEXT;`));
    assert.match(live, new RegExp(`ALTER TABLE public\\."${table}" ADD COLUMN IF NOT EXISTS "photoUpdatedAt" TIMESTAMPTZ\\(3\\);`));
  }
  assert.equal((live.match(/ADD COLUMN(?! IF NOT EXISTS)/g) ?? []).length, 0, "IF NOT EXISTS 없는 ADD COLUMN 금지");
  assert.match(live, /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+VALUES \('profile-private', 'profile-private', false,/);
  assert.match(live, /ON CONFLICT \(id\) DO NOTHING;/);
  assert.doesNotMatch(live, /\btrue\b/i, "공개 버킷이 아니다");
  assert.doesNotMatch(live, /DROP|DELETE|NOT NULL/i, "실행되는 문장에 파괴·필수 열 없음");
  assert.match(sql, /되돌림 SQL/);
  assert.match(sql, /-- ALTER TABLE public\."Student" DROP COLUMN IF EXISTS "photoPath"/);
  // 스키마 파일은 DB 의 사본 — 두 모델 모두 같은 열
  const schema = read("prisma/schema.prisma");
  assert.equal((schema.match(/^\s+photoPath\s+String\?$/gm) ?? []).length, 2);
  assert.equal((schema.match(/^\s+photoUpdatedAt\s+DateTime\?\s+@db\.Timestamptz\(3\)$/gm) ?? []).length, 2);
});

// ── ⑧ 삭제·탈퇴·병합 시 사진 정리 · 투명 PNG · 하이드레이션 전 실패 (2026-11-15 리뷰 반영) ──

test("⑧ 투명 PNG: 투명한 곳은 검정이 아니라 흰색으로 채운다", async () => {
  const { mocks } = world();
  const server = load("src/lib/profilePhoto/server.ts", mocks);
  const transparent = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const { large, small } = await server.encodeProfilePhoto(transparent);
  for (const [label, buffer] of [["큰 사진", large], ["작은 사진", small]]) {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const middle = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    for (const offset of [0, middle]) {
      for (let c = 0; c < 3; c += 1) assert.ok(data[offset + c] >= 250, `${label}: 흰색이어야 한다(값 ${data[offset + c]})`);
    }
  }
});

/** admin.ts 의 deleteStudent 만 잘라 실제로 실행한다(파일이 커서 통째로 올리지 않는다 — paid-status-guard 와 같은 방식) */
function loadDeleteStudent({ failStudentDelete = false, tweak } = {}) {
  const { state, mocks } = world();
  tweak?.(state);
  const cleanup = load("src/lib/profilePhoto/cleanup.ts", mocks);
  const order = [];
  const actions = read("src/app/actions/admin.ts");
  const source = actions.slice(actions.indexOf("export async function deleteStudent"), actions.indexOf("// ── 수강 등록 관리"));
  assert.ok(source.includes('DELETE FROM "Student" WHERE id = $1'), "deleteStudent 를 잘라 왔어야 한다");
  const deps = {
    requireAdmin: async () => ({ appUserId: "admin-1" }),
    ensurePaymentInfrastructure: async () => {},
    PAYMENT_STATUS_GUARD_SELECT: "SELECT 1",
    paymentDeleteBlockReason: () => null,
    revalidatePath: () => {},
    revalidateStudentAdminCaches: () => {},
    console: { error() {} },
    prisma: {
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async (sql, id) => {
        if (/DELETE FROM "Student"/.test(sql)) {
          if (failStudentDelete) throw new Error("db down");
          order.push("DB 삭제");
          delete state.students[id];
        }
        return 1;
      },
    },
    require: (name) => {
      assert.equal(name, "@/lib/profilePhoto/cleanup");
      return {
        readProfilePhotoPath: async (...args) => { order.push("경로 읽기"); return cleanup.readProfilePhotoPath(...args); },
        removeProfilePhotoFiles: async (...args) => { order.push("파일 삭제"); return cleanup.removeProfilePhotoFiles(...args); },
      };
    },
  };
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const loaded = { exports: {} };
  new Function("module", "exports", ...Object.keys(deps), compiled)(loaded, loaded.exports, ...Object.values(deps));
  return { deleteStudent: loaded.exports.deleteStudent, state, order };
}

/** console.error 를 잠깐 가로채 기록을 모은다 */
async function captureErrors(run) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await run();
  } finally {
    console.error = original;
  }
  return logged;
}

test("⑧ 원생 삭제: 지우기 전에 경로를 읽고, DB 삭제가 성공한 뒤 그 원생의 사진 2개를 지운다", async () => {
  const f = loadDeleteStudent();
  await f.deleteStudent("kid-mine");
  assert.deepEqual(f.order, ["경로 읽기", "DB 삭제", "파일 삭제"]);
  assert.deepEqual(f.state.removed, [`students/kid-mine/${UUID_A}.jpg`, `students/kid-mine/${UUID_A}-s.jpg`]);
  assert.ok(f.state.files.has(`students/kid-other/${UUID_B}.jpg`), "다른 원생 사진은 그대로");

  // 사진이 없는 원생 — 저장소를 건드리지 않는다
  const none = loadDeleteStudent();
  await none.deleteStudent("kid-nophoto");
  assert.deepEqual(none.state.removed, []);
});

test("⑧ 원생 삭제: 파일 삭제가 실패해도 삭제는 성공하고 남은 파일 경로를 기록한다 / DB 삭제가 실패하면 사진은 그대로", async () => {
  const f = loadDeleteStudent({ tweak: (state) => { state.failRemove = true; } });
  const logged = await captureErrors(() => f.deleteStudent("kid-mine"));
  assert.equal(f.state.students["kid-mine"], undefined, "원생은 지워졌다");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /student-delete/);
  assert.ok(logged[0].includes(`profile-private/students/kid-mine/${UUID_A}.jpg`), logged[0]);

  const failed = loadDeleteStudent({ failStudentDelete: true });
  await assert.rejects(() => failed.deleteStudent("kid-mine"), /원생 삭제 실패/);
  assert.deepEqual(failed.order, ["경로 읽기"]);
  assert.deepEqual(failed.state.removed, [], "DB 삭제가 실패하면 사진을 지우지 않는다");
});

/** 계정 탈퇴(익명화) 실행 — parent-account.ts 를 대역과 함께 올린다 */
function loadWithdrawal({ dbFails = false, failRemove = false } = {}) {
  const { state, mocks } = world();
  state.users.own = { photoPath: `users/own/${UUID_A}.jpg` };
  state.files.add(`users/own/${UUID_A}.jpg`);
  state.files.add(`users/own/${UUID_A}-s.jpg`);
  state.failRemove = failRemove;
  const events = [];
  class OwnAccountError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  const row = { id: "own", role: "PARENT", authUserId: "auth-own", activeEnrollments: 0, activeEnrollmentCount: 0, activeStaffGrantCount: 0, activeWorkCount: 0, withdrawRequestedAt: new Date(), withdrawnAt: null };
  const worldDb = mocks["@/lib/prisma"].prisma;
  const tx = {
    $queryRawUnsafe: async (sql, ...p) => {
      if (/SET "photoPath" = NULL/.test(sql)) { events.push("사진 경로 비움"); return worldDb.$queryRawUnsafe(sql, ...p); }
      return /role::text/.test(sql) ? [{ role: "PARENT" }] : [{ id: "own" }];
    },
    $executeRawUnsafe: async (sql) => {
      if (/UPDATE "User"/.test(sql)) {
        if (dbFails) throw new Error("synthetic DB failure");
        events.push("익명화");
      }
      return 1;
    },
  };
  const worldStorage = mocks["@/lib/supabase/admin"].createAdminClient().storage;
  const storage = {
    from: (bucket) => {
      const inner = worldStorage.from(bucket);
      return { ...inner, remove: async (paths) => { events.push("파일 삭제"); return inner.remove(paths); } };
    },
  };
  const module = load("src/app/actions/parent-account.ts", {
    ...mocks,
    "next/headers": { cookies: async () => ({}) },
    "next/cache": { revalidatePath: () => {} },
    "@/lib/account/own-account": { OwnAccountError, requireOwnAccount: async () => ({ appUserId: "own", authUserId: "auth-own", appUserRole: "PARENT" }) },
    "@/lib/account/account-withdrawal-data": { readWithdrawalRecord: async () => row },
    "@/lib/parent-account-claim": {},
    "@/lib/account/child-withdrawal": { anonymizeChildConnections: async () => {} },
    "@/lib/push/nativePushStore": { deleteNativePushTokensOfUser: async () => {} },
    "@/lib/prisma": { prisma: { $transaction: async (fn) => { const result = await fn(tx); events.push("확정"); return result; } } },
    "@/lib/supabase/admin": { createAdminClient: () => ({ auth: { admin: { deleteUser: async () => ({ error: null }) } }, storage }) },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { signOut: async () => {} } }) },
  });
  return { module, state, events };
}

test("⑧ 계정 탈퇴: 익명화와 같은 거래에서 경로를 비우고, 확정된 뒤 그 계정의 사진 2개를 지운다", async () => {
  const f = loadWithdrawal();
  const result = await f.module.executeAccountWithdrawal("own");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.events, ["익명화", "사진 경로 비움", "확정", "파일 삭제"]);
  assert.equal(f.state.users.own.photoPath, null);
  assert.deepEqual(f.state.removed, [`users/own/${UUID_A}.jpg`, `users/own/${UUID_A}-s.jpg`]);
  assert.ok(f.state.files.has(`users/parent-me/${UUID_A}.jpg`), "다른 계정 사진은 그대로");
});

test("⑧ 계정 탈퇴: 파일 삭제가 실패해도 탈퇴는 성공 / DB 정리가 실패하면 사진을 지우지 않는다", async () => {
  const f = loadWithdrawal({ failRemove: true });
  let result;
  const logged = await captureErrors(async () => { result = await f.module.executeAccountWithdrawal("own"); });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.state.users.own.photoPath, null);
  assert.ok(logged.some((line) => /account-withdraw/.test(line) && line.includes(`profile-private/users/own/${UUID_A}.jpg`)), "남은 파일 경로가 기록된다");

  const failed = loadWithdrawal({ dbFails: true });
  let failedResult;
  await captureErrors(async () => { failedResult = await failed.module.executeAccountWithdrawal("own"); });
  assert.ok(failedResult.error);
  assert.deepEqual(failed.state.removed, []);
  assert.equal(failed.events.includes("파일 삭제"), false);
});

test("⑧ 학생 병합: 확정 뒤 흡수된 학생의 사진만 지운다 — 실패해도 오류를 던지지 않는다", async () => {
  const { state, mocks } = world();
  const merge = load("src/lib/studentMerge/photoCleanup.ts", mocks);
  const results = [
    { loser: { id: "kid-merged" }, loserPhotoPath: `students/kid-merged/${UUID_A}.jpg` },
    { loser: { id: "kid-nophoto" }, loserPhotoPath: null }, // 사진 없음
    { loser: { id: "kid-mine" }, loserPhotoPath: `students/kid-other/${UUID_B}.jpg` }, // 주인과 맞지 않는 경로 — 지우지 않는다
  ];
  let tried;
  const logged = await captureErrors(async () => { tried = await merge.removeMergedStudentPhotos(results); });
  assert.equal(tried, 2);
  assert.deepEqual(state.removed, [`students/kid-merged/${UUID_A}.jpg`, `students/kid-merged/${UUID_A}-s.jpg`]);
  assert.ok(state.files.has(`students/kid-other/${UUID_B}.jpg`), "남의 사진은 그대로");
  assert.ok(logged.some((line) => /주인과 맞지 않음/.test(line) && /student:kid-mine/.test(line)));

  // 저장소가 실패해도 던지지 않는다(병합은 이미 확정됐다)
  const second = world();
  second.state.failRemove = true;
  const failing = load("src/lib/studentMerge/photoCleanup.ts", second.mocks);
  const failLog = await captureErrors(async () => { assert.equal(await failing.removeMergedStudentPhotos(results.slice(0, 1)), 1); });
  assert.ok(failLog.some((line) => /student-merge/.test(line) && line.includes(`profile-private/students/kid-merged/${UUID_A}.jpg`)));
});

test("⑧ 학생 병합 엔진: 흡수되는 쪽 사진 경로를 비우고 로그·결과로 남기되, 엔진 안에서는 파일을 지우지 않는다", () => {
  const engine = read("src/lib/studentMerge/engine.ts");
  const step = engine.slice(engine.indexOf("// --- 6-1)"), engine.indexOf("// --- 7) 흡수 레코드 표시"));
  assert.match(step, /SELECT "photoPath" AS "photoPath" FROM "Student" WHERE id = \$\{l\}/);
  assert.match(step, /UPDATE "Student" SET "photoPath" = NULL, "photoUpdatedAt" = NOW\(\) WHERE id = \$\{l\}/);
  assert.match(step, /column: "photoPath",\s*oldValue: loserPhotoPath,/);
  assert.doesNotMatch(step, /\$\{w\}/, "대표 쪽으로 옮기지 않는다(지우는 쪽)");
  assert.match(engine, /loserPhotoPath,\s*\};\s*\}/);
  // DRY-RUN(ROLLBACK)에서도 도는 코드라 저장소를 건드리면 안 된다
  const code = engine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /supabase|createAdminClient|storage\.from|profilePhoto\/cleanup/);
});

test("⑧ 아바타: 화면이 준비되기 전에 이미 실패한 사진도 이름 첫 글자로 떨어진다", () => {
  const source = read("src/components/common/ProfileAvatar.tsx");
  assert.ok(source.includes("img && img.complete && img.naturalWidth === 0) setFailedSrc(src)"));
  assert.ok(source.includes("onError={() => setFailedSrc(src)}"));
});
