// 역할 화면 «뒤로» 공용 장치(2026-11-17) — 선생님·기사님(/staff)·관리자(/admin)에도 학부모와 같은 이동 기록을 쓴다.
//  원칙: 뒤로 = «방금 있던 화면». 기록이 없을 때만 한 단계 위(그 역할의 홈). 다른 역할 화면·로그인·공개 홈(/)으로 나가지 않는다.
//  범위(/mypage·/staff·/admin)마다 저장 키·메모리 기록·첫 기록 판정·떠남·바꿔 끼우기·뒤로 표시가 따로다.
//  학부모 범위의 규칙은 그대로다(tests/parent-back-nav.test.mjs 가 고정) — 여기서는 «서로 섞이지 않는다»만 본다.
//  순수 함수와 저장 대역을 실제로 실행해 검증한다(실제 날짜·시계에 기대는 단정 없음).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const hist = await loadTsModule("src/lib/navigation/inAppHistory.ts");
const { resolveBackAction } = await loadTsModule("src/lib/navigation/backAction.ts");
const read = (p) => readFile(p, "utf8");

const ORIGIN = "https://stiz.example";
/** 문서를 처음 불러온 직후의 판단 재료(대역) */
const env = (referrer, documentPath, { historyLength = 5, navigationType } = {}) => ({ referrer, origin: ORIGIN, historyLength, documentPath, navigationType });

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
/** 새 탭(빈 저장소 + 문서를 막 불러온 상태) */
function freshTab() {
  hist.resetPageLoadStateForTest();
  return memStorage();
}
/** «문서를 새로 불러왔다»(저장소는 남고 모듈 상태만 처음으로) */
const reloadDocument = () => hist.resetPageLoadStateForTest();

/** 머리줄 «←» 가 할 일 — AppBackButton 과 같은 조합(기록 판정 → resolveBackAction). 선생님·관리자는 null 도 «없음» */
function headerBack(scope, stack, pathname, { home = scope, isInstalledApp = false } = {}) {
  return resolveBackAction({
    hasHistory: hist.hasInAppHistory(stack, pathname) === true,
    pathname,
    fallbackHref: home,
    scopeHref: scope,
    isInstalledApp,
  });
}

// ── 1. 범위 판정·저장 키 ─────────────────────────────────────────────────────

test("scopeOfPath — 세 범위만, 경로 경계를 지킨다", () => {
  assert.deepEqual([...hist.HISTORY_SCOPES], ["/mypage", "/staff", "/admin"]);
  assert.equal(hist.scopeOfPath("/staff"), "/staff");
  assert.equal(hist.scopeOfPath("/staff/sessions/abc"), "/staff");
  assert.equal(hist.scopeOfPath("/admin/students/12"), "/admin");
  assert.equal(hist.scopeOfPath("/mypage/reports"), "/mypage");
  for (const outside of ["/", "/login", "/notices", "/staffx", "/administrator", "/mypagex", "/driver/abc", "/account"]) {
    assert.equal(hist.scopeOfPath(outside), null, outside);
  }
  assert.equal(hist.isScopePath("/admin", "/admin"), true);
  assert.equal(hist.isScopePath("/staff/run", "/admin"), false);
  // 새 규칙을 쓰는 범위는 선생님·관리자뿐 — 학부모는 기존 규칙
  assert.equal(hist.staffOrAdminScopeOf("/staff/annual"), "/staff");
  assert.equal(hist.staffOrAdminScopeOf("/admin"), "/admin");
  assert.equal(hist.staffOrAdminScopeOf("/mypage/news"), null);
  assert.equal(hist.staffOrAdminScopeOf("/account"), null);
});

test("학부모 저장 키·범위 값은 예전 그대로다(배포된 탭의 기록이 끊기지 않게), 세 범위의 키는 서로 다르다", () => {
  assert.equal(hist.IN_APP_HISTORY_KEY, "stiz:parent-nav-history:v1");
  assert.equal(hist.IN_APP_REPLACE_KEY, "stiz:parent-nav-replace:v1");
  assert.equal(hist.IN_APP_LEFT_KEY, "stiz:parent-nav-left:v1");
  assert.equal(hist.PARENT_HISTORY_SCOPE, "/mypage");
  assert.equal(hist.scopeHistoryKey("/mypage"), hist.IN_APP_HISTORY_KEY);
  assert.equal(hist.scopeHistoryKey("/staff"), "stiz:staff-nav-history:v1");
  assert.equal(hist.scopeHistoryKey("/admin"), "stiz:admin-nav-history:v1");
  assert.equal(new Set(hist.HISTORY_SCOPES.map((s) => hist.scopeHistoryKey(s))).size, 3);
  // 학부모 표시(떠남·바꿔 끼우기)도 예전 키에 그대로 쓴다
  const store = freshTab();
  hist.markLeftParentScope(store);
  hist.markNextNavigationAsReplace(store);
  assert.equal(store.getItem("stiz:parent-nav-left:v1"), "1");
  assert.equal(store.getItem("stiz:parent-nav-replace:v1"), "1");
  hist.markLeftScope("/staff", store);
  hist.markNextScopeNavigationAsReplace("/admin", store);
  assert.equal(store.getItem("stiz:staff-nav-left:v1"), "1");
  assert.equal(store.getItem("stiz:admin-nav-replace:v1"), "1");
});

// ── 2. 범위별 기록 분리 ──────────────────────────────────────────────────────

