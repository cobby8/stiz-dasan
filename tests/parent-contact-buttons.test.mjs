import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 학부모 화면 «학원에 문의» 글 옆의 전화·문의 버튼(2026-11-17 원장 결정 g3) + 소식 사진 가져가기 막기·크게 보기(g2).
// 왜 테스트로 못박나: «학원에 문의해 주세요» 글만 있고 버튼이 없는 막다른 곳은 새 화면을 만들 때 다시 생긴다.
// 화면 소스를 읽어 «그 글이 뜨는 자리에 버튼 묶음이 같이 있는지»를 본다(부품의 판정 규칙은 직접 실행해 본다).

const ROOT = process.cwd();
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const BUTTONS = "src/components/parent/AcademyContactButtons.tsx";

test("연락 버튼 묶음: 전화는 걸 수 있는 번호일 때만, 카카오는 주소가 있을 때만, 번호가 없으면 문의 폼 링크", () => {
  const source = read(BUTTONS);
  // 번호 판정은 공용 규칙 한 곳(자리채움 번호·이상한 길이는 버튼을 숨긴다)
  assert.match(source, /import \{ academyTel \} from "@\/lib\/academyPhoneRules";/);
  assert.match(source, /const tel = academyTel\(contact\?\.phone\);/);
  assert.match(source, /\{tel && \(\s*<a href=\{`tel:\$\{tel\}`\}/);
  assert.match(source, /\{kakao && \(\s*<a href=\{kakao\} data-outside-link target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /\{\(alwaysAsk \|\| !tel\) && \(\s*<Link href=\{askHref\} className=\{buttonClassName\}>\s*\{askLabel\}/);
  // 기본 문의 주소·글자는 그대로(홈 문의 폼) — 자녀 0명일 때만 부르는 쪽이 바꾼다
  assert.match(source, /askHref = ACADEMY_ASK_HREF,\s*askLabel = "학원에 문의",/);
  assert.match(source, /export const ACADEMY_ASK_HREF = "\/mypage#parent-request-form";/);
  // 번호를 코드에 박지 않는다 · 아이콘 없이 글자 · 버튼은 기존 등급 클래스
  assert.doesNotMatch(source, /tel:0\d+|material-symbols|font-extrabold|font-black|#[0-9a-fA-F]{6}\b/);
  assert.match(source, /buttonClassName = "academy-button-secondary whitespace-nowrap"/);
  for (const label of ["학원에 전화하기", "카카오 문의", "학원에 문의"]) assert.ok(source.includes(label), label);
});

test("asksAcademy: «학원으로 문의/연락해 주세요»라고 말하는 글만 버튼을 부른다(서버 오류 글 그대로)", () => {
  // 부품 파일의 판정식을 그대로 꺼내 실행한다(식을 바꾸면 여기서 드러난다)
  const pattern = /return (\/[^\n]+\/)\.test\(String\(text \?\? ""\)\);/.exec(read(BUTTONS));
  assert.ok(pattern, "asksAcademy 의 판정식");
  const asks = (text) => new RegExp(pattern[1].slice(1, -1)).test(String(text ?? ""));
  // 실제 서버 문구(오류 코드·응답 모양은 바꾸지 않았다 — 화면이 글을 보고 버튼을 붙인다)
  const absenceRoute = read("src/app/api/mypage/regular-absence/route.ts");
  const seasonalRoute = read("src/app/api/mypage/seasonal-absence/route.ts");
  for (const message of [
    /MAKEUP_ALREADY_USED: "([^"]+)"/.exec(absenceRoute)?.[1],
    /MAKEUP_BOOKING_PAST: "([^"]+)"/.exec(absenceRoute)?.[1],
    /ALREADY_CHECKED: "([^"]+)"/.exec(seasonalRoute)?.[1],
    /export const CHANGE_CLOSED_MESSAGE = "([^"]+)"/.exec(read("src/lib/parent/changeDeadline.ts"))?.[1],
    /export const MAKEUP_PAST_MESSAGE = "([^"]+)"/.exec(read("src/lib/parent/changeDeadline.ts"))?.[1],
    "결제 정보가 부족해요. 학원으로 문의해 주세요.",
    "결제 금액을 확인하지 못했어요. 학원으로 문의해 주세요.",
  ]) {
    assert.ok(message, "서버 문구를 찾지 못했다");
    assert.equal(asks(message), true, message);
  }
  for (const message of ["", null, "결석 사유를 선택해 주세요.", "금액이 바뀌었어요. 다시 확인해 주세요.", "학원이 확정하면 알려 드려요"]) {
    assert.equal(asks(message), false, String(message));
  }
  // 결제 화면의 두 오류 글은 그대로다(글·버튼만 손댔다)
  const checkout = read("src/app/mypage/payments/checkout/BundleCheckoutClient.tsx");
  assert.match(checkout, /throw new Error\("결제 정보가 부족해요\. 학원으로 문의해 주세요\."\);/);
  assert.match(checkout, /throw new Error\("결제 금액을 확인하지 못했어요\. 학원으로 문의해 주세요\."\);/);
});

