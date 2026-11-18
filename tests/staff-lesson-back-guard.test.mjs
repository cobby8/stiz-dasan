// 선생님 화면 «뒤로» 규칙(2026-11-18 원장 승인 «전부 추천대로»)
//  A. 창·아래 시트가 열린 채 뒤로 → 창만 닫힌다(저장 중인 창은 안 닫힘, 겹친 창은 위부터)
//  B. 선생님 홈의 줄 안에서 수업 진행 중에 뒤로 → «저장하고 나갈까요» → 저장 성공 뒤에만 나감
//  C. 수업을 끝낸 뒤 뒤로 → 수업에 들어오기 전 화면(끝낸 수업 화면이 다시 열리지 않는다)
// 판단·기록 칸 다루기(lessonBackGuard.ts)는 가짜 브라우저 기록으로 실제 실행하고, 화면 연결은 소스로 못박는다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const overlay = await loadTsModule("src/lib/navigation/overlayHistory.ts");
const guardModule = await loadTsModule("src/app/staff/lessonBackGuard.ts");
const { isLessonGuardBase, createHomeLessonGuard, unwindToLessonGuardBase, waitOverlayEntriesGone, releaseActiveLessonGuard, leaveLessonScreen, HOME_LESSON_GUARD_KEY } = guardModule;
const read = (p) => readFile(p, "utf8");