test("범위마다 기록이 따로 쌓인다 — 한 범위의 이동이 다른 범위 기록을 건드리지 않는다", () => {
  const store = freshTab();
  hist.recordScopeNavigation("/admin", "/admin", store, env(ORIGIN + "/login", "/admin"));
  hist.recordScopeNavigation("/admin", "/admin/students", store, null);
  hist.recordScopeNavigation("/staff", "/staff", store, env(ORIGIN + "/login", "/admin"));
  hist.recordScopeNavigation("/staff", "/staff/students", store, null);
  hist.recordInAppNavigation("/mypage", store, env(ORIGIN + "/login", "/admin"));

  assert.deepEqual(hist.readScopeHistory("/admin", store), ["/admin", "/admin/students"]);
  assert.deepEqual(hist.readScopeHistory("/staff", store), ["/staff", "/staff/students"]);
  assert.deepEqual(hist.readScopeHistory("/mypage", store), ["/mypage"]);
  assert.deepEqual(hist.readInAppHistory(store), ["/mypage"], "학부모 기존 읽기 함수 = /mypage 범위");
  // 실제로 서로 다른 키에 저장된다
  assert.deepEqual(JSON.parse(store.getItem("stiz:staff-nav-history:v1")), ["/staff", "/staff/students"]);
  assert.deepEqual(JSON.parse(store.getItem("stiz:admin-nav-history:v1")), ["/admin", "/admin/students"]);
  assert.deepEqual(JSON.parse(store.getItem("stiz:parent-nav-history:v1")), ["/mypage"]);
});

test("저장소가 막혀도 범위마다 메모리 기록이 따로다", () => {
  hist.resetPageLoadStateForTest();
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => hist.recordScopeNavigation("/staff", "/staff", blocked, null));
  hist.recordScopeNavigation("/staff", "/staff/annual", blocked, null);
  hist.recordScopeNavigation("/admin", "/admin", blocked, null);
  assert.deepEqual(hist.readScopeHistory("/staff", blocked), ["/staff", "/staff/annual"]);
  assert.deepEqual(hist.readScopeHistory("/admin", blocked), ["/admin"]);
  assert.deepEqual(hist.readScopeHistory("/mypage", blocked), []);
});

test("«뒤로» 표시(popstate)도 범위마다 따로다 — 선생님 화면의 뒤로가 학부모 기록 판정에 섞이지 않는다", () => {
  const store = freshTab();
  // 학부모: 듣는 중 + 링크로 같은 화면에 다시 들어감(뒤로 아님) → 쌓인다(학부모 세션의 2026-11-17 규칙)
  hist.startPopListening();
  hist.recordInAppNavigation("/mypage/reports", store, null);
  hist.recordInAppNavigation("/mypage/reports/s1", store, null);
  hist.noteScopePopNavigation("/staff"); // 선생님 범위의 표시 — 학부모가 읽으면 안 된다
  assert.deepEqual(
    hist.recordInAppNavigation("/mypage/reports", store, null),
    ["/mypage/reports", "/mypage/reports/s1", "/mypage/reports"],
    "선생님 범위의 «뒤로» 표시를 학부모가 읽으면 여기서 한 칸 빠진다",
  );
});

// ── 3. 관리자 ↔ 선생님 «화면 전환» ───────────────────────────────────────────

test("관리자에서 화면 안 이동으로 선생님 화면에 오면 새 기록으로 시작한다 — «←» 가 관리자로 돌아가지 않는다", () => {
  const store = freshTab();
  // 문서는 /admin 에서 불러왔고(로그인 뒤), 관리자 화면을 돌아다녔다
  const adminDoc = env(ORIGIN + "/login", "/admin");
  hist.recordScopeNavigation("/admin", "/admin", store, adminDoc);
  hist.recordScopeNavigation("/admin", "/admin/students", store, adminDoc);
  hist.recordScopeNavigation("/admin", "/admin/students/7", store, adminDoc);
  // 이 탭에 예전 선생님 기록이 남아 있었다고 하자(어제 쓰던 탭)
  store.setItem(hist.scopeHistoryKey("/staff"), JSON.stringify(["/staff", "/staff/students", "/staff/annual"]));

  // «화면 전환» → /staff (새로 불러오기 없음: 문서 경로는 여전히 /admin)
  hist.markLeftScope("/admin", store);
  const staffStack = hist.recordScopeNavigation("/staff", "/staff", store, adminDoc);
  assert.deepEqual(staffStack, ["/staff"], "예전 선생님 기록을 이어 붙이지 않는다");
  assert.deepEqual(headerBack("/staff", staffStack, "/staff"), { type: "none" }, "선생님 홈에서는 버튼 없음(관리자로 back 하지 않는다)");

  // 선생님 화면 안에서 이동하면 그때부터 정상적으로 쌓인다
  const next = hist.recordScopeNavigation("/staff", "/staff/students", store, adminDoc);
  assert.deepEqual(next, ["/staff", "/staff/students"]);
  assert.deepEqual(headerBack("/staff", next, "/staff/students"), { type: "back" });
  // 관리자 기록은 그대로 남아 있다(선생님 이동이 건드리지 않는다)
  assert.deepEqual(hist.readScopeHistory("/admin", store), ["/admin", "/admin/students", "/admin/students/7"]);

  // 다시 «화면 전환» → 관리자: 떠날 때 남긴 표시로 관리자도 새로 시작한다(선생님 화면으로 back 하지 않는다)
  hist.markLeftScope("/staff", store);
  assert.deepEqual(hist.recordScopeNavigation("/admin", "/admin/finance", store, adminDoc), ["/admin/finance"]);
});

