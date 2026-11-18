// 열린 창(시트·메뉴·지도 창)을 휴대폰 «뒤로»로 닫기 — 2026-11-17 원장 지시 «뒤로 가기 전수 조치».
// 예전엔 창이 열린 채 뒤로를 누르면 화면째 앞 화면으로 나가 입력하던 값이 사라졌다.
// 규칙(overlayHistory.ts)을 가짜 브라우저 기록으로 실제 실행해 확인한다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const overlay = await loadTsModule("src/lib/navigation/overlayHistory.ts");
test.beforeEach(() => overlay.resetOverlayHistoryForTest());
const read = (p) => readFile(p, "utf8");

/** 브라우저 기록 흉내 — back() 은 비동기(타이머 큐)로 popstate 를 낸다 */
function fakeWindow(url = "/mypage/news") {
  const entries = [{ url, state: { __NA: true } }];
  let index = 0;
  const listeners = new Set();
  const queue = [];
  const win = {
    history: {
      get state() { return entries[index].state; },
      pushState(state) { entries.splice(index + 1); entries.push({ url: entries[index].url, state }); index += 1; },
      /** Next 의 router.refresh()·서버 액션 뒤 — 지금 칸을 표시 없이 덮어쓴다 */
      replaceState(state) { entries[index] = { url: entries[index].url, state }; },
      back() { queue.push(() => { if (index === 0) return; index -= 1; listeners.forEach((l) => l()); }); },
    },
    location: { get href() { return `https://x.example${entries[index].url}`; } },
    addEventListener(_t, l) { listeners.add(l); },
    removeEventListener(_t, l) { listeners.delete(l); },
    setTimeout(fn, ms) { queue.push(ms >= 400 ? () => queue.push(fn) : fn); },
    /** 링크 이동 흉내 */
    go(url) { entries.splice(index + 1); entries.push({ url, state: { __NA: true } }); index += 1; },
    flush() { for (let i = 0; i < 20 && queue.length; i += 1) queue.shift()(); while (queue.length) queue.shift()(); },
    get entries() { return entries.slice(0, index + 1).map((e) => e.url); },
    get top() { return entries[index]; },
  };
  return win;
}

test("열면 같은 주소 칸 하나 — 휴대폰 «뒤로»는 창만 닫고 화면은 그대로", () => {
  const win = fakeWindow();
  let closed = 0;
  overlay.bindOverlayToHistory(win, () => { closed += 1; });
  assert.deepEqual(win.entries, ["/mypage/news", "/mypage/news"]);
  assert.equal(overlay.isOverlayHistoryState(win.top.state), true);
  assert.equal(win.top.state.__NA, true, "Next.js 내부 표시는 그대로 이어 받는다");
  win.history.back();
  win.flush();
  assert.equal(closed, 1);
  assert.deepEqual(win.entries, ["/mypage/news"], "화면은 그대로");
});

test("닫기 버튼·바탕으로 닫으면 넣은 칸을 한 번 되돌린다(기록이 남지 않는다)", () => {
  const win = fakeWindow();
  let closed = 0;
  const handle = overlay.bindOverlayToHistory(win, () => { closed += 1; });
  handle.release();
  handle.release(); // 두 번 불러도 한 번만
  win.flush();
  assert.deepEqual(win.entries, ["/mypage/news"]);
  assert.equal(closed, 0, "버튼으로 닫은 것은 onBack 을 다시 부르지 않는다");
});

test("창 안 링크로 떠나면 칸을 먼저 되돌린 뒤 이동한다 — 새 화면을 되돌려 버리지 않는다", () => {
  const win = fakeWindow();
  const handle = overlay.bindOverlayToHistory(win, () => {});
  handle.leaveTo("/mypage/requests/1", (to) => win.go(to));
  handle.release(); // 창이 닫히며 정리 — 떠나는 중이라 아무 일 없음
  win.flush();
  assert.deepEqual(win.entries, ["/mypage/news", "/mypage/requests/1"]);
});

test("그사이 다른 화면으로 갔으면(맨 위가 우리 칸이 아님) 되돌리지 않는다 — 남의 기록을 지우지 않는다", () => {
  const win = fakeWindow();
  const handle = overlay.bindOverlayToHistory(win, () => {});
  win.go("/mypage/classes"); // 아래 탭을 눌러 이동
  handle.release();
  win.flush();
  assert.deepEqual(win.entries.at(-1), "/mypage/classes");
});

