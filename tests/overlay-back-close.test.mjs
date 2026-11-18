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
  const panel = await read("src/components/admin/list/ListDetailPanel.tsx");
  assert.match(panel, /useBackToClose\(backToClose, onClose\)/);
  assert.match(panel, /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/, "패널 안 링크는 칸을 먼저 되돌리고 이동");
  assert.match(await read("src/app/mypage/ParentNotificationBell.tsx"), /leaveTo\(SETTINGS_NOTIFICATION_HREF, \(to\) => router\.push\(to\)\)/, "«알림 설정» 링크도");
  assert.match(await read("src/components/maps/LocationPickerModal.tsx"), /useBackToClose\(true, onClose\)/);
  assert.match(await read("src/app/rental/RentalTimeSheet.tsx"), /useBackToClose\(open, onClose\)/);
  assert.match(await read("src/app/schedule/ScheduleClient.tsx"), /usePublicOverlayOpen\(filterOpen, \(\) => setFilterOpen\(false\)\)/);
  assert.match(await read("src/app/annual/EventDetailPanel.tsx"), /usePublicOverlayOpen\(Boolean\(event\), onClose\)/);
  assert.match(await read("src/components/calendar/CalendarSyncButton.tsx"), /usePublicOverlayOpen\(open, \(\) => setOpen\(false\)\)/);
  assert.match(await read("src/components/PublicHeader.tsx"), /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/);
  assert.match(await read("src/components/chat/ChatBotButton.tsx"), /onClickCapture=\{captureLinks\(\(to\) => router\.push\(to\)\)\}/);
});