test("문서의 앞 주소가 같은 범위였어도, 문서를 범위 밖에서 불러왔으면 첫 기록은 새로 시작한다", () => {
  // 선생님 화면에서 통째 이동으로 관리자 문서를 열었다(referrer = /staff/…) → 화면 안 이동으로 다시 선생님 화면.
  // referrer 만 보면 «선생님 화면 안 새로 불러오기»로 읽혀 예전 기록을 이어 붙일 뻔한 경우다.
  const store = freshTab();
  store.setItem(hist.scopeHistoryKey("/staff"), JSON.stringify(["/staff", "/staff/quick-post"]));
  const stack = hist.recordScopeNavigation("/staff", "/staff/annual", store, env(ORIGIN + "/staff/quick-post", "/admin/gallery"));
  assert.deepEqual(stack, ["/staff/annual"]);
  assert.deepEqual(headerBack("/staff", stack, "/staff/annual"), { type: "push", href: "/staff" });
  // 문서 경로를 못 읽는 브라우저는 그 판정만 건너뛴다(앞 주소가 같은 범위라 이어 간다 — 예전 규칙)
  const other = freshTab();
  other.setItem(hist.scopeHistoryKey("/staff"), JSON.stringify(["/staff", "/staff/quick-post"]));
  assert.deepEqual(
    hist.recordScopeNavigation("/staff", "/staff/annual", other, env(ORIGIN + "/staff/quick-post", null)),
    ["/staff", "/staff/quick-post", "/staff/annual"],
  );
});

test("선생님 화면을 화면 안 이동으로 떠났다 돌아오면(다른 역할·로그인·내 계정) 새로 시작하고, 표시는 한 번만 쓰인다", () => {
  const store = freshTab();
  const staffDoc = env(ORIGIN + "/staff", "/staff");
  hist.recordScopeNavigation("/staff", "/staff", store, staffDoc);
  assert.deepEqual(hist.recordScopeNavigation("/staff", "/staff/mypage", store, staffDoc), ["/staff", "/staff/mypage"]);
  hist.markLeftScope("/staff", store); // «계정 관리»(/account) 또는 «화면 전환» → 관리자
  hist.recordScopeNavigation("/admin", "/admin", store, staffDoc);
  assert.deepEqual(hist.recordScopeNavigation("/staff", "/staff/shuttle", store, staffDoc), ["/staff/shuttle"]);
  assert.deepEqual(hist.recordScopeNavigation("/staff", "/staff/annual", store, staffDoc), ["/staff/shuttle", "/staff/annual"]);
  // 한 범위의 떠남 표시는 다른 범위에 영향을 주지 않는다
  hist.markLeftScope("/staff", store);
  assert.deepEqual(hist.recordScopeNavigation("/admin", "/admin/stats", store, staffDoc), ["/admin", "/admin/stats"]);
});

// ── 4. 새로 불러오기 · R1 ────────────────────────────────────────────────────

test("선생님 화면의 새로 불러오기(StaffDocumentReload 의 location.reload)는 기록을 이어 간다", () => {
  const store = freshTab();
  const first = env(ORIGIN + "/login", "/staff");
  hist.recordScopeNavigation("/staff", "/staff", store, first);
  hist.recordScopeNavigation("/staff", "/staff/students", store, first);
  reloadDocument(); // 같은 주소를 다시 받아 온다 — referrer 는 그대로(/login), 불러온 방식은 reload
  assert.deepEqual(
    hist.recordScopeNavigation("/staff", "/staff/students", store, env(ORIGIN + "/login", "/staff/students", { navigationType: "reload" })),
    ["/staff", "/staff/students"],
  );
  // 다른 사이트에 갔다 브라우저 뒤로로 돌아온 문서(back_forward)도 이어 간다
  reloadDocument();
  assert.deepEqual(
    hist.recordScopeNavigation("/staff", "/staff/students", store, env("", "/staff/students", { navigationType: "back_forward" })),
    ["/staff", "/staff/students"],
  );
});

test("R1 — 기록 맨 끝이 지금 주소여도 «새로고침»이 아니면(범위 밖을 거쳐 통째로 돌아옴) 새로 시작한다", () => {
  // 선생님 홈 → 학생 → (세션 만료) 로그인 화면으로 통째 이동 → 로그인 뒤 같은 주소(/staff/students)로 돌아옴.
  // 예전 판정은 «맨 끝 = 지금 주소»만 보고 새로고침으로 읽어 기록을 이어 붙였다 → «←» 가 로그인 화면으로 back
  const store = freshTab();
  const first = env("", "/staff");
  hist.recordScopeNavigation("/staff", "/staff", store, first);
  hist.recordScopeNavigation("/staff", "/staff/students", store, first);
  reloadDocument();
  const back = hist.recordScopeNavigation("/staff", "/staff/students", store, env(ORIGIN + "/login", "/staff/students", { navigationType: "navigate" }));
  assert.deepEqual(back, ["/staff/students"]);
  assert.deepEqual(headerBack("/staff", back, "/staff/students"), { type: "push", href: "/staff" }, "로그인 화면으로 back 하지 않고 선생님 홈으로");

  // 같은 범위 안에서 통째로 같은 주소를 다시 연 경우(앞 주소가 선생님 화면)는 이어 간다
  const kept = freshTab();
  hist.recordScopeNavigation("/staff", "/staff", kept, first);
  hist.recordScopeNavigation("/staff", "/staff/students", kept, first);
  reloadDocument();
  assert.deepEqual(
    hist.recordScopeNavigation("/staff", "/staff/students", kept, env(ORIGIN + "/staff", "/staff/students", { navigationType: "navigate" })),
    ["/staff", "/staff/students"],
  );
});