test.beforeEach(() => {
  overlay.resetOverlayHistoryForTest();
  guardModule.resetLessonGuardForTest();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 브라우저 기록 흉내 — back()/go() 는 비동기로 popstate 를 낸다.
 * 0ms 타이머는 settle() 이 돌리고, 기다림 한도(400ms) 타이머는 expire() 를 불러야 돈다.
 */
function fakeWindow(urls = ["/prev", "/staff"], { navigationApi = false } = {}) {
  const entries = urls.map((url) => ({ url, state: { __NA: true } }));
  let index = entries.length - 1;
  const listeners = new Set();
  const unloadListeners = new Set();
  const tasks = [];
  const timers = [];
  const win = {
    history: {
      get state() { return entries[index].state; },
      // length 는 «앞으로 칸»까지 센다(브라우저와 같다) — 가드는 이 값에 기대면 안 된다
      get length() { return entries.length; },
      pushState(state) { entries.splice(index + 1); entries.push({ url: entries[index].url, state }); index += 1; },
      replaceState(state) { entries[index] = { url: entries[index].url, state }; },
      back() { win.history.go(-1); },
      go(delta) {
        tasks.push(() => {
          const next = index + delta;
          if (next < 0 || next >= entries.length) return;
          index = next;
          [...listeners].forEach((listener) => listener());
        });
      },
    },
    location: { get href() { return `https://x.example${entries[index].url}`; } },
    addEventListener(type, listener) { (type === "popstate" ? listeners : unloadListeners).add(listener); },
    removeEventListener(type, listener) { (type === "popstate" ? listeners : unloadListeners).delete(listener); },
    /** 다른 문서로 떠나기 시작함(pagehide) */
    unload() { [...unloadListeners].forEach((listener) => listener()); },
    /** 0ms 타이머만 돌린다(예약된 기록 이동은 아직 닿지 않은 상태) */
    runZeroTimers() {
      for (let i = timers.findIndex((timer) => timer.ms === 0); i >= 0; i = timers.findIndex((timer) => timer.ms === 0)) timers.splice(i, 1)[0].fn();
    },
    get allEntries() { return entries.map((entry) => entry.url); },
    reload() { listeners.clear(); unloadListeners.clear(); tasks.length = 0; timers.length = 0; },
    setTimeout(fn, ms) { timers.push({ fn, ms }); },
    /** 링크 이동(router.push) 흉내 */
    navigate(url) { entries.splice(index + 1); entries.push({ url, state: { __NA: true } }); index += 1; },
    /** 화면 바꿔 끼우기(router.replace) 흉내 */
    replaceUrl(url) { entries[index] = { url, state: { __NA: true } }; },
    /** Next 의 서버 기능·router.refresh 뒤 — «지금 칸»을 표시 없이 덮어쓴다 */
    wipe() { entries[index] = { url: entries[index].url, state: { __NA: true } }; },
    async settle() {
      for (let i = 0; i < 200; i += 1) {
        await tick();
        if (tasks.length) { tasks.shift()(); continue; }
        const zero = timers.findIndex((timer) => timer.ms === 0);
        if (zero >= 0) { timers.splice(zero, 1)[0].fn(); continue; }
        await tick();
        if (!tasks.length && !timers.some((timer) => timer.ms === 0)) return;
      }
      throw new Error("가짜 기록이 가라앉지 않습니다");
    },
    /** 기다림 한도가 지났다 */
    async expire() {
      for (const timer of timers.splice(0)) timer.fn();
      await win.settle();
    },
    /** 지금 칸까지의 주소(앞으로 가기 칸은 뺀다) */
    get entries() { return entries.slice(0, index + 1).map((entry) => entry.url); },
    get top() { return entries[index]; },
    get url() { return entries[index].url; },
  };
  if (navigationApi) {
    win.navigation = {
      get currentEntry() { return { index }; },
      entries() { return entries.map((entry) => ({ url: `https://x.example${entry.url}` })); },
    };
  }
  return win;
}

/** 홈 가드 + 기록(무엇을 몇 번 물었고·저장했고·안내했는지) */
function homeGuard(win, { confirm = async () => true, save = async () => ({ ok: true }) } = {}) {
  const log = { asked: 0, saved: 0, failed: [], noPrevious: 0 };
  const guard = createHomeLessonGuard(win, {
    confirmLeave: () => { log.asked += 1; return confirm(); },
    save: () => { log.saved += 1; return save(); },
    onSaveFailed: (message) => log.failed.push(message),
    onNoPrevious: () => { log.noPrevious += 1; },
  });
  return { guard, log };
}

/** 기기 뒤로 한 번 */
async function pressBack(win) {
  win.history.back();
  await win.settle();
}

test("바닥 칸 판단 — 바닥 표시만 있는 칸일 때만 «나가려는 뒤로»", () => {
  const key = "staff-session-abc";
  const base = { __NA: true, staffSessionGuardBase: key };
  assert.equal(isLessonGuardBase(base, key), true);
  // 가드 칸(표시가 남은 것 · 바닥 표시를 이어받은 것)
  assert.equal(isLessonGuardBase({ __NA: true, staffSessionGuard: key }, key), false);
  assert.equal(isLessonGuardBase({ ...base, staffSessionGuard: key }, key), false);
  // 가드 칸의 표시가 서버 기능 뒤에 지워진 것 — 그래도 «나가기»가 아니다(창이 닫히며 돌아온 칸)
  assert.equal(isLessonGuardBase({ __NA: true }, key), false);
  // 창 칸(바닥 표시를 이어받았어도)
  assert.equal(isLessonGuardBase({ ...base, [overlay.OVERLAY_HISTORY_MARK]: 1 }, key), false);
  // 다른 수업의 바닥 칸·빈 값
  assert.equal(isLessonGuardBase({ staffSessionGuardBase: "staff-session-other" }, key), false);
  for (const state of [null, undefined, "x", 3]) assert.equal(isLessonGuardBase(state, key), false);
});

test("B: 켜면 [앞 화면][바닥][가드] — 뒤로를 누르면 묻고, «그만»이면 그대로 머문다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win, { confirm: async () => false });
  guard.enable();
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"], "같은 주소의 가드 칸 하나");
  assert.equal(win.top.state.__NA, true, "Next 내부 표시는 이어받는다");
  await pressBack(win);
  assert.equal(log.asked, 1);
  assert.equal(log.saved, 0, "그만이면 저장도 이동도 하지 않는다");
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"], "가드 칸을 되살려 화면을 지킨다");
  // 다시 눌러도 다시 묻는다(가드가 살아 있다)
  await pressBack(win);
  assert.equal(log.asked, 2);
  assert.equal(win.url, "/staff");
});

test("B: «확인» → 저장 성공 뒤에만 나간다(들어오기 전 화면으로)", async () => {
  const win = fakeWindow();
  const order = [];
  const { guard, log } = homeGuard(win, {
    confirm: async () => { order.push("confirm"); return true; },
    save: async () => { order.push(`save@${win.url}`); return { ok: true }; },
  });
  guard.enable();
  await pressBack(win);
  assert.deepEqual(order, ["confirm", "save@/staff"], "저장하는 동안은 아직 홈이다");
  assert.equal(log.saved, 1);
  assert.deepEqual(win.entries, ["/prev"], "가드 칸·바닥 칸 두 칸을 건너 앞 화면으로");
});

test("B: 저장 실패면 머무르고 안내한다 — 가드는 그대로", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win, { save: async () => ({ ok: false, message: "음성 메모 처리가 끝난 뒤 이동해 주세요." }) });
  guard.enable();
  await pressBack(win);
  assert.deepEqual(log.failed, ["음성 메모 처리가 끝난 뒤 이동해 주세요."]);
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"]);
  // 저장이 예외로 끝나도 나가지 않는다
  const win2 = fakeWindow();
  const second = homeGuard(win2, { save: async () => { throw new Error("network"); } });
  second.guard.enable();
  await pressBack(win2);
  assert.equal(second.log.failed.length, 1);
  assert.equal(win2.url, "/staff");
  await pressBack(win2);
  assert.equal(second.log.asked, 2, "다시 누르면 다시 묻는다");
});

test("B: 확인 창이 떠 있는 동안 뒤로를 또 눌러도 한 번만 묻는다", async () => {
  const win = fakeWindow();
  let answer;
  const { guard, log } = homeGuard(win, { confirm: () => new Promise((resolve) => { answer = resolve; }) });
  guard.enable();
  await pressBack(win);
  await pressBack(win);
  assert.equal(log.asked, 1);
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"]);
  answer(false);
  await win.settle();
  assert.equal(win.url, "/staff");
});

test("B: 앞 화면이 없으면(앱을 이 화면에서 켬) 저장하고 가드 칸만 걷는다", async () => {
  const win = fakeWindow(["/staff"]);
  const { guard, log } = homeGuard(win);
  guard.enable();
  await pressBack(win);
  assert.equal(log.saved, 1);
  // «두 칸 뒤로»가 무시됐다 — 기다림 한도 뒤에 «앞 화면 없음»으로 처리한다
  await win.expire();
  assert.equal(log.noPrevious, 1);
  assert.deepEqual(win.entries, ["/staff"]);
});