test("오류 글이 학원 문의를 권하는 화면은 그 글 바로 아래에 버튼 묶음을 같이 보인다", () => {
  for (const [file, variable] of [
    ["src/app/mypage/regular-absence/RegularAbsenceClient.tsx", "err"],
    ["src/app/mypage/seasonal/SeasonalMakeupClient.tsx", "err"],
    ["src/app/mypage/makeup/MakeupClient.tsx", "err"],
    ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "error"],
    ["src/app/mypage/payments/checkout/BundleCheckoutClient.tsx", "error"],
  ]) {
    // 보강·셔틀은 «그 행이 이미 같은 묶음을 보이면 생략» 조건이 사이에 붙는다(rowShowsClosedContact — 아래 테스트)
    assert.match(read(file), new RegExp(`\\{asksAcademy\\(${variable}\\) &&(?: !rowShowsClosedContact\\([^\\n]*?\\) &&)? <AcademyContactButtons contact=\\{contact\\}`), file);
  }
});

test("«학원에 문의» 글만 있던 자리: 마감 뒤·다니는 반 없음·학원 확정·결제 실패·탈퇴 화면에 버튼이 있다", () => {
  // 보강 예약·셔틀 변경 — 마감 뒤 안내 글 다음에 버튼 묶음
  const makeup = read("src/app/mypage/makeup/MakeupClient.tsx");
  assert.match(makeup, /\{c\.booking\.changeOpen === false \? \(\s*\/\/[^\n]*\n\s*<AcademyContactButtons contact=\{contact\}/);
  const shuttle = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  // 행 탭(상세 시트)으로 번지지 않게 감싼다
  assert.match(shuttle, /\{item\.changeOpen === false \? \(\s*\/\/[^\n]*\n\s*<span\s+onClick=\{\(event\) => event\.stopPropagation\(\)\}[\s\S]{0,220}<AcademyContactButtons contact=\{contact\} \/>/);
  // 다니는 반이 없을 때 — 말투는 «~어요», 글 아래 버튼
  for (const file of ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx"]) {
    const source = read(file);
    assert.match(source, /<p>지금 다니고 있는 반이 없어요\.<\/p>\s*(?:\{\/\*[^\n]*\*\/\}\s*)?<AcademyContactButtons contact=\{/, file);
    assert.doesNotMatch(source, /반이 없습니다\. 학원으로 문의해 주세요|반이 없어요\. 학원에 문의해 주세요/, file);
  }
  // 방학특강 — 학원이 확정한 결석 줄
  const seasonal = read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx");
  assert.doesNotMatch(seasonal, /학원 확정 — 변경은 문의/);
  assert.match(seasonal, /\{s\.reported \? \(\s*s\.locked \? \(\s*\/\/[^\n]*\n\s*<AcademyContactButtons contact=\{contact\}/);
  // 결제 결과 — 완료되지 않았을 때(돈이 빠져나갔을 수 있는 급한 상황)
  const done = read("src/app/mypage/payments/done/BundleDoneClient.tsx");
  assert.match(done, /\{state === "error" && <AcademyContactButtons contact=\{contact\}/);
  assert.match(done, /돈이 빠져나갔다면 학원에 문의해 주세요\./);
  // 탈퇴 — 알림 끄기는 설정으로 바로, 문의는 버튼. 법으로 정한 보관 안내 문장은 그대로
  const withdraw = read("src/app/mypage/withdraw/WithdrawClient.tsx");
  assert.match(withdraw, /<Link href="\/mypage\/settings" className="academy-button-secondary whitespace-nowrap">\s*알림 설정으로\s*<\/Link>\s*(?:\{\/\*[^\n]*\*\/\}\s*)?<AcademyContactButtons contact=\{contact\}/);
  assert.match(withdraw, /전자상거래법에 따라 거래 기록은 5년간 보관해야 합니다\. 보관\s+기간이 지나면 파기합니다\./);
  assert.doesNotMatch(withdraw, /이용 화면에서 알림 설정을 변경하실 수 있습니다/);
});

test("연락처 값은 서버 page 가 설정에서 읽어 넘긴다(새 DB 조회 없이 기존 설정 조회 재사용)", () => {
  const helper = read("src/lib/academyPhone.ts");
  // 설정 조회 함수(같은 요청 안에서 한 번만 읽힌다) + 공용 번호 규칙만 쓴다
  assert.match(helper, /export async function getAcademyContact\(\)/);
  assert.doesNotMatch(helper, /\$queryRawUnsafe|\$executeRawUnsafe|prisma/);
  for (const page of [
    "src/app/mypage/makeup/page.tsx",
    "src/app/mypage/shuttle/page.tsx",
    "src/app/mypage/enrollment-change/page.tsx",
    "src/app/mypage/seasonal/page.tsx",
    "src/app/mypage/payments/checkout/page.tsx",
    "src/app/mypage/payments/done/page.tsx",
    "src/app/mypage/withdraw/page.tsx",
  ]) {
    assert.match(read(page), /getAcademyContact\(\)/, page);
  }
});

test("g7 긴 안내 줄이기: 같은 약속을 한 줄로, 휴원 양식에서는 수강료 안내가 한 줄만", () => {
  const absence = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  // 기한 숫자는 규칙 상수에서 꺼내 쓴다(글에 7을 박지 않는다 — 규칙이 바뀌면 글도 같이 바뀐다)
  assert.match(absence, /사진은 \{EVIDENCE_WINDOW_DAYS\}일 안에 올리면 돼요\. 확인 뒤 다음 달 수강료에서 1회분을 빼 드리고, 없으면 보강권 1장으로 바뀌어요/);
  assert.match(absence, /import \{[^}]*\bEVIDENCE_WINDOW_DAYS\b[^}]*\} from "@\/lib\/regular\/illnessCarryRules";/);
  // 그 «7일»·«보강권 1장»은 실제 규칙과 같다
  const rules = read("src/lib/regular/illnessCarryRules.ts");
  assert.match(rules, /export const EVIDENCE_WINDOW_DAYS = 7;/);
  assert.match(rules, /7일 안에 사진 없음 → 보강권 1장/);

  const change = read("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx");
  // 정원 안내는 한 곳에 적고 두 양식(반 변경·반 추가)이 같이 쓴다 — 한 번에 한 종류만 열린다
  assert.equal(change.split("정원이 찬 반도 신청할 수 있어요").length - 1, 1);
  assert.equal(change.split("{FULL_CLASS_NOTE}").length - 1, 2);
  // 휴원 양식이 열려 있으면 맨 아래 «수강료가 달라지면 …» 줄을 숨긴다(양식 안의 한 줄이 같은 약속을 한다)
  assert.match(change, /const pauseFormOpen = !shownPending && !paused && activeKind === "PAUSE";/);
  assert.match(change, /\{!\(pauseFormOpen\) && \(\s*<p[^>]*>\s*수강료가 달라지면 학원에서 다시 안내드려요\s*<\/p>\s*\)\}/);
  assert.match(change, /이미 낸 수강료는 승인할 때 빠지는 수업만큼 이월·환불로 안내드려요/);
});

test("g2 소식 사진: 길게 누르기 메뉴·끌어가기를 막고, 피드에서도 누르면 크게 보기(옆으로 넘기기는 그대로)", () => {
  const gallery = read("src/components/parent/FeedPhotoGallery.tsx");
  assert.match(gallery, /export const PROTECTED_PHOTO_CLASS = "select-none \[-webkit-touch-callout:none\] \[-webkit-user-drag:none\]";/);
  assert.match(gallery, /draggable: false,\s*onContextMenu: \(event: MouseEvent\) => event\.preventDefault\(\),/);
  // 바둑판 사진·크게 본 사진 둘 다
  assert.equal(gallery.split("{...protectedPhotoProps}").length - 1, 2);
  assert.match(gallery, /export function FeedPhotoLightbox\(/);

  const feed = read("src/app/mypage/reports/feed/ReportFeedClient.tsx");
  assert.match(feed, /import \{ FeedPhotoLightbox, PROTECTED_PHOTO_CLASS, protectedPhotoProps \} from "@\/components\/parent\/FeedPhotoGallery";/);
  // 사진 = 크게 보기 버튼(가로 스크롤은 브라우저가 맡아 넘기기와 부딪히지 않는다) — 넘기기 틀(scroll-snap)은 그대로
  assert.match(feed, /<button type="button" onClick=\{\(event\) => \{ event\.currentTarget\.focus\(\{ preventScroll: true \}\); setOpenIndex\(i\); \}\} aria-label=\{`수업 사진 \$\{i \+ 1\} 크게 보기`\}/);
  assert.match(feed, /className="scrollbar-hide flex snap-x snap-mandatory overflow-x-auto"/);
  assert.match(feed, /\{\.\.\.protectedPhotoProps\}\s*className=\{`aspect-square w-full object-cover \$\{PROTECTED_PHOTO_CLASS\}`\}/);
  assert.match(feed, /<FeedPhotoLightbox photos=\{visible\}/);

  // 영상도 같은 취지
  const video = read("src/components/parent/SessionVideoPlayer.tsx");
  assert.match(video, /controlsList="nodownload"/);
  assert.match(video, /onContextMenu=\{\(event\) => event\.preventDefault\(\)\}/);
});

// ── 2026-11-17 검수 «고치면 좋은 것» 반영 ─────────────────────────────────────────────

test("검수1 자녀 0명: «학원에 문의»가 폼 없는 홈으로 가지 않고 «자녀 연결하기»로 간다(새 DB 조회 없이)", () => {
  const buttons = read(BUTTONS);
  assert.match(buttons, /export const CHILD_CONNECT_ASK = \{ askHref: "\/mypage\/children", askLabel: "자녀 연결하기" \} as const;/);

  // 자녀 수는 레이아웃이 같은 요청에서 이미 부른 getAccountViewAccess(요청 단위 캐시)가 구한 값을 쓴다
  const access = read("src/lib/account-view-access.ts");
  assert.match(access, /export const getAccountViewAccess = cache\(readAccountViewAccess\);/);
  assert.match(access, /hasOwnChildren: parent\.hasOwnChildren \}/);
  assert.equal(access.split("$queryRawUnsafe").length - 1, 2, "조회 개수는 그대로(계정 1·추가 역할 1)");
  assert.match(read("src/app/mypage/layout.tsx"), /getAccountViewAccess\(\),/);

  // 세 화면: page 가 값을 넘기고, 화면은 0명일 때만 링크를 바꾼다(모르면 — 조회 실패 — 예전 그대로)
  for (const [page, client] of [
    ["src/app/mypage/withdraw/page.tsx", "src/app/mypage/withdraw/WithdrawClient.tsx"],
    ["src/app/mypage/enrollment-change/page.tsx", "src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx"],
    ["src/app/mypage/shuttle/page.tsx", "src/app/mypage/shuttle/ShuttleExceptionClient.tsx"],
  ]) {
    const pageSource = read(page);
    assert.match(pageSource, /getAccountViewAccess\(\)/, page);
    assert.match(pageSource, /noChildren=\{access\.hasOwnChildren === false\}/, page);
    assert.doesNotMatch(pageSource, /\$queryRawUnsafe|prisma/, `${page}: 새 DB 조회 없음`);
    assert.match(read(client), /\{\.\.\.\(noChildren \? (?:CHILD_CONNECT_ASK|\{ \.\.\.CHILD_CONNECT_ASK, askHref: childConnectHref \}) : \{\}\)\}/, client);
  }
  // 수강 변경·셔틀은 «다니는 반 없음» 갈래에서만 바꾼다(그 밖의 문의 링크는 홈 폼 그대로)
  for (const file of ["src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", "src/app/mypage/shuttle/ShuttleExceptionClient.tsx"]) {
    assert.equal(read(file).split("CHILD_CONNECT_ASK").length - 1, 2, `${file}: import 1 + 다니는 반 없음 1`);
  }
  // 내 계정(/account) 탈퇴 화면도 같은 부품 — 자녀 연결은 /account/children 으로
  const accountWithdraw = read("src/app/account/withdraw/page.tsx");
  assert.match(accountWithdraw, /\{ views, hasOwnChildren \}/);
  assert.match(accountWithdraw, /noChildren=\{hasOwnChildren === false\}\s*childConnectHref="\/account\/children"/);
  // 설정 화면의 같은 판단(자녀 없음 → /mypage/children)과 같은 길
  assert.match(read("src/app/mypage/settings/page.tsx"), /<Link href="\/mypage\/children"/);
});

test("검수2 카카오 채널 주소: https:// 없이 저장돼도 바깥 주소로 열린다(공개 바닥글과 같은 규칙 한 곳)", async () => {
  const { normalizeExternalUrl } = await loadTsModule("src/lib/externalUrl.ts");
  assert.equal(normalizeExternalUrl("pf.kakao.com/_abc"), "https://pf.kakao.com/_abc");
  assert.equal(normalizeExternalUrl("  https://pf.kakao.com/_abc  "), "https://pf.kakao.com/_abc");
  assert.equal(normalizeExternalUrl("http://pf.kakao.com/_abc"), "http://pf.kakao.com/_abc");
  assert.equal(normalizeExternalUrl("카카오 채널 https://pf.kakao.com/_abc/chat 입니다"), "https://pf.kakao.com/_abc/chat");
  assert.equal(normalizeExternalUrl('<iframe src="https://map.example/x"></iframe>'), "https://map.example/x");
  assert.equal(normalizeExternalUrl("<div>"), "");
  for (const empty of ["", "   ", null, undefined]) assert.equal(normalizeExternalUrl(empty), "");

  const helper = read("src/lib/academyPhone.ts");
  assert.match(helper, /import \{ normalizeExternalUrl \} from "@\/lib\/externalUrl";/);
  assert.match(helper, /const kakao = normalizeExternalUrl\(/);
  assert.match(helper, /kakaoChannelUrl: kakao \|\| null,/);
  // 바닥글은 옮긴 함수를 쓴다(자기 복사본이 남지 않는다)
  const footer = read("src/components/PublicFooter.tsx");
  assert.match(footer, /import \{ normalizeExternalUrl \} from "@\/lib\/externalUrl";/);
  assert.doesNotMatch(footer, /function normalizeExternalUrl/);
  assert.match(footer, /\{ label: "카카오 채널", href: normalizeExternalUrl\(kakaoChannelUrl\) \}/);
});

/** 브라우저 기록 흉내 — history.back() 은 실제처럼 «나중에» 도착한다(flush 로 보낸다) */
function fakeWindow() {
  const entries = [{ __NA: true, page: "base" }];
  let index = 0;
  const listeners = new Set();
  const queued = [];
  const calls = { push: 0, back: 0 };
  const pop = () => [...listeners].forEach((listener) => listener());
  const win = {
    history: {
      get state() { return entries[index]; },
      pushState(data) { calls.push += 1; entries.splice(index + 1); entries.push(data); index += 1; },
      back() { calls.back += 1; queued.push(-1); },
    },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  return {
    win, calls,
    get index() { return index; },
    flush() { while (queued.length) { queued.shift(); if (index > 0) { index -= 1; pop(); } } },
    userBack() { index -= 1; pop(); },
    listenerCount: () => listeners.size,
  };
}

test("검수3 사진 크게 보기: «뒤로»로 닫히고, 버튼으로 닫으면 넣은 기록 한 칸을 되돌린다", async () => {
  const { bindLightboxToHistory, isLightboxHistoryState, LIGHTBOX_HISTORY_MARK } = await loadTsModule("src/lib/navigation/photoLightboxHistory.ts");

  // 1) 휴대폰 «뒤로» — 크게 보기만 닫고 화면은 그대로(되돌리기를 또 하지 않는다)
  {
    const fake = fakeWindow();
    let closed = 0;
    const release = bindLightboxToHistory(fake.win, () => { closed += 1; });
    assert.equal(fake.calls.push, 1);
    assert.equal(isLightboxHistoryState(fake.win.history.state), true);
    fake.userBack();
    assert.equal(closed, 1);
    release(); // 화면이 닫힘 상태로 바뀌며 풀린다
    fake.flush();
    assert.equal(fake.calls.back, 0, "«뒤로»로 이미 빠진 칸을 또 되돌리지 않는다");
    assert.equal(fake.index, 0);
    assert.equal(fake.listenerCount(), 0);
  }
  // 2) 닫기 버튼·Esc·바탕 — 한 칸 되돌려 기록이 쌓이지 않는다(열고 닫기를 반복해도 «뒤로» 한 번이면 앞 화면)
  {
    const fake = fakeWindow();
    for (let round = 0; round < 3; round += 1) {
      let closed = 0;
      const release = bindLightboxToHistory(fake.win, () => { closed += 1; });
      release();
      fake.flush();
      assert.equal(closed, 0, "버튼으로 닫을 때 되돌림 popstate 가 닫기를 또 부르지 않는다");
      assert.equal(fake.index, 0);
    }
    assert.equal(fake.calls.back, 3);
  }
  // 3) 그사이 다른 화면으로 갔으면(맨 위가 우리 칸이 아님) 남의 기록을 되돌리지 않는다
  {
    const fake = fakeWindow();
    const release = bindLightboxToHistory(fake.win, () => {});
    fake.win.history.pushState({ __NA: true, page: "other" }, "");
    release();
    assert.equal(fake.calls.back, 0);
  }
  // 4) 개발 모드(Strict Mode) 묶기→풀기→다시 묶기 — 늦게 온 되돌림이 방금 연 크게 보기를 닫지 않는다
  {
    const fake = fakeWindow();
    let closed = 0;
    bindLightboxToHistory(fake.win, () => { closed += 1; })();
    const release = bindLightboxToHistory(fake.win, () => { closed += 1; });
    fake.flush();
    assert.equal(closed, 0);
    release();
    fake.flush();
    assert.equal(fake.index, 0, "닫으면 원래 칸으로 돌아온다");
  }
  // 5) 기록을 못 넣는 환경이면 조용히 옛 동작(버튼으로만 닫기)
  {
    const win = { history: { state: null, pushState() { throw new Error("blocked"); }, back() { throw new Error("no"); } }, addEventListener() {}, removeEventListener() {} };
    const release = bindLightboxToHistory(win, () => {});
    assert.doesNotThrow(release);
  }
  assert.equal(LIGHTBOX_HISTORY_MARK, "stizPhotoLightbox");

  // 학부모 «뒤로» 이동 기록(inAppHistory)과 부딪히지 않는다:
  // 주소 인자 없이 넣으므로 경로·쿼리가 그대로 → 기록 규칙 1)«같은 주소면 그대로»
  const source = read("src/lib/navigation/photoLightboxHistory.ts");
  assert.match(source, /win\.history\.pushState\(\{ \[LIGHTBOX_HISTORY_MARK\]: true \}, ""\);/);
  assert.doesNotMatch(source, /sessionStorage|IN_APP_HISTORY_KEY|recordInAppNavigation|^import /m);
  const { nextInAppHistory } = await loadTsModule("src/lib/navigation/inAppHistory.ts");
  const stack = ["/mypage", "/mypage/reports/feed"];
  assert.deepEqual(nextInAppHistory(stack, "/mypage/reports/feed"), stack);

  // 부품: 열릴 때 한 번 묶고(사진 넘기기로 다시 묶지 않게 [open]), 닫히면 풀고 누른 사진 버튼으로 포커스
  const gallery = read("src/components/parent/FeedPhotoGallery.tsx");
  assert.match(gallery, /import \{ bindLightboxToHistory \} from "@\/lib\/navigation\/photoLightboxHistory";/);
  assert.match(gallery, /const release = bindLightboxToHistory\(window, \(\) => onCloseRef\.current\(\)\);/);
  assert.match(gallery, /release\(\);[^\n]*\n\s*if \(opener && opener\.isConnected\) opener\.focus\(\{ preventScroll: true \}\);\s*\};\s*\}, \[open\]\);/);
  // 소식 상세 바둑판도 누를 때 버튼에 포커스를 옮겨 둔다(아이폰은 눌러도 포커스가 안 간다)
  assert.match(gallery, /onClick=\{\(event\) => \{ event\.currentTarget\.focus\(\); setOpenIndex\(index\); \}\}/);
});

test("검수4 같은 연락 버튼 두 번: 오류를 낸 행이 이미 «마감» 묶음을 보이면 위쪽 묶음은 생략", async () => {
  const { rowShowsClosedContact, isChangeClosedMessage, CHANGE_CLOSED_MESSAGE, MAKEUP_PAST_MESSAGE } = await loadTsModule("src/lib/parent/changeDeadline.ts");
  assert.equal(isChangeClosedMessage(CHANGE_CLOSED_MESSAGE), true);
  assert.equal(isChangeClosedMessage(MAKEUP_PAST_MESSAGE), true);
  assert.equal(isChangeClosedMessage("결제 정보가 부족해요. 학원으로 문의해 주세요."), false);
  // 생략 = 마감 글 + 그 행이 지금 마감으로 그려짐
  assert.equal(rowShowsClosedContact(CHANGE_CLOSED_MESSAGE, false), true);
  assert.equal(rowShowsClosedContact(MAKEUP_PAST_MESSAGE, false), true);
  // 남김 = 행이 아직 열린 모습(새로 받기 전) · 행을 모름(새 신청 칸) · 다른 오류
  assert.equal(rowShowsClosedContact(CHANGE_CLOSED_MESSAGE, true), false);
  assert.equal(rowShowsClosedContact(CHANGE_CLOSED_MESSAGE, undefined), false);
  assert.equal(rowShowsClosedContact(CHANGE_CLOSED_MESSAGE, null), false);
  assert.equal(rowShowsClosedContact("처리하지 못했어요. 잠시 후 다시 시도해 주세요.", false), false);

  const makeup = read("src/app/mypage/makeup/MakeupClient.tsx");
  // 보강: 날짜 바꾸기·예약 취소 실패만 행을 기억하고, 마감 글이면 화면을 새로 받아 그 행을 «마감»으로 다시 그린다
  assert.match(makeup, /const failOnRow = useCallback\(\(creditId: string, message: string\) => \{\s*setErr\(message\);\s*setErrRow\(creditId\);\s*if \(isChangeClosedMessage\(message\)\) router\.refresh\(\);/);
  assert.equal(makeup.split("failOnRow(creditId, customerMessage(").length - 1, 2);
  assert.match(makeup, /!rowShowsClosedContact\(err, visibleCredits\.find\(\(c\) => c\.id === errRow && c\.status === "RESERVED"\)\?\.booking\?\.changeOpen\)/);
  // 새 동작마다 이전 행 기억을 지운다(다른 오류에 엉뚱한 행이 붙지 않게)
  assert.ok(makeup.split('setErr(""); setErrRow("");').length - 1 >= 4);

  const shuttle = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(shuttle, /setErrorRow\(typeof body\.id === "string" \? body\.id : ""\);\s*if \(isChangeClosedMessage\(message\)\) router\.refresh\(\);/);
  assert.match(shuttle, /setError\(""\);\s*setErrorRow\(""\);/);
  assert.match(shuttle, /!rowShowsClosedContact\(error, initial\.upcoming\.find\(\(item\) => item\.id === errorRow\)\?\.changeOpen\)/);
  // 행 안 묶음은 그대로(마감 행에만)
  assert.match(shuttle, /\{item\.changeOpen === false \? \(/);
  assert.match(makeup, /\{c\.booking\.changeOpen === false \? \(/);
});

test("검수6 다른 테스트의 빈 부품(stub) 판정식이 원본 asksAcademy 와 같다", () => {
  const original = /return (\/[^\n]+\/)\.test\(String\(text \?\? ""\)\);/.exec(read(BUTTONS))?.[1];
  assert.ok(original, "원본 판정식");
  for (const file of [
    "tests/enrollment-change-submit-feedback.test.mjs",
    "tests/enrollment-class-add.test.mjs",
    "tests/list-stage8b.test.mjs",
    "tests/pause-return-date.test.mjs",
    "tests/payment-bundle-ui.test.mjs",
  ]) {
    const stub = /asksAcademy: \(text\) => (\/[^\n]+?\/)\.test\(String\(text \?\? ""\)\)/.exec(read(file))?.[1];
    assert.ok(stub, `${file}: stub 판정식`);
    assert.equal(stub, original, `${file}: 원본과 다르다 — 원본을 바꿨으면 stub 도 같이`);
  }
});

test("재검수: 사진 크게 보기는 학부모 하단 메뉴·알림 시트보다 위에 그려진다", () => {
  // 하단 메뉴(z-50)와 같은 값이면 나중에 그려지는 하단 메뉴가 «이전·다음» 버튼을 덮는다(2026-11-17 재검수)
  const gallery = fs.readFileSync("src/components/parent/FeedPhotoGallery.tsx", "utf8");
  const nav = fs.readFileSync("src/app/mypage/MyPageBottomNav.tsx", "utf8");
  const lightbox = gallery.match(/role="dialog"[^>]*?className="fixed inset-0 z-\[(\d+)\]/s);
  assert.ok(lightbox, "크게 보기 판의 겹침 값을 찾지 못함");
  assert.match(nav, /fixed bottom-0[^"]*z-50/);
  assert.ok(Number(lightbox[1]) > 70, `크게 보기 겹침 값 ${lightbox[1]} 이 알림 시트(70)보다 낮다`);
});