test("R1 — 문서의 첫 기록에서도 떠남 표시가 있으면 [지금 화면]으로 새로 시작한다", () => {
  // 관리자 화면을 화면 안 이동으로 떠났다(표시) → 바깥에서 통째 이동으로 같은 관리자 주소에 돌아옴(불러온 방식 reload 로 읽혀도)
  const store = freshTab();
  const first = env("", "/admin");
  hist.recordScopeNavigation("/admin", "/admin", store, first);
  hist.recordScopeNavigation("/admin", "/admin/finance", store, first);
  hist.markLeftScope("/admin", store);
  reloadDocument(); // 새 문서 — 메모리 표시는 사라지고 저장소 표시만 남는다
  const stack = hist.recordScopeNavigation("/admin", "/admin/finance", store, env(ORIGIN + "/admin", "/admin/finance", { navigationType: "reload" }));
  assert.deepEqual(stack, ["/admin/finance"]);
  // 표시는 한 번만 쓰인다
  assert.deepEqual(hist.recordScopeNavigation("/admin", "/admin/stats", store, null), ["/admin/finance", "/admin/stats"]);
});

test("로그인 화면에서 넘어온 선생님 홈 → 한 번 새로 불러와도 홈 한 칸뿐이라 버튼이 없다", () => {
  const store = freshTab();
  // 문서는 /login 에서 불러왔고 화면 안 이동으로 /staff 에 도착
  const afterLogin = hist.recordScopeNavigation("/staff", "/staff", store, env("", "/login"));
  assert.deepEqual(afterLogin, ["/staff"]);
  reloadDocument(); // StaffDocumentReload
  const afterReload = hist.recordScopeNavigation("/staff", "/staff", store, env("", "/staff", { navigationType: "reload" }));
  assert.deepEqual(afterReload, ["/staff"]);
  assert.deepEqual(headerBack("/staff", afterReload, "/staff"), { type: "none" });
});

test("범위 밖(로그인·공개 홈·다른 사이트)에서 통째로 들어오면 예전 기록을 이어 붙이지 않는다", () => {
  for (const scope of ["/staff", "/admin"]) {
    for (const referrer of [ORIGIN + "/login?redirect=" + scope, ORIGIN + "/", "https://accounts.example/o/oauth2", ""]) {
      const store = freshTab();
      store.setItem(hist.scopeHistoryKey(scope), JSON.stringify([scope, `${scope}/a`, `${scope}/b`]));
      assert.deepEqual(
        hist.recordScopeNavigation(scope, `${scope}/c`, store, env(referrer, `${scope}/c`, { navigationType: "navigate" })),
        [`${scope}/c`],
        `${scope} ← ${referrer || "(앞 주소 없음)"}`,
      );
    }
  }
  // 새 탭으로 열려 저장소가 복사된 경우(브라우저 기록 1칸)도 새로 시작
  const copied = freshTab();
  copied.setItem(hist.scopeHistoryKey("/admin"), JSON.stringify(["/admin", "/admin/students"]));
  assert.deepEqual(
    hist.recordScopeNavigation("/admin", "/admin/students", copied, env(ORIGIN + "/admin", "/admin/students", { historyLength: 1, navigationType: "navigate" })),
    ["/admin/students"],
  );
});

test("shouldRestartOnPageLoad — 범위를 넘기면 그 범위 기준으로, 안 넘기면 학부모 기준(기존 호출 그대로)", () => {
  const stack = ["/admin", "/admin/finance"];
  const e = (referrer) => ({ referrer, origin: ORIGIN, historyLength: 5 });
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/admin/stats", e(ORIGIN + "/admin/finance"), "/admin"), false, "관리자 안 통째 이동");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/admin/stats", e(ORIGIN + "/staff"), "/admin"), true, "선생님 화면에서 옴");
  assert.equal(hist.shouldRestartOnPageLoad(stack, "/admin/stats", e(ORIGIN + "/administrator"), "/admin"), true, "비슷한 이름의 다른 경로");
  assert.equal(hist.shouldRestartOnPageLoad(["/mypage"], "/mypage/news", e(ORIGIN + "/mypage")), false);
  assert.equal(hist.shouldRestartOnPageLoad(["/mypage"], "/mypage/news", e(ORIGIN + "/admin")), true);
});

// ── 5. R2 — 여러 칸 한꺼번에 뒤로 ────────────────────────────────────────────

test("R2 — 기록 안에 같은 경로가 있으면 거기까지 잘라낸다(선생님·관리자 규칙)", () => {
  const walk = (...entries) => entries.reduce((stack, e) => hist.nextScopeHistory(stack, e), []);
  // 한 칸 뒤로
  assert.deepEqual(walk("/admin", "/admin/students", "/admin/students/7", "/admin/students"), ["/admin", "/admin/students"]);
  // 두 칸을 한꺼번에(수업 화면 «나가기» 의 history.go(-2) 같은 이동) — 한 칸씩 쌓으면 기록이 실제보다 길어진다
  assert.deepEqual(walk("/staff", "/staff/sessions", "/staff/sessions/s1", "/staff"), ["/staff"]);
  assert.deepEqual(walk("/admin", "/admin/stats", "/admin/students/7", "/admin/finance", "/admin/stats?tab=funnel"), ["/admin", "/admin/stats?tab=funnel"]);
  // 같은 주소는 그대로, 같은 화면에서 쿼리만 바뀌면 맨 끝을 바꿔 끼운다
  assert.deepEqual(walk("/admin", "/admin/inbox", "/admin/inbox"), ["/admin", "/admin/inbox"]);
  assert.deepEqual(walk("/admin", "/admin/inbox?tab=TRIAL", "/admin/inbox?tab=ENROLL"), ["/admin", "/admin/inbox?tab=ENROLL"]);
  // 처음 보는 화면은 쌓는다(최대 개수 유지)
  assert.deepEqual(walk("/staff", "/staff/students", "/staff/annual"), ["/staff", "/staff/students", "/staff/annual"]);
  const many = walk(...Array.from({ length: 40 }, (_, i) => `/admin/students/${i}`));
  assert.equal(many.length, hist.IN_APP_HISTORY_MAX);
  assert.equal(many.at(-1), "/admin/students/39");
  // 원본은 바꾸지 않는다
  const frozen = Object.freeze(["/staff", "/staff/students"]);
  assert.doesNotThrow(() => hist.nextScopeHistory(frozen, "/staff"));
});