test("L-1: 창이 칸을 넣었다 빼 history.length 가 2여도 — 앞 화면이 없으면 굳지 않고 안내한다", async () => {
  for (const navigationApi of [false, true]) {
    overlay.resetOverlayHistoryForTest();
    const win = fakeWindow(["/staff"], { navigationApi });
    const { guard, log } = homeGuard(win);
    // «수업 시작» 창이 열렸다 닫힘 — 앞으로 칸이 남아 length 는 2
    const startModal = overlay.bindOverlayToHistory(win, () => {});
    startModal.release();
    guard.enable({ afterWindowClose: true });
    await win.settle();
    assert.equal(win.history.length, 2, "앞 화면은 없는데 length 는 2");
    assert.deepEqual(win.entries, ["/staff", "/staff"], "[바닥][가드]");
    await pressBack(win);
    await win.expire();
    assert.equal(log.asked, 1);
    assert.equal(log.saved, 1, `저장은 한 번(navigationApi=${navigationApi})`);
    assert.equal(log.noPrevious, 1, `«한 번 더 누르면 나갑니다» 안내(navigationApi=${navigationApi})`);
    assert.deepEqual(win.entries, ["/staff"], "가드 칸은 걷혔다");
    assert.equal(guard.isLive(), false);
    // 그 뒤의 뒤로는 묻지 않는다(브라우저·앱의 기본 동작으로 나간다)
    await pressBack(win);
    await win.expire();
    assert.equal(log.asked, 1);
  }
});

test("L-3: 가드 표시가 지워진 칸에서 새로고침해 가드가 두 겹이어도 — 한 번의 확인으로 실제 앞 화면까지", async () => {
  for (const navigationApi of [false, true]) {
    for (const urls of [["/prev", "/staff"], ["/staff"]]) {
      overlay.resetOverlayHistoryForTest();
      guardModule.resetLessonGuardForTest();
      const win = fakeWindow(urls, { navigationApi });
      homeGuard(win).guard.enable();
      win.wipe(); // 출결 저장 뒤 가드 칸 표시가 지워짐 → 그 칸에서 새로고침(화면·가드가 새로 만들어진다)
      win.reload();
      guardModule.resetLessonGuardForTest();
      const { guard, log } = homeGuard(win);
      guard.enable();
      assert.equal(win.entries.length, urls.length + 2, "같은 주소 칸이 한 겹 더 쌓였다");
      await pressBack(win);
      await win.expire();
      assert.equal(log.asked, 1);
      assert.equal(log.saved, 1);
      const label = `navigationApi=${navigationApi} urls=${urls}`;
      if (urls.length === 2) {
        assert.deepEqual(win.entries, ["/prev"], `옛 바닥에 멈추지 않고 앞 화면으로(${label})`);
        assert.equal(log.noPrevious, 0, label);
      } else {
        assert.deepEqual(win.entries, ["/staff"], `맨 아래 칸까지 내려가 가드 칸이 남지 않는다(${label})`);
        assert.equal(log.noPrevious, 1, label);
      }
    }
  }
});

test("나가기: 다른 문서로 떠나는 중이면(popstate 없이 pagehide) 더 뒤로 보내지 않는다 · Navigation API 가 있으면 한 번에 간다", async () => {
  // 안전망: go(-2) 뒤 pagehide — 떠난 것으로 본다
  const win = fakeWindow(["/login", "/staff", "/staff"]);
  let backs = 0;
  const realGo = win.history.go;
  win.history.go = (delta) => { backs += 1; if (backs === 1) return; realGo(delta); }; // 첫 이동은 다른 문서로(이 문서엔 popstate 가 안 온다)
  const leaving = leaveLessonScreen(win);
  await tick();
  win.unload();
  assert.equal(await leaving, true);
  await win.expire();
  assert.equal(backs, 1, "한 번만 보냈다");
  // Navigation API: 기다리지 않고 정확한 칸으로 한 번에
  const win2 = fakeWindow(["/prev", "/staff", "/staff", "/staff"], { navigationApi: true });
  assert.equal(await leaveLessonScreen(win2), true);
  await win2.settle();
  assert.deepEqual(win2.entries, ["/prev"]);
});

test("L-2: 접자마자 다시 펼쳐도(칸 되돌리기가 날아가는 중) 확인 창이 저절로 뜨지 않고 칸이 쌓이지 않는다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  guard.disable();
  win.runZeroTimers(); // 끄기가 «칸 되돌리기»를 보냈다 — 아직 닿지 않았다
  assert.equal(guard.isLive(), false);
  guard.enable(); // 그사이 다시 펼침
  await win.settle();
  assert.equal(log.asked, 0, "되돌리기가 바닥에 닿는 것을 «나가기»로 묻지 않는다");
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"], "[앞][바닥][가드] — 한 겹");
  assert.deepEqual(win.allEntries, ["/prev", "/staff", "/staff"], "앞으로 칸에도 쌓이지 않았다");
  assert.equal(guard.isLive(), true);
  await pressBack(win);
  assert.equal(log.asked, 1, "가드는 살아 있다");
  // 다시 펼치기 전에 또 접으면 넣지 않는다
  const win2 = fakeWindow();
  const second = homeGuard(win2);
  second.guard.enable();
  second.guard.disable();
  win2.runZeroTimers();
  second.guard.enable();
  second.guard.disable();
  await win2.settle();
  await win2.expire();
  assert.deepEqual(win2.entries, ["/prev", "/staff"]);
  assert.equal(second.log.asked, 0);
});

