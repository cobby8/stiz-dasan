// 로그인 서비스(Supabase) 브라우저 부품(약 200KB)을 첫 화면 경로에서 뺀다(2026-11-18 속도 조치)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8").replace(/\r\n/g, "\n");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// 맨 위에서 «값»을 가져오는 import/export … from (type 전용은 번들에 실리지 않아 제외). 여러 줄·상대경로도 잡는다
const STATIC_VALUE_IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](?:@\/lib\/supabase\/client|(?:\.\.?\/)+(?:[\w-]+\/)*supabase\/client|@supabase\/(?:ssr|supabase-js))["']/m;
// 파일 맨 위(주석은 건너뛰고)가 "use server" 인가
const USE_SERVER = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/;

test("Supabase 클라이언트를 맨 위에서 import 하는 파일은 서버 전용 허용 목록뿐이다 — 그 밖은 필요할 때 받는다", () => {
  // «use client» 파일만 보면 공용 모듈(hooks·lib)을 거쳐 끌려오는 경우를 놓친다 — src 전체를 보고 서버 전용만 허용한다
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const allowed = (rel, text) =>
    rel.startsWith("lib/supabase/") // 클라이언트 본체·서버·미들웨어·관리자
    || rel === "lib/native-auth/http.ts" // 서버 라우트 전용
    || /(^|\/)route\.tsx?$/.test(rel) // 서버 라우트
    || USE_SERVER.test(text); // 서버 액션
  const offenders = walk(srcDir)
    .filter((f) => /\.(tsx?|jsx?)$/.test(f))
    .map((f) => [path.relative(srcDir, f).replaceAll("\\", "/"), readFileSync(f, "utf8")])
    .filter(([rel, text]) => !allowed(rel, text) && STATIC_VALUE_IMPORT.test(text))
    .map(([rel]) => rel);
  assert.deepEqual(offenders, [], '맨 위 import 는 그 모듈이 실린 모든 화면에 약 200KB 를 싣는다 — await import("@/lib/supabase/client") 로 바꿀 것');
});

test("가드 정규식: 여러 줄·상대경로는 잡고, type 전용 import 는 지나친다", () => {
  assert.ok(STATIC_VALUE_IMPORT.test('import {\n  createClient,\n} from "@/lib/supabase/client";'));
  assert.ok(STATIC_VALUE_IMPORT.test('import { createClient } from "../../lib/supabase/client";'));
  assert.ok(STATIC_VALUE_IMPORT.test('import { createBrowserClient } from "@supabase/ssr";'));
  assert.ok(!STATIC_VALUE_IMPORT.test('import type { Provider } from "@supabase/supabase-js";'));
  assert.ok(!STATIC_VALUE_IMPORT.test('const { createClient } = await import("@/lib/supabase/client");'));
  assert.ok(USE_SERVER.test('// 설명\n"use server";\nimport x from "y";'));
  assert.ok(!USE_SERVER.test('"use client";\nimport x from "y";'));
});

test("알림 등록 부품: 스토어 앱 창구가 있을 때만, 로그인 화면이 아닐 때만 받는다", () => {
  const s = read("src/components/push/NativePushRegistrar.tsx");
  const effect = s.slice(s.indexOf("useEffect(() => {"));
  const at = (text) => { const i = effect.indexOf(text); assert.ok(i >= 0, `코드에 없음: ${text}`); return i; };
  assert.ok(at("if (!hasNativePushBridge()) return;") < at("sessionUserId()"), "창구 확인이 먼저");
  assert.ok(at("isLoginPath(pathname)") < at("sessionUserId()"), "로그인 화면 확인이 먼저");
  assert.match(s, /const \{ createClient \} = await import\("@\/lib\/supabase\/client"\);\s*const \{ data \} = await createClient\(\)\.auth\.getSession\(\);/);
});

test("공개 머리줄 계정 버튼: 화면이 뜬 뒤에 받아 구독하고, 떠나면 구독을 끊는다", () => {
  const s = read("src/components/PublicAccountControls.tsx");
  assert.match(s, /void import\("@\/lib\/supabase\/client"\)\.then\(\(\{ createClient \}\) => \{\s*if \(cancelled\) return;/);
  assert.match(s, /return \(\) => \{\s*cancelled = true;\s*unsubscribe\?\.\(\);\s*\};/);
  assert.match(s, /if \(event === "SIGNED_OUT"\) \{\s*forgetSharedAccountRole\(\);/);
});