test("R2 — 학부모 범위에는 켜지 않는다(학부모 세션의 «링크로 다시 들어간 화면은 쌓는다» 규칙 그대로)", () => {
  const store = freshTab();
  hist.startPopListening();
  for (const e of ["/mypage/history", "/mypage/reports/s1"]) hist.recordInAppNavigation(e, store, null);
  // 링크로(뒤로 아님) 전에 있던 화면에 다시 들어감 → 학부모는 쌓는다
  assert.deepEqual(hist.recordInAppNavigation("/mypage/history", store, null), ["/mypage/history", "/mypage/reports/s1", "/mypage/history"]);
  // 같은 이동을 선생님 범위에서 하면 잘라낸다
  const staff = freshTab();
  hist.startScopePopListening("/staff");
  for (const e of ["/staff/sessions", "/staff/sessions/s1"]) hist.recordScopeNavigation("/staff", e, staff, null);
  assert.deepEqual(hist.recordScopeNavigation("/staff", "/staff/sessions", staff, null), ["/staff/sessions"]);
});

test("수업 진행 화면: 같은 주소의 보호 칸은 기록을 늘리지 않고, «수업 종료» 뒤 홈은 한 칸이다", () => {
  const store = freshTab();
  const doc = env("", "/staff");
  hist.recordScopeNavigation("/staff", "/staff", store, doc);
  hist.recordScopeNavigation("/staff", "/staff/seasonal", store, doc);
  hist.recordScopeNavigation("/staff", "/staff/sessions/s1", store, doc);
  // SessionInProgressClient: history.pushState(같은 주소) — 주소가 같으면 «그대로»
  assert.deepEqual(hist.recordScopeNavigation("/staff", "/staff/sessions/s1", store, doc), ["/staff", "/staff/seasonal", "/staff/sessions/s1"]);
  // «수업 종료» → router.replace('/staff') : 홈이 기록에 있으니 거기까지 잘라낸다 → 홈 한 칸(끝낸 수업으로 back 하는 버튼을 만들지 않는다)
  const afterFinish = hist.recordScopeNavigation("/staff", "/staff", store, doc);
  assert.deepEqual(afterFinish, ["/staff"]);
  assert.deepEqual(headerBack("/staff", afterFinish, "/staff"), { type: "none" });
});

// ── 6. 머리줄 «←» 가 할 일 ───────────────────────────────────────────────────

test("선생님·관리자: 기록 있음 → back, 기록 없는 하위 화면 → 역할 홈으로, 역할 홈 → 버튼 없음(설치 여부와 무관)", () => {
  for (const scope of ["/staff", "/admin"]) {
    for (const isInstalledApp of [false, true]) {
      const walked = [scope, `${scope}/list`, `${scope}/list/3`];
      assert.deepEqual(headerBack(scope, walked, `${scope}/list/3`, { isInstalledApp }), { type: "back" }, `${scope} 기록 있음`);
      assert.deepEqual(headerBack(scope, [`${scope}/list/3`], `${scope}/list/3`, { isInstalledApp }), { type: "push", href: scope }, `${scope} 바로 연 하위 화면`);
      assert.deepEqual(headerBack(scope, [scope], scope, { isInstalledApp }), { type: "none" }, `${scope} 홈`);
      // 아직 기록 전(null)도 «없음»으로 본다(검수 R4) — 옛 referrer 판단으로 넘어가지 않는다
      assert.deepEqual(headerBack(scope, [], `${scope}/list`, { isInstalledApp }), { type: "push", href: scope });
    }
  }
});

test("선생님·관리자: 어떤 조합에서도 범위 밖(공개 홈 «/»·다른 역할 화면)으로 보내지 않는다", () => {
  for (const scopeHref of ["/staff", "/admin"]) {
    for (const pathname of [scopeHref, `${scopeHref}/a`, `${scopeHref}/a/b`]) {
      for (const isInstalledApp of [false, true]) {
        for (const fallbackHref of ["/", "/login", "/mypage", scopeHref]) {
          const action = resolveBackAction({ hasHistory: false, pathname, fallbackHref, scopeHref, isInstalledApp });
          if (action.type === "push") assert.equal(action.href, scopeHref, `${pathname} (fallback ${fallbackHref})`);
          else assert.equal(action.type, "none");
          assert.equal(action.type === "none", pathname === scopeHref);
        }
      }
    }
  }
});

test("학부모 범위의 머리줄 규칙은 그대로다 — 브라우저의 학부모 홈 «←» = 공개 홈(2026-11-15 원장 결정)", () => {
  assert.deepEqual(resolveBackAction({ hasHistory: false, pathname: "/mypage", fallbackHref: "/mypage", scopeHref: "/mypage", isInstalledApp: false }), { type: "push", href: "/" });
  assert.deepEqual(resolveBackAction({ hasHistory: false, pathname: "/mypage", fallbackHref: "/mypage", scopeHref: "/mypage", isInstalledApp: true }), { type: "none" });
  assert.deepEqual(resolveBackAction({ hasHistory: false, pathname: "/mypage/withdraw", fallbackHref: "/mypage/settings", scopeHref: "/mypage", isInstalledApp: true }), { type: "push", href: "/mypage/settings" });
});