test("창이 열린 동안 Next 가 칸을 표시 없이 덮어써도(저장 뒤 refresh) 닫기 버튼으로 닫으면 칸을 되돌린다", () => {
  const win = fakeWindow();
  const handle = overlay.bindOverlayToHistory(win, () => {});
  win.history.replaceState({ __NA: true }); // router.refresh()
  handle.release();
  win.flush();
  assert.deepEqual(win.entries, ["/mypage/news"], "뒤로가 한 번 헛돌지 않는다");
});

test("창 두 개가 겹치면 «뒤로»는 위 창부터 하나씩 닫는다", () => {
  const win = fakeWindow();
  const closed = [];
  overlay.bindOverlayToHistory(win, () => closed.push("아래"));
  overlay.bindOverlayToHistory(win, () => closed.push("위"));
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위"]);
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위", "아래"]);
  assert.deepEqual(win.entries, ["/mypage/news"]);
});

test("학부모 시트·공개 창·지도 창이 «뒤로 = 닫기»를 쓴다", async () => {
  assert.match(await read("src/app/mypage/ParentNotificationBell.tsx"), /useBackToClose\(open, \(\) => setOpen\(false\)\)/);
  assert.match(await read("src/app/mypage/ParentNotificationBell.tsx"), /leaveTo\(href, \(to\) => router\.push\(to\)\)/);
  for (const f of ["src/app/mypage/record/ChildRecordClient.tsx", "src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "src/app/mypage/classes/RequestTimeline.tsx", "src/app/mypage/record/ChildInfoEditSheet.tsx"]) {
    assert.match(await read(f), /<ListDetailPanel backToClose /, f);
  }
  // 2026-11-18: 상세 패널·모달의 «뒤로 = 닫기»는 AdminModal 한 곳에서 건다(기본 켜짐) — 패널은 넘겨주기만 한다
  const panel = await read("src/components/admin/list/ListDetailPanel.tsx");
  assert.match(panel, /backToClose = true,/, "상세 패널은 기본으로 «뒤로 = 닫기»");
  assert.match(panel, /backToClose=\{backToClose\}\s+busy=\{busy\}/);
  assert.doesNotMatch(panel, /useBackToClose\(/, "패널이 기록 칸을 따로 또 넣지 않는다(AdminModal 과 두 번 넣기 금지)");
  const modal = await read("src/components/admin/AdminModal.tsx");
  assert.match(modal, /backToClose = true,/, "모달도 기본으로 «뒤로 = 닫기»");
  assert.match(modal, /useBackToClose\(backToClose, onClose, \{ blocked: busy \}\)/);
  assert.match(modal, /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/, "창 안 링크는 칸을 먼저 되돌리고 이동");
  assert.match(await read("src/app/mypage/ParentNotificationBell.tsx"), /leaveTo\(SETTINGS_NOTIFICATION_HREF, \(to\) => router\.push\(to\)\)/, "«알림 설정» 링크도");
  assert.match(await read("src/components/maps/LocationPickerModal.tsx"), /useBackToClose\(true, onClose\)/);
  assert.match(await read("src/app/rental/RentalTimeSheet.tsx"), /useBackToClose\(open, onClose\)/);
  assert.match(await read("src/app/schedule/ScheduleClient.tsx"), /usePublicOverlayOpen\(filterOpen, \(\) => setFilterOpen\(false\)\)/);
  assert.match(await read("src/app/annual/EventDetailPanel.tsx"), /usePublicOverlayOpen\(Boolean\(event\), onClose\)/);
  assert.match(await read("src/components/calendar/CalendarSyncButton.tsx"), /usePublicOverlayOpen\(open, \(\) => setOpen\(false\), \{ blocked: busy \}\)/);
  assert.match(await read("src/components/PublicHeader.tsx"), /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/);
  assert.match(await read("src/components/chat/ChatBotButton.tsx"), /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/);
});

// ── 2026-11-18 원장 결정 ② «저장 중인 창에서는 뒤로를 눌러도 닫히지 않는다» ──

test("저장 중(blocked)에 «뒤로» → 닫히지 않고 칸이 다시 생긴다 → 저장이 끝난 뒤 «뒤로» → 닫힌다 → release 가 back 을 또 부르지 않는다", () => {
  const win = fakeWindow("/admin/students");
  let closed = 0;
  let saving = true;
  const handle = overlay.bindOverlayToHistory(win, () => { closed += 1; }, { isBlocked: () => saving });
  win.history.back();
  win.flush();
  assert.equal(closed, 0, "저장 중엔 닫히지 않는다");
  assert.deepEqual(win.entries, ["/admin/students", "/admin/students"], "빠진 칸을 다시 넣는다");
  assert.equal(overlay.overlayDepthOf(win.top.state), 1, "같은 표시·같은 깊이");
  assert.equal(win.top.state.__NA, true, "Next.js 내부 표시는 그대로");
  // 한 번 더 눌러도 같다
  win.history.back();
  win.flush();
  assert.equal(closed, 0);
  assert.deepEqual(win.entries, ["/admin/students", "/admin/students"]);
  // 저장 끝 — 평소처럼 닫힌다
  saving = false;
  win.history.back();
  win.flush();
  assert.equal(closed, 1);
  assert.deepEqual(win.entries, ["/admin/students"]);
  // 창이 닫히며 release 가 불려도 back 을 또 부르지 않는다(화면을 떠나지 않는다)
  win.go("/admin/students"); // 더 되돌렸는지 알아보려고 칸 하나를 더 둔다
  handle.release();
  win.flush();
  assert.equal(win.entries.length, 2, "release 가 기록을 더 되돌리지 않는다");
  assert.equal(closed, 1);
});

test("저장 중에 «뒤로»를 막은 뒤 저장이 끝나 버튼으로 닫히면(release) 다시 넣은 칸을 한 번 되돌린다", () => {
  const win = fakeWindow("/admin/finance");
  let closed = 0;
  let saving = true;
  const handle = overlay.bindOverlayToHistory(win, () => { closed += 1; }, { isBlocked: () => saving });
  win.history.back();
  win.flush();
  saving = false;
  handle.release(); // 저장 성공 → 화면이 창을 닫는다
  win.flush();
  assert.deepEqual(win.entries, ["/admin/finance"], "칸이 남지 않는다");
  assert.equal(closed, 0);
});

test("겹친 창에서 아래 창이 저장 중 — «뒤로» 한 번은 위 창만 닫고, 그다음 «뒤로»는 아래 창을 닫지 못한다", () => {
  const win = fakeWindow("/admin/finance");
  const closed = [];
  let saving = true;
  overlay.bindOverlayToHistory(win, () => closed.push("아래"), { isBlocked: () => saving });
  overlay.bindOverlayToHistory(win, () => closed.push("위"));
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위"], "위 창은 평소처럼 닫힌다");
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위"], "아래 창은 저장 중이라 그대로");
  assert.deepEqual(win.entries, ["/admin/finance", "/admin/finance"]);
  assert.equal(overlay.overlayDepthOf(win.top.state), 1);
  saving = false;
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위", "아래"]);
  assert.deepEqual(win.entries, ["/admin/finance"]);
});

test("겹친 창에서 위 창이 저장 중 — «뒤로»를 눌러도 두 창 다 그대로, 저장이 끝나면 위부터 하나씩", () => {
  const win = fakeWindow("/admin/finance");
  const closed = [];
  let saving = true;
  overlay.bindOverlayToHistory(win, () => closed.push("아래"));
  overlay.bindOverlayToHistory(win, () => closed.push("위"), { isBlocked: () => saving });
  win.history.back();
  win.flush();
  assert.deepEqual(closed, []);
  assert.equal(overlay.overlayDepthOf(win.top.state), 2, "위 창의 칸(깊이 2)이 다시 생긴다");
  assert.equal(win.entries.length, 3);
  saving = false;
  win.history.back();
  win.flush();
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["위", "아래"]);
  assert.deepEqual(win.entries, ["/admin/finance"]);
});

test("저장 중이어도 창 안 링크로 떠나기(leaveTo)는 막지 않는다", () => {
  const win = fakeWindow("/admin/finance");
  const handle = overlay.bindOverlayToHistory(win, () => {}, { isBlocked: () => true });
  handle.leaveTo("/admin/students/1", (to) => win.go(to));
  win.flush();
  assert.deepEqual(win.entries, ["/admin/finance", "/admin/students/1"]);
});

// ── 2026-11-18 검수 N-1: Next 가 router.refresh()·재검증 서버 액션 뒤 «지금 칸»의 표시를 지워도 아래 창이 같이 닫히지 않는다 ──

test("N-1 ① 표시가 지워진 창 A 위에 확인창 C → C 를 버튼으로 닫아도 A 는 그대로, 칸도 남지 않는다", () => {
  const win = fakeWindow("/admin/enrollment-changes");
  const closed = [];
  const a = overlay.bindOverlayToHistory(win, () => closed.push("A"));
  win.history.replaceState({ __NA: true }); // router.refresh() — A 의 칸에서 표시가 사라진다
  const c = overlay.bindOverlayToHistory(win, () => closed.push("C"));
  c.release(); // 확인창 «그만»
  win.flush();
  assert.deepEqual(closed, [], "A 는 닫히지 않는다");
  assert.equal(win.entries.length, 2, "A 의 칸 하나만 남는다");
  assert.equal(overlay.overlayDepthOf(win.top.state), 1, "A 의 칸에 표시가 다시 찍혀 있다");
  assert.equal(win.top.state.__NA, true, "Next.js 내부 표시는 그대로");
  // 그 뒤 기기 뒤로 = A 만 닫힌다
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["A"]);
  assert.deepEqual(win.entries, ["/admin/enrollment-changes"]);
  a.release();
  win.flush();
  assert.deepEqual(win.entries, ["/admin/enrollment-changes"], "release 가 더 되돌리지 않는다");
});

