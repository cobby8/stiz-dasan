import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { hasSameOriginPreviousEntry, publicParentPath } from "../src/lib/navigation/publicHistory.ts";

function loadTs(relative, imports = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", "require", compiled)(module, module.exports, (name) => {
    assert.ok(name in imports, `Unexpected import ${name}`);
    return imports[name];
  });
  return module.exports;
}

const authRoutes = loadTs("../src/lib/auth-routes.ts");
const { parentAuthEntryHref } = loadTs("../src/lib/auth-entry-navigation.ts", { "./auth-routes": authRoutes });
const syntheticHandoff = "synthetic_application_context_only";
const hrefParams = (href) => new URL(href, "https://stiz.test").searchParams;

test("로그인과 가입을 왕복해도 내부 복귀 경로와 신청 연결만 보존한다", () => {
  const search = new URLSearchParams({ redirect: "/mypage?tab=seasonal", handoff: syntheticHandoff, error: "old", phone: "private-value", name: "private-value" });
  const signupHref = parentAuthEntryHref("signup", search);
  assert.equal(signupHref.split("?")[0], "/signup/parent");
  assert.deepEqual([...hrefParams(signupHref)], [["next", "/mypage?tab=seasonal"], ["enrollmentHandoff", syntheticHandoff]]);
  const loginHref = parentAuthEntryHref("login", hrefParams(signupHref));
  assert.deepEqual([...hrefParams(loginHref)], [["redirect", "/mypage?tab=seasonal"], ["enrollmentHandoff", syntheticHandoff]]);
});

test("간편가입 실패 후 휴대폰 방식으로 바꿔도 연결 문맥을 보존한다", () => {
  const search = new URLSearchParams({ next: "/mypage", social: "1", enrollmentHandoff: syntheticHandoff });
  const params = hrefParams(parentAuthEntryHref("signup", search, { existing: true }));
  assert.equal(params.get("existing"), "1");
  assert.equal(params.get("enrollmentHandoff"), syntheticHandoff);
  assert.equal(params.get("next"), "/mypage");
  assert.equal(params.has("social"), false);
});

test("외부 주소·우회 주소·로그인 재귀 경로를 복귀 링크로 전달하지 않는다", () => {
  for (const path of ["https://elsewhere.test", "//elsewhere.test", "/%2Felsewhere.test", "/\\elsewhere.test", "/login?redirect=/login", "/bad\npath", "/%ZZ"]) {
    for (const target of ["login", "signup"]) {
      const params = hrefParams(parentAuthEntryHref(target, new URLSearchParams({ next: path, redirect: path, enrollmentHandoff: syntheticHandoff })));
      assert.equal(params.has("next"), false, path);
      assert.equal(params.has("redirect"), false, path);
      assert.equal(params.get("enrollmentHandoff"), syntheticHandoff);
    }
  }
});

test("연결 문맥 없는 일반 진입 링크에는 빈 쿼리를 붙이지 않는다", () => {
  assert.equal(parentAuthEntryHref("login", new URLSearchParams()), "/login");
  assert.equal(parentAuthEntryHref("signup", new URLSearchParams()), "/signup/parent");
});

test("SPA의 이전 동출처 목록 기록을 idx나 referrer 없이 판별한다", () => {
  const entries = [
    { key: "home", url: "https://stiz.test/" },
    { key: "list", url: "https://stiz.test/notices?filter=school" },
    { key: "detail", url: "https://stiz.test/notices/example" },
  ];
  const navigation = { currentEntry: { key: "detail" }, entries: () => entries };
  assert.equal(hasSameOriginPreviousEntry(navigation, "https://stiz.test"), true);
  assert.equal(entries.length, 3);
});

test("직접 진입과 외부 이전 항목은 동출처 이동 기록으로 오해하지 않는다", () => {
  for (const entries of [
    [{ key: "current", url: "https://stiz.test/notices/example" }],
    [{ key: "external", url: "https://elsewhere.test/" }, { key: "current", url: "https://stiz.test/" }],
    [{ key: "unknown" }, { key: "current", url: "https://stiz.test/" }],
  ]) assert.equal(hasSameOriginPreviousEntry({ currentEntry: { key: "current" }, entries: () => entries }, "https://stiz.test"), false);
});

test("기록 API가 없거나 읽을 수 없어도 렌더 오류 없이 기존 대체 동작을 쓴다", () => {
  assert.equal(hasSameOriginPreviousEntry(undefined, "https://stiz.test"), false);
  assert.equal(hasSameOriginPreviousEntry({ currentEntry: null, entries: () => [] }, "https://stiz.test"), false);
  assert.equal(hasSameOriginPreviousEntry({ entries: () => { throw new Error("unavailable"); } }, "https://stiz.test"), false);
});

test("이전 기록을 읽지 못하는 상세·신청 화면은 각 부모 경로를 제공한다", () => {
  for (const [path, parent] of [
    ["/notices/example", "/notices"], ["/seasonal/example", "/seasonal"],
    ["/seasonal/example/apply", "/seasonal/example"], ["/apply/trial", "/apply"],
    ["/apply/enroll", "/apply"], ["/apply/uniform", "/apply"],
    ["/shop/product/4095", "/shop"], ["/programs/order", "/programs"],
  ]) assert.equal(publicParentPath(path, "/"), parent);
  assert.equal(publicParentPath("/login", "/"), "/");
  assert.equal(publicParentPath("/staff/sessions/example", "/staff"), "/staff");
});
