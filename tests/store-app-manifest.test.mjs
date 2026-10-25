import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 다중 역할 6단계 — 스토어에 올릴 통합 앱 하나(원장 결정 2026-10-25).
//
// 지키는 사고 두 가지:
//  ① 2026-08 — 사이트 전체를 영역으로 잡은 앱 하나가 같은 기기의 다른 PWA 설치를 전부 막았다.
//     통합 앱도 영역이 사이트 전체라, 화면에 연결하는 순간 같은 사고가 난다 → 어느 화면에도 연결하지 않는다.
//  ② 스토어 앱 표식이 크롬·기존 설치 앱으로 번지면, 기존 PWA 가 영역 밖으로 새는 사고가 다시 난다
//     → 표식은 sessionStorage(안드로이드 스토어 앱은 크롬과 저장소를 공유한다).

const manifest = JSON.parse(fs.readFileSync("public/manifest-app.json", "utf8"));
const storeApp = fs.readFileSync("src/lib/storeApp.ts", "utf8");
const hook = fs.readFileSync("src/components/pwa/useInstalledApp.ts", "utf8");
const startPage = fs.readFileSync("src/app/store-app/StoreAppStart.tsx", "utf8");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

test("통합 앱 manifest 는 어느 화면에도 연결하지 않는다(2026-08 설치 막힘 사고 재발 방지)", () => {
  // 「언급」(주석)이 아니라 «연결»을 찾는다 — Next metadata 의 manifest 필드, 또는 <link rel="manifest">.
  const linkPattern = /manifest:\s*["'`][^"'`]*manifest-app\.json|rel=["']manifest["'][^>]*manifest-app\.json|manifest-app\.json[^>]*rel=["']manifest["']/;
  const linked = walk("src").filter((file) => linkPattern.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(linked, [], `통합 앱 manifest 를 연결한 곳이 생겼다: ${linked.join(", ")}`);
  // 기존 3개 PWA 는 그대로 남아 웹 설치를 맡는다.
  for (const file of ["public/manifest-parent.json", "public/manifest-staff.json", "public/driver-manifest.json"]) {
    assert.ok(fs.existsSync(file), `${file} 가 사라졌다 — 이미 설치한 분들의 앱이 깨진다`);
  }
});

test("통합 앱 manifest 가 스토어 도구가 요구하는 값을 갖춘다", () => {
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/store-app");
  // 기존 PWA 와 같은 id 면 브라우저가 같은 앱으로 본다.
  for (const file of ["public/manifest.json", "public/manifest-parent.json", "public/manifest-staff.json", "public/driver-manifest.json"]) {
    const other = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.notEqual(manifest.id, other.id ?? other.start_url, `${file} 와 id 가 겹친다`);
  }
  // 아이콘: 512 일반 + maskable 이 있어야 스토어 아이콘이 잘리지 않는다. 파일이 실제로 있어야 한다.
  const sizes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  assert.ok(sizes.includes("512x512:any"));
  assert.ok(sizes.includes("512x512:maskable"));
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join("public", icon.src)), `${icon.src} 파일이 없다`);
  assert.ok(manifest.name && manifest.short_name.length <= 12, "짧은 이름은 홈 화면에서 잘리지 않게 짧아야 한다");
});

test("시작 주소는 표식을 찍고 역할 판별 화면으로 넘긴다", () => {
  assert.ok(fs.existsSync("src/app/store-app/page.tsx"));
  const markAt = startPage.indexOf("markStoreApp()");
  const goAt = startPage.indexOf('window.location.replace("/auth/continue")');
  assert.ok(markAt > 0 && goAt > markAt, "표식을 먼저 찍고 넘어가야 한다");
});

test("스토어 앱 표식은 sessionStorage 에만 둔다 — 크롬·기존 설치 앱으로 번지지 않게", () => {
  assert.match(storeApp, /window\.sessionStorage\.setItem\(STORE_APP_FLAG_KEY, "1"\)/);
  assert.match(storeApp, /window\.sessionStorage\.getItem\(STORE_APP_FLAG_KEY\) === "1"/);
  const code = storeApp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(code, /localStorage/, "표식을 localStorage 에 두면 같은 휴대폰의 크롬·설치 앱에서도 영역 제한이 풀린다");
  // 저장소를 못 쓰면 기존 설치 앱처럼(제한 유지) — 새는 쪽으로 실패하지 않는다.
  assert.match(storeApp, /catch \{\s*return false;\s*\}/);
});

test("스토어 앱에서는 기존 PWA 의 영역 제한을 끈다", () => {
  assert.match(hook, /import \{ isStoreApp \} from "@\/lib\/storeApp"/);
  assert.match(hook, /if \(isStoreApp\(\)\) \{\s*setInstalled\(false\);\s*return;\s*\}/);
  // 스토어 앱이 아니면 예전 판정 그대로.
  assert.match(hook, /window\.matchMedia\("\(display-mode: standalone\)"\)\.matches/);
});
