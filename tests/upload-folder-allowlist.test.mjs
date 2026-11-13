// 2026-11-14 사진·인스타 점검 — 공용 업로드 API(/api/upload)의 저장 폴더 허용 목록과 계정 제한을 못박는다.
// 핵심: 화면이 쓰는 folder 값이 하나라도 목록에서 빠지면 그 화면의 업로드가 400 으로 깨진다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_UPLOAD_FOLDER,
  UPLOAD_FOLDERS,
  canUseSharedUpload,
  resolveUploadFolder,
} from "../src/lib/uploadFolders.ts";

const route = readFileSync(new URL("../src/app/api/upload/route.ts", import.meta.url), "utf8");

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) found.push(path);
  }
  return found;
}

test("허용 목록에 있는 값만 받고, 안 보내면 기존처럼 coaches", () => {
  for (const folder of UPLOAD_FOLDERS) assert.equal(resolveUploadFolder(folder), folder);
  assert.equal(DEFAULT_UPLOAD_FOLDER, "coaches");
  assert.equal(resolveUploadFolder(null), "coaches");
  assert.equal(resolveUploadFolder(undefined), "coaches");
  assert.equal(resolveUploadFolder(""), "coaches");
});

test("목록에 없는 값·경로를 벗어나는 값은 거절한다(비슷한 이름으로 고쳐 주지 않는다)", () => {
  const rejected = [
    "../secrets", "..", "gallery/../../x", "gallery/sub", "/gallery", "gallery/", " gallery", "Gallery",
    "backups", "staff-sessions", "session-photos", "unknown", "notices\\..", "%2e%2e",
  ];
  for (const value of rejected) assert.equal(resolveUploadFolder(value), null, value);
  // 문자열이 아닌 값(파일을 folder 칸에 넣는 등)도 거절
  assert.equal(resolveUploadFolder({}), null);
  assert.equal(resolveUploadFolder(123), null);
});

test("화면이 쓰는 folder 값은 전부 허용 목록에 있다", () => {
  const used = new Map(); // 값 → 쓰는 파일
  const note = (value, file) => used.set(value, [...(used.get(value) ?? []), file]);

  for (const file of sourceFiles("src")) {
    const source = readFileSync(file, "utf8");
    const usesSharedUpload = /["'`]\/api\/upload["'`]/.test(source) || source.includes("uploadImagesWithProgress(");
    if (!usesSharedUpload) continue;

    // 다른 주소로 보내는 업로드(수업 사진 = /api/staff/sessions/…/photos)는 이 API 의 목록과 무관하다
    if (/endpoint:\s*`\/api\/staff\/sessions\//.test(source)) continue;

    // fd.append("folder", "값") · folder: "값" · uploadFolder="값" · uploadFolder = "값"(기본값)
    const patterns = [
      /append\(\s*["']folder["']\s*,\s*["']([^"']+)["']\s*\)/g,
      /\bfolder:\s*["']([^"']+)["']/g,
      /\buploadFolder\s*=\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) note(match[1], file);
    }
  }
  // 글 편집기에 폴더를 넘기는 화면(편집기 파일 밖에서 uploadFolder="…" 로 준다)
  for (const file of sourceFiles("src")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<RichTextEditor[\s\S]*?uploadFolder="([^"]+)"/g)) note(match[1], file);
  }

  // 조사 때 확인한 값이 실제로 잡히는지(찾는 식이 망가져 «빈 목록 통과»가 되지 않게)
  for (const expected of ["gallery", "notices", "class-logs", "quick-post", "editor"]) {
    assert.ok(used.has(expected), `${expected} 를 쓰는 화면을 찾지 못했다 — 찾는 식을 확인`);
  }
  for (const [value, files] of used) {
    assert.ok(UPLOAD_FOLDERS.includes(value), `허용 목록에 없는 folder "${value}" — ${files.join(", ")}`);
  }
});

test("업로드 API 는 목록으로 거른 값만 경로에 쓴다", () => {
  assert.match(route, /const folder = resolveUploadFolder\(formData\.get\("folder"\)\);\s*if \(!folder\) \{\s*return NextResponse\.json\(\{ error: "사진을 저장할 위치가 올바르지 않습니다\." \}, \{ status: 400 \}\);/);
  // 요청 값을 그대로 쓰던 옛 줄이 남아 있지 않다
  assert.doesNotMatch(route, /formData\.get\("folder"\) as string/);
  // 거르는 줄이 저장보다 앞
  assert.ok(route.indexOf("resolveUploadFolder(formData") < route.indexOf("await trySupabaseUpload("));
  assert.ok(route.indexOf("resolveUploadFolder(formData") < route.indexOf('join(process.cwd(), "public", "uploads", folder)'));
});

test("기사님 전용 계정은 거절하고, 선생님·관리자·선생님 겸 기사님은 그대로 쓴다", () => {
  assert.equal(canUseSharedUpload({ admin: false, teacher: false, driver: true, parent: false }), false, "기사님 전용");
  assert.equal(canUseSharedUpload({ admin: false, teacher: true, driver: true, parent: false }), true, "선생님 겸 기사님");
  assert.equal(canUseSharedUpload({ admin: false, teacher: true, driver: false, parent: false }), true, "선생님");
  assert.equal(canUseSharedUpload({ admin: true, teacher: true, driver: false, parent: false }), true, "관리자");

  // 로그인 확인(requireStaff) 뒤, 파일을 읽기 전에 거절한다
  assert.match(route, /const staff = await requireStaff\(\);[\s\S]{0,300}if \(!canUseSharedUpload\(staff\.roles\)\) \{\s*return NextResponse\.json\(\{ error: "사진 업로드는 선생님·관리자 계정에서만 할 수 있습니다\." \}, \{ status: 403 \}\);/);
  assert.ok(route.indexOf("canUseSharedUpload(staff.roles)") < route.indexOf("await req.formData()"));
});

test("기사님 화면은 공용 업로드를 쓰지 않는다(거절해도 깨지는 화면이 없다)", () => {
  const driverScreens = [...sourceFiles("src/app/driver"), ...sourceFiles("src/app/staff/shuttle")];
  assert.ok(driverScreens.length > 0);
  for (const file of driverScreens) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /["'`]\/api\/upload["'`]|uploadImagesWithProgress\(/, file);
  }
});

test("저장 파일 확장자는 파일 이름이 아니라 검사를 통과한 형식에서 정한다", () => {
  const route = readFileSync(new URL("../src/app/api/upload/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes('const ext = EXTENSION_BY_TYPE[file.type] ?? "jpg";'));
  assert.ok(!route.includes('file.name.split(".")'), "파일 이름에서 확장자를 떼어 경로에 붙이면 안 된다");
});