test("B: 수업이 진행 중이 아니면(켜지 않으면) 기록 칸을 넣지 않는다 — 홈의 평소 뒤로 그대로", async () => {
  const win = fakeWindow();
  const { log } = homeGuard(win);
  assert.deepEqual(win.entries, ["/prev", "/staff"]);
  await pressBack(win);
  assert.equal(log.asked, 0);
  assert.equal(win.url, "/prev");
});

test("A+B: 가드 위에서 창을 열고 뒤로 → 창만 닫힌다(묻지 않는다) — 가드 칸 표시가 지워져 있어도", async () => {
  for (const wiped of [false, true]) {
    overlay.resetOverlayHistoryForTest();
    const win = fakeWindow();
    const { guard, log } = homeGuard(win);
    guard.enable();
    // 출결 저장 같은 서버 기능 뒤 — Next 가 가드 칸의 표시를 지운다
    if (wiped) win.wipe();
    let closed = 0;
    overlay.bindOverlayToHistory(win, () => { closed += 1; });
    assert.equal(win.entries.length, 4, "[앞][바닥][가드][창]");
    if (wiped) win.wipe(); // 창이 열린 동안에도 지워질 수 있다
    await pressBack(win);
    assert.equal(closed, 1, `창이 닫힌다(wiped=${wiped})`);
    assert.equal(log.asked, 0, `창이 닫힌 것을 «나가기»로 오해하지 않는다(wiped=${wiped})`);
    assert.equal(win.entries.length, 3);
    // 창이 닫힌 뒤의 뒤로는 묻는다
    await pressBack(win);
    assert.equal(log.asked, 1);
  }
});

test("A+B: 창을 닫기 버튼으로 닫아도(칸 되돌리기) 묻지 않는다 · 겹친 창은 위부터", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  const closed = [];
  const sheet = overlay.bindOverlayToHistory(win, () => closed.push("sheet"));
  overlay.bindOverlayToHistory(win, () => closed.push("dialog"));
  assert.equal(win.entries.length, 5);
  await pressBack(win);
  assert.deepEqual(closed, ["dialog"], "위 창부터");
  sheet.release();
  await win.settle();
  assert.equal(win.entries.length, 3, "가드 칸은 그대로");
  assert.equal(log.asked, 0);
});

test("A+B: 저장 중인 창은 뒤로로 닫히지 않는다 — 가드도 묻지 않는다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  let saving = true;
  let closed = 0;
  overlay.bindOverlayToHistory(win, () => { closed += 1; }, { isBlocked: () => saving });
  await pressBack(win);
  assert.equal(closed, 0);
  assert.equal(log.asked, 0);
  assert.equal(win.entries.length, 4, "창 칸을 다시 넣어 그대로");
  saving = false;
  await pressBack(win);
  assert.equal(closed, 1);
  assert.equal(log.asked, 0);
});

test("B: 확인 창 자체가 기록 칸을 쓰는 창이어도(공용 확인 창) «확인» 뒤 앞 화면에 정확히 닿는다", async () => {
  const win = fakeWindow();
  // 공용 확인 창(askConfirm)과 같은 방식: 열 때 칸을 넣고, «확인»을 누르면 칸을 되돌린 «뒤»에 결과를 준다. 뒤로 = 그만
  const confirm = () => new Promise((resolve) => {
    const handle = overlay.bindOverlayToHistory(win, () => resolve(false));
    win.setTimeout(() => handle.leaveTo("(close)", () => resolve(true)), 0);
  });
  const { guard, log } = homeGuard(win, { confirm });
  guard.enable();
  await pressBack(win);
  assert.equal(log.saved, 1);
  assert.deepEqual(win.entries, ["/prev"]);
});

test("B: 확인 창이 떠 있을 때 뒤로 = 그만 — 머문다", async () => {
  const win = fakeWindow();
  const confirm = () => new Promise((resolve) => { overlay.bindOverlayToHistory(win, () => resolve(false)); });
  const { guard, log } = homeGuard(win, { confirm });
  guard.enable();
  await pressBack(win); // 가드가 묻는다(확인 창 칸이 생긴다)
  assert.equal(win.entries.length, 4);
  await pressBack(win); // 확인 창만 닫힌다
  assert.equal(log.asked, 1, "확인 창이 닫힌 것을 «나가기»로 다시 묻지 않는다");
  assert.equal(log.saved, 0);
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"]);
});

test("B: 수업 칸을 접으면 가드 칸을 되돌린다 — 그 뒤의 뒤로는 평소처럼 앞 화면", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  guard.disable();
  await win.settle();
  assert.deepEqual(win.entries, ["/prev", "/staff"]);
  assert.equal(log.asked, 0, "되돌리는 칸을 «나가기»로 묻지 않는다");
  await pressBack(win);
  assert.equal(log.asked, 0);
  assert.equal(win.url, "/prev");
});