test("기록 없이 «←» 로 역할 홈에 가면(바꿔 끼우기) 홈은 한 칸 — 방금 화면으로 되돌아가는 고리가 없다", () => {
  for (const scope of ["/staff", "/admin"]) {
    const store = freshTab();
    const direct = hist.recordScopeNavigation(scope, `${scope}/students/7`, store, env("", `${scope}/students/7`, { historyLength: 1 }));
    assert.deepEqual(direct, [`${scope}/students/7`]);
    assert.deepEqual(headerBack(scope, direct, `${scope}/students/7`), { type: "push", href: scope });
    // AppBackButton: markNextScopeNavigationAsReplace(scope) → router.replace(홈)
    hist.markNextScopeNavigationAsReplace(scope, store);
    const home = hist.recordScopeNavigation(scope, scope, store, null);
    assert.deepEqual(home, [scope], "쌓으면 [상세, 홈] 이 되어 홈의 «←» 가 이미 바뀐 칸의 앞(범위 밖)으로 back 한다");
    assert.deepEqual(headerBack(scope, home, scope), { type: "none" });
    // 표시는 한 번만 쓰인다
    assert.deepEqual(hist.recordScopeNavigation(scope, `${scope}/a`, store, null), [scope, `${scope}/a`]);
  }
});

// ── 7. M1 — 기사님 전용 계정·거쳐 가는 화면 ──────────────────────────────────

test("M1 — «거쳐 가는 화면»은 기록하지 않는다(/staff/driver · /staff/run/open)", async () => {
  assert.deepEqual([...hist.SCOPE_PASS_THROUGH_PATHS], ["/staff/driver", "/staff/run/open"]);
  assert.equal(hist.isPassThroughPath("/staff/driver"), true);
  assert.equal(hist.isPassThroughPath("/staff/driver/"), true);
  assert.equal(hist.isPassThroughPath("/staff/run/open"), true);
  for (const real of ["/staff", "/staff/run", "/staff/shuttle", "/staff/drivers", "/admin"]) assert.equal(hist.isPassThroughPath(real), false, real);
  // 목록이 실제 코드와 맞는지: 두 화면 모두 그리자마자 다른 주소로 넘긴다
  const entry = await read("src/app/staff/driver/DriverEntryClient.tsx");
  assert.match(entry, /window\.location\.replace\(target\)/);
  assert.match(entry, /router\.replace\(target\)/);
  const open = await read("src/app/staff/run/open/page.tsx");
  assert.match(open, /redirect\(`\/driver\/\$\{token\}`\)/);
  assert.doesNotMatch(open, /return </, "화면을 그리지 않는 redirect 전용 주소");
  // 기록 부품이 이 주소들을 건너뛴다
  const tracker = await read("src/components/navigation/ScopeHistoryTracker.tsx");
  assert.match(tracker, /if \(!pathname \|\| !isScopePath\(pathname, scope\) \|\| isPassThroughPath\(pathname\)\) return;/);
});

test("M1 — 기사님 전용 계정: 로그인 → 기사님 첫 화면(기록 안 함) → 운행표. «←» 는 셔틀 화면으로, 셔틀 화면에서는 버튼 없음", () => {
  const store = freshTab();
  // 로그인 뒤 /staff/driver 에 도착(문서) → replace('/staff/run'). /staff/driver 는 기록하지 않으므로 첫 기록은 운행표다
  const run = hist.recordScopeNavigation("/staff", "/staff/run", store, env(ORIGIN + "/login", "/staff/driver", { navigationType: "navigate" }));
  assert.deepEqual(run, ["/staff/run"], "예전엔 [/staff/driver, /staff/run] 로 쌓여 «←» 가 back → 로그인 화면으로 나갔다");
  const driver = { home: "/staff/shuttle" };
  assert.deepEqual(headerBack("/staff", run, "/staff/run", driver), { type: "push", href: "/staff/shuttle" }, "/staff 로 보내면 다시 운행표로 넘어와 제자리");
  hist.markNextScopeNavigationAsReplace("/staff", store);
  const shuttle = hist.recordScopeNavigation("/staff", "/staff/shuttle", store, null);
  assert.deepEqual(shuttle, ["/staff/shuttle"]);
  assert.deepEqual(headerBack("/staff", shuttle, "/staff/shuttle", driver), { type: "none" }, "기사님의 홈 = 셔틀 화면");
  // 일정 탭으로 갔다가 «←» = 방금 있던 셔틀 화면
  const annual = hist.recordScopeNavigation("/staff", "/staff/annual", store, null);
  assert.deepEqual(headerBack("/staff", annual, "/staff/annual", driver), { type: "back" });
  // 기록 없이 연 일정 화면 → 셔틀 화면으로(/staff 아님)
  assert.deepEqual(headerBack("/staff", ["/staff/annual"], "/staff/annual", driver), { type: "push", href: "/staff/shuttle" });
});

// ── 8. 브라우저 판정(가짜 window) ────────────────────────────────────────────

function fakeWindow({ historyLength = 2 } = {}) {
  const storage = memStorage();
  globalThis.window = { sessionStorage: storage, history: { length: historyLength } };
  hist.resetPageLoadStateForTest();
  return storage;
}