test("N-1 ② 같은 상황에서 기기 «뒤로» 한 번은 위 확인창만 닫는다", () => {
  const win = fakeWindow("/admin/enrollment-changes");
  const closed = [];
  overlay.bindOverlayToHistory(win, () => closed.push("A"));
  win.history.replaceState({ __NA: true });
  overlay.bindOverlayToHistory(win, () => closed.push("C"));
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["C"], "A 까지 닫히지 않는다");
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["C", "A"]);
  assert.deepEqual(win.entries, ["/admin/enrollment-changes"]);
});

test("N-1 ③ 표시가 지워진 A 를 닫는 같은 순간 B 를 열어도 B 가 열리자마자 닫히지 않는다", () => {
  const win = fakeWindow("/admin/enrollment-changes");
  const closed = [];
  const a = overlay.bindOverlayToHistory(win, () => closed.push("A"));
  win.history.replaceState({ __NA: true });
  a.release(); // 되돌리기는 아직 처리 전(비동기)
  const b = overlay.bindOverlayToHistory(win, () => closed.push("B"));
  win.flush();
  assert.deepEqual(closed, [], "B 는 열린 채");
  // B 는 기기 뒤로로 닫힌다
  win.history.back();
  win.flush();
  assert.deepEqual(closed, ["B"]);
  assert.deepEqual(win.entries, ["/admin/enrollment-changes"]);
  b.release();
  win.flush();
  assert.deepEqual(win.entries, ["/admin/enrollment-changes"]);
});

