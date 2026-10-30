// 게슈탈트 디자인 점검 — 학부모 화면(마이페이지·내 계정·요청·카카오 연결).
// 지키는 약속:
//  ① 취소·거절·퇴원·탈퇴는 «그 자리 확인»(InlineConfirm) 뒤에 기존 함수·인자를 그대로 부른다 (C-M1·M-02·M-03)
//  ② 위험 버튼은 위험색·멀리, 주인공 꽉 찬 버튼은 하나, 고른 칩은 academy-choice (M-01·M-04·M-05·C-M2·M-07~M-10)
//  ③ 터치 44px·글자 12px 이상 (M-10·M-11·M-13)
//  ④ 결제 심사 중인 수납·청구·납부 부분은 그대로 (보류)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function compileModule(path, imports = {}) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => (name in imports ? imports[name] : require(name)) });
  return module.exports;
}

// DOM 없이 부품 동작을 돌려 보는 아주 작은 훅 흉내(useState·useEffect)
function hookHarness() {
  let slots = [];
  let cursor = 0;
  let effects = [];
  const fakeReact = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useEffect(effect) { effects.push(effect); },
  };
  return {
    fakeReact,
    render(Component, props) {
      cursor = 0;
      effects = [];
      const tree = Component(props);
      for (const effect of effects) effect();
      cursor = 0;
      effects = [];
      return Component(props); // 효과로 바뀐 상태를 반영한 다시 그리기
    },
  };
}
// 요소 트리에서 버튼을 모은다
function buttons(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((child) => buttons(child, out)); return out; }
  if (node.type === "button") out.push(node);
  buttons(node.props?.children, out);
  return out;
}
const textOf = (node) => (node == null || typeof node === "boolean" ? "" : typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(textOf).join("") : textOf(node.props?.children));

test("InlineConfirm: 처음엔 위험 테두리 버튼 하나, 누르면 «묻는 말 + 꽉 찬 위험 확정 + 유지», 확정 때만 onConfirm", () => {
  const harness = hookHarness();
  const InlineConfirm = compileModule("src/components/parent/InlineConfirm.tsx", { react: harness.fakeReact }).default;
  let calls = 0;
  const props = { label: "취소", question: "이 예약을 취소할까요?", confirmLabel: "취소하기", onConfirm: () => { calls += 1; } };

  let tree = harness.render(InlineConfirm, props);
  let list = buttons(tree);
  assert.equal(list.length, 1);
  assert.match(list[0].props.className, /academy-button-danger(?!-solid)/);
  assert.equal(textOf(list[0]), "취소");

  list[0].props.onClick(); // 펼치기 — 아직 실행 안 함
  assert.equal(calls, 0);
  tree = harness.render(InlineConfirm, props);
  list = buttons(tree);
  assert.match(textOf(tree), /이 예약을 취소할까요\?/);
  assert.deepEqual(list.map((b) => b.props.className), ["academy-button-danger-solid", "academy-button-text"]);
  assert.deepEqual(list.map(textOf), ["취소하기", "유지"]);

  list[1].props.onClick(); // 유지 = 닫기만
  tree = harness.render(InlineConfirm, props);
  assert.equal(calls, 0);
  assert.equal(buttons(tree).length, 1);

  buttons(tree)[0].props.onClick();
  tree = harness.render(InlineConfirm, props);
  buttons(tree)[0].props.onClick(); // 확정
  assert.equal(calls, 1);
});

