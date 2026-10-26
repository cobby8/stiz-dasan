import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// 화면은 만들었는데 **가는 길이 없어 아무도 못 쓰는** 사고가 이 프로젝트에서 두 번 났다
// (2026-08-05 현장 수납 승인, 2026-08-09 입금 확인·수강 변경). 빌드·타입검사·테스트가
// 모두 통과해 아무 신호가 없다는 게 이 유형의 본질이다. 그래서 진입점을 테스트로 못박는다.
//
// 회원 탈퇴는 거기에 하나 더 있다 — 구글플레이가 **앱 안에서** 계정을 삭제할 수 있어야
// 등록을 허용한다. 링크가 사라지면 기능이 아니라 스토어 등록이 막힌다.

const myPage = fs.readFileSync("src/components/account/AccountLinks.tsx", "utf8");
const layout = fs.readFileSync("src/app/mypage/layout.tsx", "utf8");
const page = fs.readFileSync("src/app/mypage/withdraw/page.tsx", "utf8");
const client = fs.readFileSync("src/app/mypage/withdraw/WithdrawClient.tsx", "utf8");

test("마이페이지에서 탈퇴 화면으로 가는 길이 있다", () => {
  assert.match(myPage, /href="\/mypage\/withdraw"/);
  assert.match(myPage, /회원 탈퇴/);
  assert.match(layout, /<AccountLinks\s*\/>/);
});

test("탈퇴 페이지는 학부모 인증을 거치고 캐시되지 않는다", () => {
  assert.match(page, /requireVerifiedParent\(\)/);
  // 남의 계정 화면이 캐시돼 보이면 안 된다.
  assert.match(page, /export const dynamic = "force-dynamic"/);
  // 로그인하지 않았으면 되돌려보낸다(무한 반복을 피해 bounced=1).
  assert.match(page, /redirect\("\/mypage\/continue\?bounced=1"\)/);
  // 서버에서 상태를 읽어 내려야 «재학 중이라 즉시 삭제되지 않는다»를 누르기 전에 알릴 수 있다.
  assert.match(page, /getAccountWithdrawalStatus\(\)/);
});

test("무엇이 지워지고 무엇이 남는지 화면에 적혀 있다", () => {
  // 구글플레이 심사 요건이자, 적어 두지 않으면 "출결 기록도 사라지나요" 문의가 전화로 온다.
  assert.match(client, /삭제되는 정보/);
  assert.match(client, /보관되는 정보/);
  // 삭제 목록에 로그인 수단·연락처·위치가 모두 들어가야 한다.
  for (const keyword of ["로그인 계정", "전화번호", "카카오", "푸시", "셔틀"]) {
    assert.match(client, new RegExp(keyword), `삭제 안내에 ${keyword} 가 없다`);
  }
  // 보관 목록과 그 이유(법령)를 함께 적는다. 이유가 없으면 "왜 안 지우냐"가 된다.
  for (const keyword of ["출결", "납부", "전자상거래법", "5년"]) {
    assert.match(client, new RegExp(keyword), `보관 안내에 ${keyword} 가 없다`);
  }
});

test("되돌릴 수 없다는 경고와 확인 절차가 있다", () => {
  assert.match(client, /되돌릴 수 없/);
  // 확인 체크 없이는 버튼을 누를 수 없다.
  assert.match(client, /type="checkbox"/);
  assert.match(client, /disabled=\{!agreed \|\| pending\}/);
});

test("재학 중이면 즉시 삭제가 아니라 신청임을 누르기 전에 알린다", () => {
  assert.match(client, /!initial\.immediate/);
  assert.match(client, /수강 중인 반/);
  assert.match(client, /탈퇴 신청으로 접수/);
  // 버튼 글자도 상황에 따라 달라야 한다 — "삭제하기"를 눌렀는데 신청만 되면 속은 느낌이 든다.
  assert.match(client, /initial\.immediate \? "계정 삭제하기" : "탈퇴 신청하기"/);
});

test("신청 상태에서는 취소할 수 있고, 처리된 뒤에는 되돌릴 수 없다", () => {
  assert.match(client, /cancelAccountWithdrawalRequest/);
  assert.match(client, /신청 취소하기/);
  // 완료 화면에는 취소 버튼이 없어야 한다(되돌릴 수단이 없으므로 버튼을 두면 거짓말이 된다).
  const doneBlock = client.slice(client.indexOf('if (state === "WITHDRAWN")'), client.indexOf("return (\n    <div className=\"mx-auto max-w-2xl px-4 py-6\">\n      {/* 헤더"));
  assert.doesNotMatch(doneBlock, /신청 취소하기/);
  assert.match(doneBlock, /탈퇴가 완료되었습니다/);
});

test("오류를 조용히 삼키지 않는다", () => {
  // 실패했는데 성공처럼 보이면 학부모는 탈퇴됐다고 믿는다.
  assert.match(client, /if \(result && "error" in result && result\.error\)/);
  assert.match(client, /setError\(result\.error\)/);
});