test("N-1 표시 다시 찍기는 다른 화면의 칸에는 하지 않는다 · 창이 하나도 없을 땐 아무 칸에도 찍지 않는다", () => {
  const win = fakeWindow("/admin/students");
  overlay.bindOverlayToHistory(win, () => {});
  win.go("/admin/finance"); // 창이 열린 채 다른 화면으로 감(남의 칸)
  overlay.bindOverlayToHistory(win, () => {});
  win.history.back(); // 위 창 닫힘 → /admin/finance 칸
  win.flush();
  assert.equal(overlay.overlayDepthOf(win.top.state), 0, "다른 화면의 칸에는 표시를 찍지 않는다");
  overlay.resetOverlayHistoryForTest();
  const fresh = fakeWindow("/admin");
  const only = overlay.bindOverlayToHistory(fresh, () => {});
  fresh.history.back();
  fresh.flush();
  assert.equal(overlay.overlayDepthOf(fresh.top.state), 0, "바탕 화면 칸은 표시 없이 그대로");
  only.release();
});

// ── 2026-11-18 검수 N-3: 닫기 전에 확인을 묻는 창 — 막힌 «뒤로»를 알려 확인을 띄우고, 거절해도 칸이 남는다 ──

test("N-3 막힌 «뒤로»는 onBlockedBack 으로 알린다 — 칸을 다시 넣은 «뒤»에, 닫지는 않고", () => {
  const win = fakeWindow("/admin/attendance");
  let closed = 0;
  let dirty = true;
  const seen = [];
  const handle = overlay.bindOverlayToHistory(win, () => { closed += 1; }, {
    isBlocked: () => dirty,
    onBlockedBack: () => seen.push(win.entries.length), // 불린 순간 이미 칸이 다시 들어가 있어야 한다
  });
  win.history.back();
  win.flush();
  assert.deepEqual(seen, [2], "칸을 다시 넣은 뒤 알린다");
  assert.equal(closed, 0);
  // 확인창 «그만» = 아무 일도 안 함 → 다음 «뒤로»도 화면을 떠나지 않고 또 묻는다
  win.history.back();
  win.flush();
  assert.deepEqual(seen, [2, 2]);
  assert.deepEqual(win.entries, ["/admin/attendance", "/admin/attendance"], "화면을 떠나지 않는다");
  // 확인창 «확인» = 화면이 창을 닫는다(release) → 칸 한 번 되돌림
  dirty = false;
  handle.release();
  win.flush();
  assert.deepEqual(win.entries, ["/admin/attendance"]);
  assert.equal(closed, 0);
});

