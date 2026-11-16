// 브라우저 기본 경고창(alert·confirm·prompt) 재발 방지 가드 (2026-11-16)
//
// 왜: 휴대폰 앱(웹뷰)에서는 기본 경고창이 어설프게 뜨거나 아예 막힌다(조용히 «취소»로 끝나기도 한다).
// 그래서 화면 안 부품 src/components/ui/feedback.tsx 의 showNotice / askConfirm / showCopyText 로 모두 바꿨다.
// 새 코드가 다시 window.alert(...)·confirm(...)·prompt(...) 를 부르면 이 테스트가 깨진다.
//
// 예외 폴더: 없음(2026-11-16 대관 화면까지 정리 끝 — 늘리지 말 것).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "src";
const EXCLUDED_DIRS = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(".", full).split(sep).join("/");
    if (EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

// 주석은 빼고 본다(설명 글에 «confirm()»이라고 적는 것은 괜찮다)
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// 그 파일 안에서 같은 이름을 직접 만든 경우(예: const { confirm } = useAdminConfirm(), async function confirm())는 브라우저 호출이 아니다
function declaresLocal(source, name) {
  return new RegExp(`(function\\s+${name}\\b|(const|let|var)\\s+${name}\\b|[{,]\\s*${name}\\s*[,}:])`).test(source);
}

export function findBrowserDialogCalls(source) {
  const code = stripComments(source);
  const hits = [];
  // window.alert( · globalThis.confirm( 같은 명시 호출은 언제나 금지
  for (const m of code.matchAll(/\b(?:window|globalThis|self)\.(alert|confirm|prompt)\s*\(/g)) hits.push(m[0]);
  // 맨 이름 호출 alert( · confirm( · prompt( — 앞이 «.»(메서드)이거나 함수 정의면 제외
  for (const m of code.matchAll(/(?<![\w.$])(alert|confirm|prompt)\s*\(/g)) {
    const before = code.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(before)) continue;
    // 타입 선언의 메서드 모양(예: interface X { prompt(): Promise<void> })은 호출이 아니다
    if (/^\)\s*:/.test(code.slice(m.index + m[0].length))) continue;
    if (declaresLocal(code, m[1])) continue;
    hits.push(m[0]);
  }
  return hits;
}

test("src 에 브라우저 기본 경고창 호출(alert·confirm·prompt)이 없다", () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const hits = findBrowserDialogCalls(readFileSync(file, "utf8"));
    if (hits.length) offenders.push(`${file}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "브라우저 기본 경고창 대신 @/components/ui/feedback 의 showNotice·askConfirm·showCopyText 를 쓴다");
});

test("가드 자체 점검 — 금지 형태는 잡고, 허용 형태는 통과시킨다", () => {
  // 잡아야 하는 것
  assert.equal(findBrowserDialogCalls(`if (!window.confirm("삭제?")) return;`).length, 1);
  assert.equal(findBrowserDialogCalls(`alert("저장 실패");`).length, 1);
  assert.equal(findBrowserDialogCalls(`if (!confirm("삭제?")) return;`).length, 1);
  assert.equal(findBrowserDialogCalls(`window.prompt("복사", url);`).length, 1);
  // 통과시켜야 하는 것
  assert.equal(findBrowserDialogCalls(`if (!(await askConfirm("삭제?"))) return; showNotice("완료");`).length, 0);
  assert.equal(findBrowserDialogCalls(`const { confirm, confirmDialog } = useAdminConfirm(); if (await confirm({ title: "x" })) go();`).length, 0);
  assert.equal(findBrowserDialogCalls(`async function confirm() {} void confirm();`).length, 0);
  assert.equal(findBrowserDialogCalls(`// 브라우저 기본 confirm() 대신\nconst x = 1;`).length, 0);
  assert.equal(findBrowserDialogCalls(`installEvent.prompt();`).length, 0);
  assert.equal(findBrowserDialogCalls(`interface E extends Event { prompt(): Promise<void> }`).length, 0);
});

test("화면 안 알림 부품이 최상위 레이아웃에 걸려 있다(안 걸리면 확인창이 안 뜨고 «그만»으로 끝난다)", () => {
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /import FeedbackHost from "@\/components\/ui\/feedback"/);
  assert.match(layout, /<FeedbackHost \/>/);
});