test("B: 끄자마자 다시 켜도(개발 모드 이중 실행) 칸은 하나 · 묻지 않는다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  guard.disable();
  guard.enable();
  await win.settle();
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"]);
  assert.equal(log.asked, 0);
  await pressBack(win);
  assert.equal(log.asked, 1, "가드는 살아 있다");
});

test("C(홈): 종료 확인 창에서 수업을 끝내면 창 칸·가드 칸이 모두 걷힌다 — 뒤로 = 들어오기 전 화면", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  win.wipe(); // 수업 중 출결 저장
  // 종료 확인 창(처리 중이라 뒤로는 막혀 있다)
  const endDialog = overlay.bindOverlayToHistory(win, () => {}, { isBlocked: () => true });
  win.wipe(); // 종료 처리(서버 기능)
  // 종료 성공: 같은 순간에 창이 닫히고(release) 수업 줄이 «완료»로 바뀐다(가드 끄기)
  endDialog.release();
  guard.disable();
  await win.settle();
  assert.deepEqual(win.entries, ["/prev", "/staff"], "수업 중에 쌓인 칸이 남지 않는다");
  assert.equal(log.asked, 0);
  await pressBack(win);
  assert.equal(win.url, "/prev");
  assert.equal(log.asked, 0);
});

test("B: «수업 시작» 창이 닫히면서 수업이 시작되면 — 창 칸이 빠진 뒤에 가드 칸을 넣는다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  const startModal = overlay.bindOverlayToHistory(win, () => {});
  win.wipe(); // 수업 시작(서버 기능)이 창 칸의 표시를 지운다
  // 같은 순간: 창 닫힘(칸 되돌리기 예약) + 수업 줄이 «수업 중»으로
  startModal.release();
  guard.enable({ afterWindowClose: true });
  await win.settle();
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"], "[앞][바닥][가드] — 창 칸 위에 넣지 않았다");
  assert.equal(log.asked, 0, "수업을 시작하자마자 «나갈까요»가 뜨지 않는다");
  await pressBack(win);
  assert.equal(log.asked, 1);
  // 창이 뒤로로 이미 닫혀 더 올 popstate 가 없어도, 기다림 한도 뒤에는 넣는다
  const win2 = fakeWindow();
  const second = homeGuard(win2);
  second.guard.enable({ afterWindowClose: true });
  await win2.settle();
  assert.deepEqual(win2.entries, ["/prev", "/staff"]);
  await win2.expire();
  assert.deepEqual(win2.entries, ["/prev", "/staff", "/staff"]);
  // 기다리는 사이 수업 칸이 접혔으면 넣지 않는다
  const win3 = fakeWindow();
  const third = homeGuard(win3);
  third.guard.enable({ afterWindowClose: true });
  third.guard.disable();
  await win3.expire();
  assert.deepEqual(win3.entries, ["/prev", "/staff"]);
});

test("B: 다른 화면으로 가기 직전엔 가드 칸을 걷는다(아래 탭·메뉴·날짜 이동) — 새 화면 뒤에 칸이 남지 않는다", async () => {
  const win = fakeWindow();
  const { guard, log } = homeGuard(win);
  guard.enable();
  const released = releaseActiveLessonGuard();
  await win.settle();
  await released;
  win.navigate("/staff/students");
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff/students"]);
  // 떠난 뒤 화면이 사라지며 끄기가 불려도 아무 칸도 건드리지 않는다
  guard.disable();
  await win.settle();
  assert.equal(win.url, "/staff/students");
  assert.equal(log.asked, 0);
  // 가드가 없을 때는 아무 일도 하지 않는다
  await releaseActiveLessonGuard();
});

test("B: 가드 칸 위에서 그대로 다른 화면으로 떠났으면, 끌 때 남의 칸을 되돌리지 않는다", async () => {
  const win = fakeWindow();
  const { guard } = homeGuard(win);
  guard.enable();
  win.navigate("/staff/sessions");
  guard.disable();
  await win.settle();
  assert.equal(win.url, "/staff/sessions");
});

test("B: 다른 화면에서 뒤로 돌아와 가드 칸 위에 다시 서면 그 칸을 그대로 쓴다(칸을 또 넣지 않는다)", async () => {
  const win = fakeWindow();
  const first = homeGuard(win);
  first.guard.enable();
  win.navigate("/staff/sessions");
  first.guard.disable();
  await pressBack(win); // 홈의 가드 칸으로 돌아옴 — 화면이 새로 만들어진다
  const again = homeGuard(win);
  again.guard.enable();
  assert.deepEqual(win.entries, ["/prev", "/staff", "/staff"]);
  await pressBack(win);
  assert.equal(again.log.asked, 1);
  assert.deepEqual(win.entries, ["/prev"], "한 번의 확인으로 앞 화면까지");
});