test("N-3 막히지 않았을 땐 onBlockedBack 을 부르지 않고 평소처럼 닫는다 · 콜백이 던져도 기록은 멀쩡하다", () => {
  const win = fakeWindow("/admin/attendance");
  let closed = 0;
  let asked = 0;
  overlay.bindOverlayToHistory(win, () => { closed += 1; }, { isBlocked: () => false, onBlockedBack: () => { asked += 1; } });
  win.history.back();
  win.flush();
  assert.equal(asked, 0);
  assert.equal(closed, 1);
  overlay.resetOverlayHistoryForTest();
  const other = fakeWindow("/admin/attendance");
  overlay.bindOverlayToHistory(other, () => {}, { isBlocked: () => true, onBlockedBack: () => { throw new Error("화면 오류"); } });
  other.history.back();
  other.flush();
  assert.deepEqual(other.entries, ["/admin/attendance", "/admin/attendance"]);
});

test("N-3·N-5 화면 연결: 출결 패널의 닫기 전 확인 · 관리자 서랍 전체 링크", async () => {
  const hook = await read("src/components/common/useBackToClose.ts");
  assert.match(hook, /onBlockedBack: \(\) => blockedBackRef\.current\?\.\(\)/);
  const attendance = await read("src/app/admin/attendance/AttendanceClient.tsx");
  assert.match(attendance, /useBackToClose\(Boolean\(selectedLesson\), \(\) => void closeLesson\(\), \{ blocked: dirty \|\| saving, onBlockedBack: \(\) => \{ if \(!saving\) void closeLesson\(\); \} \}\)/);
  assert.match(attendance, /<ListDetailPanel\s+backToClose=\{false\}\s+onClose=\{closeLesson\}/, "기록 칸을 직접 드는 패널은 패널 것을 끈다");
  const shell = await read("src/app/admin/AdminShellClient.tsx");
  assert.match(shell, /<aside\s+onClickCapture=\{onDrawerClickCapture\}/, "서랍 전체에 건다(화면 전환·내 계정 포함)");
  assert.match(shell, /nav\[aria-label="이용 화면 전환"\]/);
  assert.match(shell, /rememberLastView\(view\.key\)/, "가로챈 «화면 전환»도 고른 화면을 기억한다");
  assert.match(await read("src/components/AccountViewSwitcher.tsx"), /<nav aria-label="이용 화면 전환"/, "서랍이 찾는 이름표가 그대로 있다");
});

