// 관리자 화면 권한 정적 가드(d3, 2026-11-13).
// 왜: 관리자 화면은 레이아웃(src/app/admin/layout.tsx)의 requireAdmin 하나에만 기대고 있었다.
// 레이아웃이 바뀌거나 화면이 다른 경로로 렌더되면 학생·학부모 개인정보가 그대로 열린다.
// 그래서 «admin 아래 모든 page.tsx 는 스스로 requireAdmin/requireOwner 를 부른다»를 테스트로 못 박는다.
// 새 관리자 화면을 만들고 첫 줄에 await requireAdmin() 을 빠뜨리면 이 테스트가 깨진다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ADMIN_DIR = join(ROOT, "src/app/admin");

function walkPages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkPages(p, out);
    else if (name === "page.tsx") out.push(p);
  }
  return out;
}

// 예외 = 다른 담당 영역이라 이번에 파일을 못 고친 화면. 대신 «검사된 읽기 함수만 쓴다»를 아래에서 확인한다.
// 갚아야 할 빚이다 — 늘리지 말 것. 그 담당이 파일을 고칠 때 requireAdmin 을 넣고 여기서 지운다.
const ALLOW = new Map([
  ["src/app/admin/finance/billing/page.tsx", "청구·결제 담당 영역 — 데이터는 adminOnly 로 감싼 getCachedAdminBillingPayload 로만 읽는다"],
]);

const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");
const pages = walkPages(ADMIN_DIR);

test("관리자 화면이 하나 이상 있다(경로 계산 확인)", () => {
  assert.ok(pages.length > 40, `page.tsx 가 ${pages.length}개뿐 — 경로가 틀렸을 수 있다`);
});

test("admin 아래 모든 page.tsx 는 await requireAdmin()/requireOwner() 를 부른다", () => {
  const missing = [];
  for (const file of pages) {
    const r = rel(file);
    if (ALLOW.has(r)) continue;
    // 주석 속 «requireAdmin()» 글자에 속지 않게 주석을 지우고 본다.
    // await requireAdmin() 단독 또는 Promise.all([requireAdmin(), …]) 둘 다 인정(둘 다 실패하면 화면이 데이터 없이 오류로 끝난다).
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/\brequire(Admin|Owner)\(\)/.test(code)) missing.push(r);
  }
  assert.deepEqual(missing, [], `권한 확인이 빠진 관리자 화면:\n${missing.join("\n")}`);
});

test("예외 화면은 adminOnly 로 감싼 관리자 읽기 함수만 쓰고, 이미 고쳐졌으면 예외에서 지운다", () => {
  for (const [r, reason] of ALLOW) {
    const src = readFileSync(join(ROOT, r), "utf8");
    assert.ok(reason.length > 0);
    assert.doesNotMatch(src, /await\s+require(Admin|Owner)\(\)/, `${r} 은 이제 권한 확인을 하니 ALLOW 에서 지울 것`);
    assert.match(src, /from "@\/lib\/adminReadPayloads"/, `${r} 이 검사된 읽기 함수 밖에서 데이터를 읽는다`);
    assert.doesNotMatch(src, /prisma|\$queryRaw/, `${r} 이 DB 를 직접 읽는다`);
  }
});

test("adminReadPayloads 의 모든 export 는 adminOnly(관리자 확인)로 감싼다", () => {
  const src = readFileSync(join(ROOT, "src/lib/adminReadPayloads.ts"), "utf8");
  assert.match(src, /function adminOnly[\s\S]*?await requireAdmin\(\)/);
  const exportsList = [...src.matchAll(/^export (?:const|function|async function) (\w+)/gm)].map((m) => m[1]);
  assert.ok(exportsList.length >= 30);
  const unguarded = [];
  for (const name of exportsList) {
    const start = src.indexOf(`export `, src.search(new RegExp(`^export (?:const|function|async function) ${name}\\b`, "m")));
    const next = src.indexOf("\nexport ", start + 1);
    const block = src.slice(start, next < 0 ? undefined : next);
    if (!/adminOnly\(/.test(block)) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], `관리자 확인 없이 열린 읽기 함수: ${unguarded.join(", ")}`);
});
