import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 원장 제보(2026-08-09): 학부모 앱에서 뒤로가기를 누르면 공개 홈페이지로 나갔다.
// 앱을 새로 열면 되돌아갈 기록이 없어 fallbackHref("/")로 밀려났던 것.

const moduleSource = await readFile("src/lib/navigation/backAction.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { resolveBackAction, isWithinScope } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const parentApp = { fallbackHref: "/", scopeHref: "/mypage", isInstalledApp: true };

test("되돌아갈 기록이 있으면 언제나 이전 화면으로 간다", () => {
  for (const pathname of ["/mypage", "/mypage/reports", "/staff/students", "/notice"]) {
    assert.deepEqual(
      resolveBackAction({ ...parentApp, hasHistory: true, pathname }),
      { type: "back" },
      pathname,
    );
  }
});

test("설치된 앱은 기록이 없어도 제 범위 밖으로 나가지 않는다", () => {
  assert.deepEqual(
    resolveBackAction({ ...parentApp, hasHistory: false, pathname: "/mypage/reports" }),
    { type: "push", href: "/mypage" },
  );
  assert.deepEqual(
    resolveBackAction({ fallbackHref: "/", scopeHref: "/staff", isInstalledApp: true, hasHistory: false, pathname: "/staff/billing" }),
    { type: "push", href: "/staff" },
  );
});

test("앱의 첫 화면에서는 아무 데도 보내지 않는다", () => {
  // 예전에는 여기서 fallbackHref 가 현재 경로와 같다는 이유로 "/" 로 튕겼다.
  assert.deepEqual(
    resolveBackAction({ ...parentApp, hasHistory: false, pathname: "/mypage" }),
    { type: "none" },
  );
  assert.deepEqual(
    resolveBackAction({ fallbackHref: "/staff", scopeHref: "/staff", isInstalledApp: true, hasHistory: false, pathname: "/staff" }),
    { type: "none" },
  );
});

test("브라우저에서는 기존 동작을 그대로 둔다", () => {
  // 홈페이지에서 들어온 사람도 있어 가두면 오히려 불편하다.
  assert.deepEqual(
    resolveBackAction({ ...parentApp, isInstalledApp: false, hasHistory: false, pathname: "/mypage" }),
    { type: "push", href: "/" },
  );
  assert.deepEqual(
    resolveBackAction({ fallbackHref: "/admin", isInstalledApp: false, hasHistory: false, pathname: "/admin/students" }),
    { type: "push", href: "/admin" },
  );
  // 되돌아갈 곳이 지금 화면과 같으면 제자리걸음이라 홈으로.
  assert.deepEqual(
    resolveBackAction({ fallbackHref: "/admin", isInstalledApp: false, hasHistory: false, pathname: "/admin" }),
    { type: "push", href: "/" },
  );
});

test("선생님·관리자 범위는 브라우저에서도 지킨다(2026-11-17) — 역할 홈은 버튼 없음, 하위 화면은 역할 홈으로", () => {
  // 예전엔 «설치된 앱일 때만» 가둬서, 브라우저·스토어 앱에서는 역할 홈의 «←» 가 공개 홈(/)으로 나갔다.
  for (const isInstalledApp of [false, true]) {
    for (const scopeHref of ["/staff", "/admin"]) {
      assert.deepEqual(
        resolveBackAction({ fallbackHref: scopeHref, scopeHref, isInstalledApp, hasHistory: false, pathname: scopeHref }),
        { type: "none" },
        `${scopeHref} 홈(설치 앱 ${isInstalledApp})`,
      );
      assert.deepEqual(
        resolveBackAction({ fallbackHref: scopeHref, scopeHref, isInstalledApp, hasHistory: false, pathname: `${scopeHref}/students` }),
        { type: "push", href: scopeHref },
        `${scopeHref} 하위 화면(설치 앱 ${isInstalledApp})`,
      );
      // fallbackHref 가 범위 밖(공개 홈)이어도 범위 홈으로 간다
      assert.deepEqual(
        resolveBackAction({ fallbackHref: "/", scopeHref, isInstalledApp, hasHistory: false, pathname: `${scopeHref}/students` }),
        { type: "push", href: scopeHref },
      );
      // 기록이 있으면 언제나 이전 화면으로
      assert.deepEqual(
        resolveBackAction({ fallbackHref: scopeHref, scopeHref, isInstalledApp, hasHistory: true, pathname: scopeHref }),
        { type: "back" },
      );
    }
  }
});

test("기사님 전용 계정: 역할 홈을 셔틀 화면으로 받으면 거기서 버튼 없음, 다른 화면은 셔틀 화면으로", () => {
  // /staff 는 이 계정을 운행 화면으로 넘겨 버려서, «←» 가 /staff 로 가면 제자리로 돌아오거나 로그인으로 나갔다.
  const driver = { fallbackHref: "/staff/shuttle", scopeHref: "/staff", isInstalledApp: false, hasHistory: false };
  assert.deepEqual(resolveBackAction({ ...driver, pathname: "/staff/shuttle" }), { type: "none" });
  assert.deepEqual(resolveBackAction({ ...driver, pathname: "/staff/run" }), { type: "push", href: "/staff/shuttle" });
  assert.deepEqual(resolveBackAction({ ...driver, pathname: "/staff/annual" }), { type: "push", href: "/staff/shuttle" });
  assert.deepEqual(resolveBackAction({ ...driver, pathname: "/staff/annual", hasHistory: true }), { type: "back" });
  // 한 단계 위를 받은 하위 화면(선생님 마이페이지 아래)도 같은 길이다
  assert.deepEqual(
    resolveBackAction({ fallbackHref: "/staff/mypage", scopeHref: "/staff", isInstalledApp: false, hasHistory: false, pathname: "/staff/mypage/login-methods" }),
    { type: "push", href: "/staff/mypage" },
  );
});

test("범위 판정은 경로 경계를 지킨다", () => {
  assert.equal(isWithinScope("/mypage", "/mypage"), true);
  assert.equal(isWithinScope("/mypage/reports", "/mypage"), true);
  // 이름만 비슷한 다른 경로를 범위 안으로 보면 안 된다.
  assert.equal(isWithinScope("/mypage-admin", "/mypage"), false);
  assert.equal(isWithinScope("/staff", "/mypage"), false);
});

test("세 역할 화면이 제 범위를 지정해 두었다", async () => {
  const mypage = await readFile("src/app/mypage/layout.tsx", "utf8");
  const staff = await readFile("src/app/staff/layout.tsx", "utf8");
  const admin = await readFile("src/app/admin/AdminShellClient.tsx", "utf8");
  // 관리자 머리줄 «←» 는 한 곳이고 제 범위를 지정한다(빼먹으면 대시보드에서 공개 홈으로 나가는 옛 동작으로 돌아간다)
  const adminButtons = admin.match(/<AppBackButton[^>]*>/g) || [];
  assert.equal(adminButtons.length, 1);
  assert.ok(adminButtons[0].includes('scopeHref="/admin"'));
  // scopeHref 를 빼먹으면 그 화면만 조용히 옛 동작으로 돌아간다.
  assert.equal((mypage.match(/scopeHref="\/mypage"/g) || []).length, 2, "모바일·데스크탑 헤더 둘 다");
  assert.match(staff, /scopeHref="\/staff"/);
});