test("훅: blocked 옵션·closeThen — 시그니처와 연결", async () => {
  const hook = await read("src/components/common/useBackToClose.ts");
  assert.match(hook, /export function useBackToClose\(open: boolean, close: \(\) => void, options\?: \{ blocked\?: boolean; onBlockedBack\?: \(\) => void \}\)/);
  assert.match(hook, /\{ isBlocked: \(\) => blockedRef\.current, /, "눌린 순간의 저장 중 값을 본다");
  assert.match(hook, /return \{ leaveTo, captureLinks, closeThen \};/);
  const lib = await read("src/lib/navigation/overlayHistory.ts");
  assert.doesNotMatch(lib, /^import /m, "overlayHistory 는 다른 모듈을 import 하지 않는다");
});

test("관리자·공용 창이 «뒤로 = 닫기»를 쓴다(2026-11-18)", async () => {
  // 확인 창: 처리 중엔 안 닫힘 · 함수형 확인창은 칸을 되돌린 뒤 결과를 돌려준다
  assert.match(await read("src/components/admin/AdminConfirmDialog.tsx"), /busy=\{pending\}/);
  const feedback = await read("src/components/ui/feedback.tsx");
  assert.match(feedback, /closeThen\(\(\) => item\.resolve\(ok\)\)/);
  assert.match(feedback, /<AdminModal titleId=\{titleId\} backToClose=\{false\} onClose=\{\(\) => settle\(false\)\}/, "확인창은 기록 칸을 직접 든다 — 두 번 넣지 않는다");
  // 기록 칸을 스스로 관리하는 청구 시트는 패널 것을 끈다
  assert.match(await read("src/components/parent/billing/BillDetailSheet.tsx"), /<ListDetailPanel backToClose=\{false\} /);
  // 패널을 닫으며 시작하는 작업·⚡ 메뉴·알림 종·휴대폰 메뉴
  assert.match(await read("src/components/admin/AdminPanelActions.tsx"), /onBeforeSelect\(\);\s+closeThen\(\(\) => void action\.onSelect\(\)\);/);
  const quick = await read("src/components/admin/AdminQuickActionMenu.tsx");
  assert.match(quick, /useBackToClose\(open && backClose, \(\) => setOpen\(false\)\)/);
  assert.match(quick, /setOpen\(false\);\s+closeThen\(\(\) => void action\.onSelect\(\)\);/);
  const bell = await read("src/app/admin/AdminNotificationBell.tsx");
  assert.match(bell, /useBackToClose\(open && backClose, \(\) => setOpen\(false\)\)/);
  assert.match(bell, /leaveTo\(href, \(to\) => router\.push\(to\)\)/);
  const shell = await read("src/app/admin/AdminShellClient.tsx");
  assert.match(shell, /useBackToClose\(mobileMenuOpen, \(\) => setMobileMenuOpen\(false\)\)/);
  // 자체 구현 창
  assert.match(await read("src/app/admin/shuttle/VehicleManagerClient.tsx"), /useBackToClose\(Boolean\(modal\), \(\) => setModal\(null\), \{ blocked: pending \}\)/);
  assert.match(await read("src/components/shuttle/assign/NewStudentDispatchPanel.tsx"), /useBackToClose\(Boolean\(target\), \(\) => setTarget\(null\)\)/);
  assert.match(await read("src/components/seasonal/StudentDetailModal.tsx"), /useBackToClose\(true, onClose, \{ blocked: savingPin \}\)/);
  assert.match(await read("src/components/admin/DriverLocationPanel.tsx"), /useBackToClose\(true, onClose\)/);
  assert.match(await read("src/components/admin/DriverRequestPanel.tsx"), /useBackToClose\(true, onClose, \{ blocked: /);
  assert.match(await read("src/app/admin/seasonal/attendance/SeasonalAttendanceClient.tsx"), /useBackToClose\(true, onClose\)/);
  assert.match(await read("src/components/shuttle/UnifiedDriverClient.tsx"), /useBackToClose\(confirmEnd && runState === "running", \(\) => setConfirmEnd\(false\)\)/);
  assert.match(await read("src/components/auth/ParentConsentChecks.tsx"), /useBackToClose\(true, onClose\)/);
  const register = await read("src/app/admin/students/StudentRegisterModal.tsx");
  assert.match(register, /useBackToClose\(true, onClose, \{ blocked: saving \}\)/);
  assert.match(register, /leaveTo\(`\/admin\/students\/\$\{d\.id\}`, \(to\) => router\.push\(to\)\)/, "창 안에서 다른 화면으로 갈 땐 칸을 먼저 되돌린다");
  // 저장 중 상태가 분명한 창은 busy 로 잇는다
  for (const [f, pin] of [
    ["src/app/admin/finance/PosChargeRequestModal.tsx", /busy=\{busy\}/],
    ["src/app/admin/finance/PosChargeCancelModal.tsx", /busy=\{busy\}/],
    ["src/app/admin/students/[id]/StudentBillingModals.tsx", /busy=\{busy\}/],
    ["src/app/admin/students/[id]/EnrollmentMoveModal.tsx", /busy=\{saving\}/],
    ["src/app/admin/shuttle/regular-dispatch/RunEditDialogs.tsx", /busy=\{busy\}/],
  ]) assert.match(await read(f), pin, f);
});
