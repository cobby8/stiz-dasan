// 로그인 서비스(Supabase) 브라우저 부품(약 200KB)을 첫 화면 경로에서 뺀다(2026-11-18 속도 조치)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("브라우저 부품(\"use client\")은 Supabase 클라이언트를 맨 위에서 import 하지 않는다 — 필요할 때 받는다", () => {
  const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
  const offenders = walk(srcDir)
    .filter((f) => /\.(tsx?|jsx?)$/.test(f))
    .filter((f) => {
      const s = readFileSync(f, "utf8");
      return /^\s*["']use client["']/.test(s) && /^import [^\n]*from ["'](@\/lib\/supabase\/client|@supabase\/(ssr|supabase-js))["']/m.test(s);
    })
    .map((f) => path.relative(srcDir, f).replaceAll("\\", "/"));
  assert.deepEqual(offenders, [], "맨 위 import 는 그 부품이 실린 모든 화면에 200KB 를 싣는다 — await import(\"@/lib/supabase/client\") 로 바꿀 것");
});

test("알림 등록 부품: 스토어 앱 창구가 있을 때만, 로그인 화면이 아닐 때만 받는다", () => {
  const s = read("src/components/push/NativePushRegistrar.tsx");
  const effect = s.slice(s.indexOf("useEffect(() => {"));
  assert.ok(effect.indexOf("if (!hasNativePushBridge()) return;") < effect.indexOf("sessionUserId()"), "창구 확인이 먼저");
  assert.ok(effect.indexOf("isLoginPath(pathname)") < effect.indexOf("sessionUserId()"), "로그인 화면 확인이 먼저");
  assert.match(s, /const \{ createClient \} = await import\("@\/lib\/supabase\/client"\);\s*const \{ data \} = await createClient\(\)\.auth\.getSession\(\);/);
});

test("공개 머리줄 계정 버튼: 화면이 뜬 뒤에 받아 구독하고, 떠나면 구독을 끊는다", () => {
  const s = read("src/components/PublicAccountControls.tsx");
  assert.match(s, /void import\("@\/lib\/supabase\/client"\)\.then\(\(\{ createClient \}\) => \{\s*if \(cancelled\) return;/);
  assert.match(s, /return \(\) => \{\s*cancelled = true;\s*unsubscribe\?\.\(\);\s*\};/);
  assert.match(s, /if \(event === "SIGNED_OUT"\) \{\s*forgetSharedAccountRole\(\);/);
});