test("scopeHistoryDecision — 경로가 속한 범위의 기록만 본다", () => {
  try {
    fakeWindow();
    assert.equal(hist.scopeHistoryDecision("/notices"), null, "공개 사이트는 판단하지 않는다");
    assert.equal(hist.scopeHistoryDecision("/staffx"), null);
    assert.equal(hist.scopeHistoryDecision("/staff"), null, "아직 기록 전");
    hist.recordScopeNavigation("/admin", "/admin");
    hist.recordScopeNavigation("/admin", "/admin/students");
    hist.recordScopeNavigation("/staff", "/staff");
    assert.equal(hist.scopeHistoryDecision("/admin/students"), true);
    assert.equal(hist.scopeHistoryDecision("/staff"), false, "관리자 기록이 길어도 선생님 홈은 «기록 없음»");
    hist.recordScopeNavigation("/staff", "/staff/shuttle");
    assert.equal(hist.scopeHistoryDecision("/staff/shuttle"), true);
    assert.equal(hist.scopeHistoryDecision("/staff/annual"), null, "기록 전 화면은 보류(부르는 쪽이 «없음»으로 본다)");
    // 학부모 전용 함수는 학부모 화면만 답한다(기존 동작)
    assert.equal(hist.parentHistoryDecision("/staff/shuttle"), null);
    assert.equal(hist.parentHistoryDecision("/admin/students"), null);

    // 새 탭으로 열려 저장소가 복사된 경우 — 브라우저 기록은 1칸이라 back 하면 안 된다
    fakeWindow({ historyLength: 1 });
    hist.recordScopeNavigation("/admin", "/admin");
    hist.recordScopeNavigation("/admin", "/admin/finance");
    assert.equal(hist.scopeHistoryDecision("/admin/finance"), false);
  } finally {
    delete globalThis.window;
  }
});

test("기록이 바뀌면 범위와 상관없이 구독자에게 알린다(뒤로 버튼 다시 그리기)", () => {
  try {
    fakeWindow();
    let calls = 0;
    const before = hist.inAppHistoryVersion();
    const off = hist.subscribeInAppHistory(() => { calls += 1; });
    hist.recordScopeNavigation("/staff", "/staff");
    hist.recordScopeNavigation("/admin", "/admin");
    off();
    hist.recordInAppNavigation("/mypage");
    assert.equal(calls, 2);
    assert.equal(hist.inAppHistoryVersion(), before + 3);
  } finally {
    delete globalThis.window;
  }
});

// ── 9. 소스 검사: 부품이 제자리에 놓였나 ─────────────────────────────────────