test("C(수업 주소): 종료 뒤 가드 칸·창 칸을 걷어 바닥 칸에서 바꿔 끼운다 — 뒤로 = 들어오기 전 화면", async () => {
  const key = "staff-session-s1";
  const build = () => {
    const win = fakeWindow(["/staff/sessions", "/staff/sessions/s1"]);
    // 수업 주소의 가드: 바닥 칸에 표시 → 가드 칸
    win.history.replaceState({ __NA: true, staffSessionGuardBase: key });
    win.history.pushState({ __NA: true, staffSessionGuard: key, staffSessionHadPrevious: true });
    win.wipe(); // 수업 중 출결 저장 — 가드 칸 표시가 지워진다
    return win;
  };
  // ① 종료 확인 창이 열린 채 종료(처리가 끝나 창은 더 이상 뒤로를 막지 않는다)
  const win = build();
  let closed = 0;
  overlay.bindOverlayToHistory(win, () => { closed += 1; }, { isBlocked: () => false });
  win.wipe(); // 종료 처리(서버 기능)
  const reached = unwindToLessonGuardBase(win, key, 2);
  await win.settle();
  assert.equal(await reached, true);
  assert.equal(closed, 1, "종료 확인 창도 닫힌다");
  assert.equal(isLessonGuardBase(win.top.state, key), true);
  win.replaceUrl("/staff");
  assert.deepEqual(win.entries, ["/staff/sessions", "/staff"], "끝낸 수업 화면 칸이 남지 않는다");
  await pressBack(win);
  assert.equal(win.url, "/staff/sessions", "뒤로 = 수업에 들어오기 전 화면");

  // ② 시작 취소(열린 창 없음) — 가드 칸 하나만 걷는다
  overlay.resetOverlayHistoryForTest();
  const win2 = build();
  const reached2 = unwindToLessonGuardBase(win2, key, 1);
  await win2.settle();
  assert.equal(await reached2, true);
  assert.deepEqual(win2.entries, ["/staff/sessions", "/staff/sessions/s1"]);

  // ③ 한도보다 더 내려가지 않는다 — 바닥 표시가 없어도 앞 화면까지 넘어가지 않는다
  const win3 = fakeWindow(["/staff/sessions", "/staff/sessions/s1"]);
  win3.history.pushState({ __NA: true });
  const reached3 = unwindToLessonGuardBase(win3, key, 1);
  await win3.settle();
  assert.equal(await reached3, false);
  assert.deepEqual(win3.entries, ["/staff/sessions", "/staff/sessions/s1"]);

  // ④ 이미 바닥 칸이면 움직이지 않는다
  const win4 = fakeWindow(["/staff/sessions", "/staff/sessions/s1"]);
  win4.history.replaceState({ __NA: true, staffSessionGuardBase: key });
  assert.equal(await unwindToLessonGuardBase(win4, key, 2), true);
  await win4.settle();
  assert.deepEqual(win4.entries, ["/staff/sessions", "/staff/sessions/s1"]);
});

test("닫히는 중인 창의 칸이 맨 위면 빠질 때까지 기다린 뒤에 «두 칸 뒤로»를 한다", async () => {
  const win = fakeWindow();
  const handle = overlay.bindOverlayToHistory(win, () => {});
  let done = false;
  const waiting = waitOverlayEntriesGone(win).then(() => { done = true; });
  await tick();
  assert.equal(done, false, "창 칸이 맨 위인 동안은 기다린다");
  handle.release();
  await win.settle();
  await waiting;
  assert.equal(done, true);
  // 창 칸이 없으면 바로 끝난다
  await waitOverlayEntriesGone(win);
});