test("InlineConfirm: 처리 중(pending)엔 두 버튼 모두 잠그고 «처리 중…», 행 안에서는 클릭이 행으로 번지지 않는다", () => {
  const harness = hookHarness();
  const InlineConfirm = compileModule("src/components/parent/InlineConfirm.tsx", { react: harness.fakeReact }).default;
  const props = { label: "취소", question: "취소할까요?", confirmLabel: "취소하기", onConfirm: () => {}, stopPropagation: true };
  let tree = harness.render(InlineConfirm, props);
  let stopped = 0;
  tree.props.onClick({ stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1, "감싼 칸이 클릭 전파를 막는다");
  buttons(tree)[0].props.onClick();
  tree = harness.render(InlineConfirm, { ...props, pending: true });
  const list = buttons(tree);
  assert.ok(list.every((b) => b.props.disabled === true), "처리 중엔 잠금");
  assert.equal(textOf(list[0]), "처리 중…");
  // 닫힌 상태도 처리 중이면 잠긴다
  const html = renderToStaticMarkup(React.createElement(compileModule("src/components/parent/InlineConfirm.tsx").default, { ...props, pending: true }));
  assert.match(html, /<button[^>]*disabled=""[^>]*class="academy-button-danger shrink-0 "/);
});

test("취소 7종은 InlineConfirm 뒤에 기존 함수·인자를 그대로 부른다 (M-02)", () => {
  const cases = [
    ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", /onConfirm=\{\(\) => cancel\(item\.id\)\}/],
    ["src/app/mypage/makeup/MakeupClient.tsx", /onConfirm=\{\(\) => cancel\(c\.id\)\}/],
    ["src/app/mypage/regular-absence/RegularAbsenceClient.tsx", /onConfirm=\{\(\) => cancel\(d\)\}/],
    ["src/app/mypage/seasonal/SeasonalMakeupClient.tsx", /onConfirm=\{\(\) => cancelAbsence\(s\.enrollmentDateId\)\}/],
    ["src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", /onConfirm=\{\(\) => cancel\(child\.pending!\.id\)\}/],
    ["src/app/mypage/roles/RolesClient.tsx", /onConfirm=\{\(\) => cancel\(row\.role\)\}/],
    ["src/app/mypage/children/ChildConnectionsClient.tsx", /onConfirm=\{\(\) => run\(async \(\) => \{ const result = await childLinkRequest\(\{ action: "cancel", requestId: row\.id \}\)/],
  ];
  for (const [path, call] of cases) {
    const source = read(path);
    assert.match(source, /import InlineConfirm from "@\/components\/parent\/InlineConfirm";/, path);
    assert.match(source, call, `${path} — 기존 취소 함수 그대로`);
  }
  // 셔틀은 행 전체가 눌리는 목록 → 확인 칸도 행 탭으로 번지지 않게
  assert.match(read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx"), /onConfirm=\{\(\) => cancel\(item\.id\)\}[\s\S]{0,200}stopPropagation/);
});

test("수강 변경 «퇴원»만 위험 버튼 + 한 번 더 확인, 다른 신청은 주인공 버튼 그대로 같은 submit (M-03)", () => {
  const source = read("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx");
  assert.match(source, /\{kind === "WITHDRAW" \? \([\s\S]*?<InlineConfirm[\s\S]*?label="퇴원 신청하기"[\s\S]*?onConfirm=\{submit\}[\s\S]*?\) : \([\s\S]*?onClick=\{submit\}[\s\S]*?className="academy-button-primary w-full"[\s\S]*?"신청하기"/);
  // 고른 종류 칩 = academy-choice, 꽉 찬 색은 제출 버튼만
  assert.match(source, /aria-pressed=\{kind === value\}\s*onClick=\{\(\) => setKind\(value\)\}\s*className="academy-choice/);
});

test("가족 연결 거절 확정은 꽉 찬 위험색, 승인은 주인공 버튼 (M-04)", () => {
  const source = read("src/app/mypage/children/ChildConnectionsClient.tsx");
  assert.match(source, /onClick=\{resolveRequest\} className=\{decision\.decision === "APPROVE" \? "academy-button-primary" : "academy-button-danger-solid"\}/);
});

test("회원 탈퇴: «돌아가기» 먼저, 계정 삭제는 24px 아래 전체 폭 위험색, 링크 묶음에서도 떼어 위험색 (M-01·M-05)", () => {
  const withdraw = read("src/app/mypage/withdraw/WithdrawClient.tsx");
  const back = withdraw.indexOf('className="academy-button-secondary self-start"');
  const del = withdraw.indexOf('className="academy-button-danger-solid mt-6 w-full"');
  assert.ok(back > 0 && del > back, "돌아가기가 먼저, 삭제는 아래");
  assert.match(withdraw.slice(del, del + 300), /계정 삭제하기/);
  assert.doesNotMatch(withdraw, /bg-red-600|text-\[11px\]/);
  assert.match(withdraw, /className="academy-button-secondary mt-3"[\s\S]{0,80}신청 취소하기/);
  assert.match(withdraw, /className="academy-back-link"/);

  const links = read("src/components/account/AccountLinks.tsx");
  const hrefs = [...links.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.at(-1), "/mypage/withdraw", "회원 탈퇴는 맨 끝");
  assert.match(links, /ml-auto[^"]*pl-4[^"]*text-\[var\(--color-academy-danger\)\][^"]*" href="\/mypage\/withdraw"/);

  const account = read("src/app/account/page.tsx");
  assert.ok(account.indexOf("</nav>") < account.indexOf('href="/account/withdraw"'), "/account 에서도 묶음 밖 별도 칸");
  assert.match(account, /border-t[\s\S]{0,300}href="\/account\/withdraw"[\s\S]{0,200}text-\[var\(--color-academy-danger\)\]/);
});

test("고른 칩은 academy-choice(aria-pressed), 뒤로가기는 44×44, 로그아웃 44px (C-M2·M-09·M-10)", () => {
  for (const path of ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "src/app/mypage/makeup/MakeupClient.tsx", "src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", "src/app/mypage/MyPageClient.tsx"]) {
    const source = read(path);
    assert.match(source, /aria-pressed=\{[^}]+\}[\s\S]{0,200}className="academy-choice/, path);
  }
  for (const path of ["src/app/mypage/shuttle/ShuttleExceptionClient.tsx", "src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx"]) {
    assert.doesNotMatch(read(path), /=== value\s*\?\s*"border-\[var\(--brand-accent\)\] bg-\[var\(--brand-accent\)\]/, `${path} 칩이 제출 버튼처럼 꽉 차면 안 된다`);
  }
  for (const path of ["src/app/mypage/makeup/MakeupClient.tsx", "src/app/mypage/regular-absence/RegularAbsenceClient.tsx", "src/app/mypage/withdraw/WithdrawClient.tsx", "src/app/mypage/roles/RolesClient.tsx", "src/app/mypage/login-methods/page.tsx", "src/app/mypage/reports/[sessionId]/page.tsx"]) {
    assert.match(read(path), /className="academy-back-link/, path);
  }
  assert.match(read("src/app/mypage/layout.tsx"), /className="inline-flex min-h-11[^"]*"\s*>\s*로그아웃/);
});

test("결석·보강 행의 «여는» 버튼은 보조, 꽉 찬 색은 폼 안 최종 제출만, «닫기»는 글자 버튼 (M-08)", () => {
  const makeup = read("src/app/mypage/makeup/MakeupClient.tsx");
  assert.match(makeup, /className=\{`\$\{openId === c\.id \? "academy-button-text" : "academy-button-secondary"\} w-full`\}/);
  assert.match(makeup, /onClick=\{\(\) => book\(c\.id\)\}[\s\S]{0,120}className="academy-button-primary w-full"[\s\S]{0,120}이 날짜로 예약/);
  const regular = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(regular, /onClick=\{\(\) => setOpenKey\(key\)\}[\s\S]{0,200}className="academy-button-tonal shrink-0"/);
  assert.match(regular, /onClick=\{\(\) => report\(d\)\}\s*className="academy-button-primary"/);
  assert.match(regular, /onClick=\{\(\) => setOpenKey\(""\)\}\s*className="academy-button-text"/);
  const seasonal = read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx");
  assert.equal((seasonal.match(/"academy-button-text" : "academy-button-tonal"/g) || []).length, 2);
  assert.match(seasonal, /className="academy-button-primary w-full">결석 신고하기/);
  assert.doesNotMatch(seasonal, /bg-\[var\(--brand-accent\)\]/);
});

test("홈: 히어로 한 덩어리(이름·다음 수업·오늘 셔틀) + «할 일» 줄, 보조 버튼, 알림 44px·푸시 설정 줄 분리 (M-06·M-07·M-11)", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  const hero = home.slice(home.indexOf('<section aria-labelledby="parent-child-heading"'), home.indexOf("</section>", home.indexOf('<section aria-labelledby="parent-child-heading"')));
  assert.match(hero, /\{child\.name\} 학생/);
  assert.match(hero, /다음 수업/);
  assert.match(hero, /오늘 셔틀/);
  assert.match(hero, /aria-label="자녀 선택"[\s\S]*?className="academy-choice"/);
  assert.doesNotMatch(home, /mypage-summary-heading/, "따로 떨어진 요약 칸은 히어로로 합쳤다");
  assert.match(home, /\{unreadCount > 0 && \([\s\S]{0,300}scrollToSection\("mypage-notifications"\)[\s\S]{0,600}안 읽은 알림/);
  assert.match(home, /<div id="mypage-notifications"/);
  // 꽉 찬 색이던 보조 동작 → 테두리
  assert.match(home, /href="\/mypage\/seasonal"\s*\/\/[^\n]*\n\s*className="academy-button-secondary mt-3"/);
  assert.match(home, /className="academy-button-secondary focus-visible:outline-none focus-visible:ring-2/);
  assert.match(home, /className="academy-button-secondary flex-1 basis-44 whitespace-nowrap"/);
  // 알림: 읽음 44×44 · 모두 읽음 44px · 푸시 토글은 목록 아래 설정 줄
  assert.match(home, /inline-flex size-11[^"]*"\s*title="읽음 처리"/);
  assert.match(home, /className="academy-button-text text-\[var\(--color-academy-primary\)\]"\s*>\s*<SymbolIcon name="done_all"/);
  const list = home.indexOf('notifications.map(n =>');
  const push = home.indexOf("onClick={togglePush}");
  assert.ok(list > 0 && push > list, "푸시 설정은 알림 목록 뒤(떨어진 설정 줄)");
  assert.match(home, /inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-bold transition/);
});

test("결제 심사 중 — 홈 수납·청구·납부 블록은 손대지 않았다 (보류)", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /href=\{`\/payments\/\$\{p\.invoiceId\}`\}\s*className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"\s*>\s*청구서 확인하고 납부하기/);
  assert.match(home, /<p className="mt-1 text-\[11px\] font-bold text-gray-500 dark:text-gray-300">\s*청구서 \{p\.invoiceNo\}/);
  assert.match(home, /className="rounded-full bg-brand-orange-500 px-3 py-1\.5 text-xs font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"\s*>\s*납부하기/);
  assert.match(home, /\{ href: "\/mypage\/payments", icon: "receipt_long", label: "청구·수납" \}/);
});

test("리포트 상세는 «우리 아이 수업 현황»이 헤더 바로 아래 (M-12)", () => {
  const source = read("src/app/mypage/reports/[sessionId]/page.tsx");
  const header = source.indexOf("{/* 수업 정보 헤더 */}");
  const mine = source.indexOf("우리 아이 수업 현황");
  const content = source.indexOf("{/* 수업 내용 */}");
  const photos = source.indexOf("{/* 수업 사진 */}");
  assert.ok(header < mine && mine < content && content < photos);
});

test("글자 12px 이상·맨 위 설명 14px, 카카오 연결은 먼저 보이는 쪽만 꽉 찬 색 (M-13·M-14)", () => {
  for (const path of ["src/app/mypage/withdraw/WithdrawClient.tsx", "src/app/mypage/makeup/MakeupClient.tsx", "src/app/mypage/regular-absence/RegularAbsenceClient.tsx", "src/app/mypage/roles/RolesClient.tsx", "src/app/request/[token]/ParentRequestForm.tsx"]) {
    assert.doesNotMatch(read(path), /text-\[11px\]/, path);
  }
  for (const path of ["src/app/mypage/makeup/MakeupClient.tsx", "src/app/mypage/regular-absence/RegularAbsenceClient.tsx", "src/app/mypage/withdraw/WithdrawClient.tsx", "src/app/mypage/roles/RolesClient.tsx", "src/app/mypage/login-methods/page.tsx"]) {
    assert.match(read(path), /\{\/\* 화면 맨 위 설명 한 줄 = 본문 14px \*\/\}\s*<p className="mb-4 text-sm/, path);
  }
  const kakao = read("src/app/kakao-connect/page.tsx");
  assert.match(kakao, /href=\{activateHref\} className=\{`\$\{inApp \? "academy-button-primary" : "academy-button-secondary"\} w-full`\}/);
  assert.match(kakao, /href=\{loginHref\} className=\{`\$\{inApp \? "academy-button-secondary" : "academy-button-primary"\} w-full`\}/);
  assert.match(kakao, /inApp \? <>\{activateButton\}\{loginButton\}<\/> : <>\{loginButton\}\{activateButton\}<\/>/, "순서 바꾸기 그대로");
});