test("선생님 layout·관리자 껍데기에 기록 부품이 한 번씩 놓인다(Suspense 안)", async () => {
  const staff = await read("src/app/staff/layout.tsx");
  const admin = await read("src/app/admin/AdminShellClient.tsx");
  assert.match(staff, /<Suspense fallback=\{null\}>\s*<ScopeHistoryTracker scope="\/staff" \/>\s*<\/Suspense>/);
  assert.match(admin, /<Suspense fallback=\{null\}>\s*<ScopeHistoryTracker scope="\/admin" \/>\s*<\/Suspense>/);
  assert.equal((staff.match(/<ScopeHistoryTracker/g) || []).length, 1);
  assert.equal((admin.match(/<ScopeHistoryTracker/g) || []).length, 1);
  // 기사님 전용 계정은 홈·기록 없을 때 갈 곳이 셔틀 화면(M1) — 머리줄 «←» 와 로고 둘 다
  assert.match(staff, /isDriverOnly \? \(\s*<AppBackButton fallbackHref="\/staff\/shuttle" scopeHref="\/staff" \/>/);
  const logo = await read("src/app/staff/StaffHomeLink.tsx");
  assert.match(logo, /const homeHref = isDriver \? "\/staff\/shuttle" : "\/staff";/);
  assert.match(logo, /href=\{homeHref\}/);
  assert.match(logo, /window\.location\.assign\(homeHref\)/);
  assert.match(logo, /await prepareStaffNavigation\(\)/, "수업 중 저장 확인 흐름은 그대로");
});

test("ScopeHistoryTracker — 범위 안 주소만 기록하고, 뒤로를 듣고, 범위를 떠나면 떠남 표시를 남긴다", async () => {
  const src = await read("src/components/navigation/ScopeHistoryTracker.tsx");
  assert.match(src, /recordScopeNavigation\(scope, entryOf\(pathname, search\)\)/);
  assert.match(src, /startScopePopListening\(scope\)/);
  assert.match(src, /noteScopePopNavigation\(scope\)/);
  assert.match(src, /window\.addEventListener\("popstate", onPop\)/);
  assert.match(src, /if \(!isScopePath\(window\.location\.pathname, scope\)\) markLeftScope\(scope\)/);
});

test("공통 뒤로 버튼 — 선생님·관리자는 범위 기록만 보고(null 도 없음), 학부모·공개 판단은 그대로", async () => {
  const button = await read("src/components/AppBackButton.tsx");
  // R4: 범위 안에서는 === true 일 때만 «있음» — referrer·idx 로 넘어가지 않는다
  assert.match(button, /if \(staffOrAdminScope\(pathname, scopeHref\)\) return scopeHistoryDecision\(pathname\) === true;/);
  // 그 판정이 옛 판단(referrer)보다 먼저 나온다
  assert.ok(button.indexOf("scopeHistoryDecision(pathname) === true") < button.indexOf("document.referrer"));
  // 학부모·공개 판단은 그대로 남아 있다
  assert.ok(button.includes("if (parentDecision !== null) return parentDecision;"));
  assert.match(button, /previousEntryState\(/);
  assert.match(button, /document\.referrer/);
  // 기록 없이 역할 홈으로 갈 때 그 범위에 «바꿔 끼우기» 표시를 남긴다
  assert.match(button, /markNextScopeNavigationAsReplace\(strictTarget\)/);
  assert.match(button, /router\.replace\(action\.href\)/);
  // 서버가 그린 첫 화면(기록 없음)과 브라우저 첫 그림을 맞춘다 — 역할 홈의 빈 자리와 버튼이 어긋나지 않게
  assert.match(button, /hasHistory: \(strictScope === null \|\| hydrated\) && canGoBackWithinApp\(pathname, scopeHref\)/);
  // 거쳐 가는 화면에는 버튼을 두지 않는다
  assert.match(button, /strictScope !== null && isPassThroughPath\(pathname\)/);
});

test("ScopeBackLink — 기록 있으면 한 칸 뒤로, 없으면 고정 주소로 바꿔 끼움, 새 탭 클릭은 기본 동작", async () => {
  const src = await read("src/components/navigation/ScopeBackLink.tsx");
  assert.match(src, /^"use client";/);
  assert.match(src, /if \(currentScope && scopeHistoryDecision\(current\) === true\) \{\s*event\.preventDefault\(\);\s*window\.history\.back\(\);\s*return;/);
  assert.match(src, /if \(targetScope && targetScope === currentScope\) markNextScopeNavigationAsReplace\(targetScope\)/);
  assert.match(src, /<Link href=\{fallbackHref\} replace=\{targetScope !== null\}/);
  // 훅을 쓰지 않는다 — 서버 화면 안에 그대로 넣을 수 있게
  assert.doesNotMatch(src, /useRouter|usePathname/);
  assert.match(src, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(src, /<span aria-hidden="true">←<\/span>/);
});

/** 고정 목적지 뒤로 링크 → ScopeBackLink 로 바꾼 곳(파일: 기록 없을 때 갈 주소) */
// «청구·수납으로»처럼 목적지 이름이 적힌 링크(청구 준비·월 장부·월 운영 장부)는 글자대로 가야 해서 고정 주소 그대로 둔다(검수 권고).
const SCOPE_BACK_LINKS = {
  "src/app/admin/students/[id]/StudentDetailClient.tsx": "/admin/students",
  "src/app/admin/attendance/report/[sessionId]/ReportEditClient.tsx": "/admin/attendance/feed",
  "src/app/admin/classes/[id]/ClassDetailClient.tsx": "/admin/classes",
  "src/app/admin/inbox/settings/page.tsx": "/admin/inbox",
  "src/app/admin/staff/recovery/StaffInviteRecoveryClient.tsx": "/admin/staff",
  "src/app/admin/not-found.tsx": "/admin",
  "src/components/staff/LessonWorkspacePanels.tsx": "/staff/sessions",
  "src/components/shuttle/intake/ShuttleIntakeClient.tsx": "/staff/shuttle",
  "src/app/staff/shuttle/assign/DriverAssignClient.tsx": "/staff/shuttle",
};

test("관리자·선생님 화면의 고정 «← 목록» 링크 9곳은 ScopeBackLink(기록 우선, 없으면 예전 주소)", async () => {
  assert.equal(Object.keys(SCOPE_BACK_LINKS).length, 9);
  for (const [file, fallback] of Object.entries(SCOPE_BACK_LINKS)) {
    const src = await read(file);
    assert.ok(src.includes(`<ScopeBackLink fallbackHref="${fallback}"`) || new RegExp(`<ScopeBackLink\\s+fallbackHref="${fallback}"`).test(src), `${file}: ScopeBackLink(${fallback})`);
    assert.match(src, /import ScopeBackLink from "@\/components\/navigation\/ScopeBackLink";/, file);
  }
  // 원생 상세는 오류 화면의 «원생 목록으로 돌아가기»까지 두 곳
  const student = await read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.equal((student.match(/<ScopeBackLink fallbackHref="\/admin\/students"/g) || []).length, 2);
  assert.doesNotMatch(student, /<Link href="\/admin\/students" /, "고정 주소 «← 목록» Link 가 남아 있다");
  // 겉 글자는 그대로다
  assert.match(student, /← 목록\s*<\/ScopeBackLink>/);
  assert.match(await read("src/app/admin/not-found.tsx"), /← 이전 화면\s*<\/ScopeBackLink>/);
  assert.match(await read("src/components/staff/LessonWorkspacePanels.tsx"), /← 지난 수업<\/ScopeBackLink>/);
});

test("내 계정(/account) 화면에 «←» 가 있다 — 바로 앞 같은 사이트 화면으로, 없으면 역할 홈(/auth/continue)", async () => {
  const account = await read("src/app/account/page.tsx");
  assert.match(account, /<ParentBackLink fallbackHref="\/auth\/continue" ariaLabel="이전 화면으로" className="academy-back-link" \/>/);
  // ParentBackLink 는 학부모 화면 밖에서 브라우저의 «바로 앞 같은 사이트 화면»으로 판단한다(학부모 세션 2026-11-17 규칙)
  const link = await read("src/components/parent/ParentBackLink.tsx");
  assert.match(link, /decision === null && browserPreviousPath\(\) !== null && window\.history\.length > 1/);
});

test("학부모 부품은 기존 이름 그대로 쓴다(이번 변경에서 손대지 않음)", async () => {
  const tracker = await read("src/components/parent/ParentHistoryTracker.tsx");
  assert.match(tracker, /recordInAppNavigation\(entryOf\(pathname, search\)\)/);
  assert.match(tracker, /markLeftParentScope\(\)/);
  assert.match(tracker, /startPopListening\(\)/);
  assert.match(tracker, /notePopNavigation\(\)/);
  for (const name of ["parentHistoryDecision", "recordInAppNavigation", "markLeftParentScope", "isParentScopePath", "markNextNavigationAsReplace", "readInAppHistory", "notePopNavigation", "startPopListening", "nextInAppHistory", "shouldRestartOnPageLoad"]) {
    assert.equal(typeof hist[name], "function", name);
  }
});