test("화면 연결 — 수업 주소 가드는 «바닥 칸에 닿았을 때만» 묻고, 종료·시작 취소는 칸을 걷은 뒤 바꿔 끼운다", async () => {
  const session = await read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  const handler = /const handlePopState = async \(\) => \{([\s\S]*?)\n    \};/.exec(session)[1];
  // 창 칸이 빠진 popstate 를 «수업 나가기»로 오해하지 않는다 — 가드 칸을 되살리기(pushState)·묻기보다 먼저 거른다
  const baseCheck = handler.indexOf("if (!isLessonGuardBase(history.state, guardKey)) return;");
  assert.ok(baseCheck > 0);
  assert.ok(baseCheck < handler.indexOf("history.pushState(sentinelState"));
  assert.ok(baseCheck < handler.indexOf("askConfirm("));
  // 나갈 때: 닫히는 창 칸을 기다린 뒤 두 칸 뒤로
  assert.ok(handler.indexOf("await waitOverlayEntriesGone(window);") < handler.indexOf("await leaveLessonScreen(window)"));
  // «앞 화면이 있는가»를 history.length 로 판단하지 않는다(L-1)
  assert.doesNotMatch(handler, /hasPreviousEntry\) history\.go/);
  const guardSource = (await read("src/app/staff/lessonBackGuard.ts")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(guardSource, /history\.length/);
  // 종료·시작 취소는 직접 이동하지 않고 «나갈 곳»만 적는다 → 나가기 effect 가 칸을 걷고 바꿔 끼운다
  assert.equal((session.match(/router\.replace\(/g) || []).length, 1, "이동은 나가기 effect 한 곳에서만");
  assert.equal((session.match(/setExitTo\(session\.sessionDateId \? "\/staff\/seasonal" : "\/staff"\);/g) || []).length, 2);
  const exit = /if \(!exitTo \|\| pending \|\| exitStartedRef\.current\) return;([\s\S]*?)\n  \}, \[exitTo, pending/.exec(session)[1];
  const order = ["releaseBackGuardRef.current?.();", "await unwindToLessonGuardBase(window, `staff-session-${session.id}`, steps);", 'markNextScopeNavigationAsReplace("/staff");', "router.replace(exitTo);", "router.refresh();"];
  let at = -1;
  for (const piece of order) {
    const next = exit.indexOf(piece);
    assert.ok(next > at, `순서: ${piece}`);
    at = next;
  }
  assert.match(exit, /const steps = showEndConfirm \? 2 : 1;/);
  // 나가는 중에는 가드 칸을 다시 넣지 않는다 · 홈에 끼운 칸은 이 가드를 쓰지 않는다
  assert.match(session, /if \(embedded\) return;\s*const guardKey = `staff-session-\$\{session\.id\}`;\s*(?:\/\/[^\n]*\s*)*if \(exitStartedRef\.current\) return;/);
  // 홈에 끼운 칸은 예전처럼 이동하지 않고 줄만 바뀐다
  assert.match(session, /if \(embedded\) \{ setShowEndConfirm\(false\); onFinished\?\.\(reportForFinish\(report\) \|\| null\); return; \}/);
  assert.match(session, /if \(embedded\) \{ onCancelled\?\.\(\); return; \}/);
});

test("화면 연결 — 홈 가드는 진행 중 수업 칸이 펼쳐졌을 때만, 문구는 수업 주소와 같고 저장은 같은 흐름", async () => {
  const home = await read("src/app/staff/StaffHomeClient.tsx");
  const session = await read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  const question = /askConfirm\("(수업이 진행 중입니다[^"]*)"\)/;
  assert.equal(question.exec(home)[1], question.exec(session)[1], "두 화면의 확인 문구가 같다");
  const effect = /const lessonGuardRef = useRef<HomeLessonGuard \| null>\(null\);([\s\S]*?)\n  \}, \[liveLessonOpen\]\);/.exec(home)[1];
  assert.match(effect, /if \(!liveLessonOpen\) return;/, "수업이 없으면 기록 칸을 넣지 않는다");
  assert.match(effect, /createHomeLessonGuard\(window, \{/);
  assert.match(effect, /save: \(\) => prepareStaffNavigation\(\),/, "아래 탭·메뉴와 같은 저장");
  assert.match(effect, /onSaveFailed: \(message\) => \{\s*setError\(/);
  assert.match(effect, /guard\.enable\(\{ afterWindowClose: /);
  assert.match(effect, /return \(\) => guard\.disable\(\);/);
  // 홈을 직접 떠나는 길은 가드 칸을 먼저 걷는다
  assert.match(home, /await lessonGuardRef\.current\?\.release\(\);\s*\/\/ replace: 날짜는/);
  assert.match(home, /await lessonGuardRef\.current\?\.release\(\);\s*router\.push\("\/staff\/sessions"\);/);
  const nav = await read("src/app/staff/StaffBottomNav.tsx");
  assert.match(nav, /await releaseActiveLessonGuard\(\);\s*router\.push\(href\);/);
  const menu = await read("src/app/staff/StaffProfileMenu.tsx");
  assert.match(menu, /confirmBack\.leaveTo\(pendingHref, \(to\) => void releaseActiveLessonGuard\(\)\.then\(\(\) => window\.location\.assign\(to\)\)\);/);
  // 브라우저 기본 확인 창은 쓰지 않는다
  for (const source of [home, session, nav, menu]) assert.doesNotMatch(source, /window\.confirm\(|[^.\w]confirm\(|window\.alert\(/);
});

test("화면 연결 — 선생님 화면의 창은 모두 «뒤로 = 창만 닫기», 저장 중인 창은 막는다", async () => {
  const pins = [
    ["src/app/staff/StaffHomeClient.tsx", [/useBackToClose\(true, closeDialog, \{ blocked: busy \}\);/, /labelledBy="notice-title" busy=\{pending\}>/, /labelledBy="start-title" busy=\{pending\}>/]],
    ["src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", [/useBackToClose\(showEndConfirm, closeEndDialog, \{ blocked: pending \}\);/]],
    ["src/components/staff/ClassBillingSheet.tsx", [/useBackToClose\(open, onClose\);/, /useBackToClose\(true, onClose, \{ blocked: pending \}\);/]],
    ["src/components/staff/ClassPeopleSheet.tsx", [/const \{ closeThen \} = useBackToClose\(open, onClose\);/, /closeThen\(\(\) => onOpenBilling\(target\)\)/]],
    ["src/components/staff/SessionStudentSheet.tsx", [/useBackToClose\(true, onClose\);/]],
    ["src/app/staff/StaffProfileMenu.tsx", [/const menuBack = useBackToClose\(isOpen, closeAndRestoreFocus\);/, /const confirmBack = useBackToClose\(pendingHref !== null, closeAndRestoreFocus, \{ blocked: leaving \}\);/]],
    ["src/app/staff/StaffHomeLink.tsx", [/const \{ leaveTo \} = useBackToClose\(open, close, \{ blocked: saving \}\);/, /leaveTo\(homeHref, \(\) => window\.location\.assign\(homeHref\)\);/]],
    ["src/app/staff/billing/StaffBillingClient.tsx", [/const lookupBack = useBackToClose\(lookupOpen, closeLookup\);/, /const requestBack = useBackToClose\(Boolean\(target\), closeDialog, \{ blocked: pending \}\);/, /lookupBack\.leaveTo\(/, /requestBack\.closeThen\(/]],
  ];
  for (const [file, patterns] of pins) {
    const source = await read(file);
    for (const pattern of patterns) assert.match(source, pattern, `${file}: ${pattern}`);
  }
  // 청구 화면의 상세 패널은 공용 패널(ListDetailPanel)이 스스로 «뒤로 = 닫기»를 한다 — 끄지 않는다
  const billing = await read("src/app/staff/billing/StaffBillingClient.tsx");
  assert.doesNotMatch(billing, /backToClose=\{false\}/);
  // 선생님 화면(다른 담당의 셔틀·기사님·운행 화면 제외)에 «뒤로 = 닫기» 없이 화면을 덮는 창이 새로 생기면 여기서 걸린다
  const { readdir } = await import("node:fs/promises");
  const skip = /[\\/]staff[\\/](shuttle|driver|run)[\\/]|[\\/]staff[\\/]layout\.tsx$/;
  const files = [];
  for (const root of ["src/app/staff", "src/components/staff"]) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(`${entry.parentPath ?? entry.path}/${entry.name}`.replace(/\\/g, "/"));
    }
  }
  for (const file of files) {
    if (skip.test(file.replace(/\//g, "\\")) || skip.test(file)) continue;
    const source = await read(file);
    const windows = (source.match(/className="fixed inset-0 /g) || []).length;
    if (windows === 0) continue;
    const hooks = (source.match(/useBackToClose\(/g) || []).length;
    assert.ok(hooks >= windows, `${file}: 화면을 덮는 창 ${windows}개 · «뒤로 = 닫기» ${hooks}개`);
  }
});

test("C(홈): 종료 뒤 새로 불러오기는 가드 칸·종료 확인 창 칸이 다 빠진 뒤에 한다(칸이 빠지며 새로 불러오기가 버려지지 않게)", async () => {
  const win = fakeWindow();
  const { guard } = homeGuard(win);
  guard.enable();
  win.wipe();
  const endDialog = overlay.bindOverlayToHistory(win, () => {}, { isBlocked: () => true });
  // 홈의 종료 처리와 같은 순서: (가드가 살아 있으면) 바닥 칸이 맨 위가 될 때까지 기다림 → 새로 불러오기.
  // 칸은 직접 걷지 않는다 — 화면이 바뀌며 종료 확인 창과 가드가 각자 자기 칸을 되돌린다
  assert.equal(guard.isLive(), true);
  let refreshedAt = null;
  const done = (async () => {
    await guardModule.waitUntilLessonGuardBase(win, HOME_LESSON_GUARD_KEY, 3);
    refreshedAt = win.entries.length;
  })();
  await win.settle();
  assert.equal(refreshedAt, null, "칸이 아직 남아 있는 동안은 새로 불러오지 않는다");
  // 줄이 «완료»로 바뀌며: 종료 확인 창이 사라지고(칸 되돌리기) 가드가 꺼진다(칸 되돌리기)
  endDialog.release();
  guard.disable();
  await win.settle();
  await done;
  assert.equal(refreshedAt, 2, "[앞][바닥]만 남은 뒤에 새로 불러온다");
  assert.deepEqual(win.entries, ["/prev", "/staff"]);
  assert.equal(guard.isLive(), false);
  // 화면 연결: 홈의 종료·시작 취소는 곧바로 새로 불러오지 않고 이 순서를 쓴다
  const home = await read("src/app/staff/StaffHomeClient.tsx");
  const after = /function refreshAfterLessonEnds\(\) \{([\s\S]*?)\n  \}/.exec(home)[1];
  assert.match(after, /if \(lessonGuardRef\.current\?\.isLive\(\)\) await waitUntilLessonGuardBase\(window, HOME_LESSON_GUARD_KEY, 3\);\s*router\.refresh\(\);/);
  // 여기서 직접 뒤로를 보내지 않는다(처리 중이라 뒤로를 막고 있는 종료 확인 창이 칸을 다시 넣어 버린다)
  assert.doesNotMatch(after.replace(/^\s*\/\/.*$/gm, ""), /release\(\)|history\.back/);
  for (const name of ["handleFinished", "handleCancelled"]) {
    const body = new RegExp(`function ${name}\\(lesson: StaffTodayClass[^)]*\\) \\{([\\s\\S]*?)\\n  \\}`).exec(home)[1];
    assert.match(body, /refreshAfterLessonEnds\(\);/, name);
    assert.doesNotMatch(body, /router\.refresh\(\)/, name);
  }
});

test("가드 열쇠 — 홈과 수업 주소가 서로의 칸을 바닥으로 오해하지 않는다", () => {
  assert.equal(isLessonGuardBase({ staffSessionGuardBase: "staff-session-abc" }, HOME_LESSON_GUARD_KEY), false);
  assert.equal(isLessonGuardBase({ staffSessionGuardBase: HOME_LESSON_GUARD_KEY }, "staff-session-abc"), false);
});
