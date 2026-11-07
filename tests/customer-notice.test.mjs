// 고객 안내 문자(미리보기 → 원장 승인 → 발송) 공용 부품 검사
// - 문구는 실제로 실행해 전문을 확인한다(원장 승인 문구가 몰래 바뀌지 않게)
// - 서버 동작은 소스를 읽어 안전장치(관리자 확인·대조·중복 방지·자동 발송 없음)가 빠지지 않았는지 본다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const templateSource = readFileSync("src/lib/customer-notice/templates.ts", "utf8");
const compiled = ts.transpileModule(templateSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const T = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const action = readFileSync("src/app/actions/customer-notice.ts", "utf8");
const sender = readFileSync("src/components/admin/CustomerNoticeSender.tsx", "utf8");
const kakaoUi = readFileSync("src/app/admin/kakao-requests/KakaoRequestsClient.tsx", "utf8");

test("문구 파일은 DB·서버를 모르는 순수 모듈이다", () => {
  assert.doesNotMatch(templateSource, /^import /m);
});

test("카카오 채널 주소: 설정값에서 추가·채팅 주소를 만든다", () => {
  for (const value of ["https://pf.kakao.com/_HhaQG", "https://pf.kakao.com/_HhaQG/chat", "pf.kakao.com/_HhaQG/friend/"]) {
    const links = T.kakaoChannelLinks(value);
    assert.equal(links.addUrl, "https://pf.kakao.com/_HhaQG/friend");
    assert.equal(links.chatUrl, "https://pf.kakao.com/_HhaQG/chat");
  }
  // 설정이 비면 운영 채널로
  assert.equal(T.kakaoChannelLinks("").chatUrl, "https://pf.kakao.com/_HhaQG/chat");
  // http 등 안전하지 않은 다른 주소는 쓰지 않는다
  assert.equal(T.kakaoChannelLinks("http://evil.example").addUrl, T.FALLBACK_KAKAO_CHANNEL_URL);
});

test("접수 결과 문구 — 상태별 전문", () => {
  const approved = T.buildIntakeResultMessage({ studentName: "김민수", intakeKind: "PAUSE", status: "APPROVED" });
  assert.equal(approved, [
    "[STIZ 농구교실] 안녕하세요, 김민수 학부모님.",
    "카카오채널로 보내 주신 휴원 요청을 확인했습니다. 담당자가 반영을 준비하고 있으며, 반영이 끝나면 다시 안내드리겠습니다.",
    "궁금하신 점은 카카오채널로 편하게 말씀해 주세요.",
  ].join("\n"));
  const rejected = T.buildIntakeResultMessage({ studentName: "김민수", intakeKind: "CLASS_CHANGE", status: "REJECTED", extraLine: "  해당 반 정원이\n가득 찼어요 " });
  assert.match(rejected, /반 변경 요청은 아쉽게도 이번에는 진행이 어렵습니다/);
  assert.match(rejected, /\n※ 해당 반 정원이 가득 찼어요\n/);
  assert.match(T.buildIntakeResultMessage({ studentName: "A", intakeKind: "X", status: "CONSULTATION_CLOSED" }), /문의 요청 처리를 마쳤습니다/);
  assert.match(T.buildIntakeResultMessage({ studentName: "A", intakeKind: "MAKEUP", status: "NEEDS_DETAILS" }), /한 번 더 알려 주세요/);
  // 처리 전 상태는 결과 안내 대상이 아니다
  for (const status of ["SUBMITTED", "HELD", "PROCESSING", "FAILED", "DRAFT"]) assert.equal(T.isIntakeResultStatus(status), false);
  assert.equal(T.cleanExtraLine("가".repeat(300)).length, T.CUSTOMER_NOTICE_EXTRA_LINE_MAX);
});

test("카카오채널 링크 안내 — 전문", () => {
  assert.equal(T.buildKakaoChannelInviteMessage({ studentName: "이서준", channelSettingUrl: "https://pf.kakao.com/_HhaQG" }), [
    "[STIZ 농구교실] 안녕하세요, 이서준 학부모님.",
    "카카오채널에서 결석·셔틀·보강을 바로 신청하실 수 있어요.",
    "",
    "1) 채널 추가: https://pf.kakao.com/_HhaQG/friend",
    "2) 채널 채팅창에서 ‘기존 수강생 인증’을 누르면 연결 링크가 옵니다.",
    "3) 링크를 열어 홈페이지 학부모 계정으로 로그인하면 연결이 끝나요. (링크는 받은 뒤 15분 동안 쓸 수 있어요)",
  ].join("\n"));
});

test("대관 안내 — 요금·운동화·주차·신청 링크, 계좌는 없다", () => {
  const body = T.buildRentalGuideMessage();
  for (const part of ["40,000원", "30,000원", "5,000원", "3,000원", "보증금 20,000원", "실내 운동화", "주민센터 주차장", "https://www.stiz-dasan.kr/rental"]) {
    assert.ok(body.includes(part), part);
  }
  assert.doesNotMatch(body, /계좌|은행|예금주|\d{3,}-\d{2,}-\d{4,}/);
});

test("번호 정리·가리기", () => {
  assert.equal(T.normalizeMobilePhone("010-1234-5678"), "01012345678");
  assert.equal(T.normalizeMobilePhone("02-123-4567"), null);
  assert.equal(T.normalizeMobilePhone(""), null);
  assert.equal(T.maskPhone("01012345678"), "***-****-5678");
});

test("서버: 두 동작 모두 관리자 확인이 먼저다", () => {
  for (const name of ["prepareCustomerNotice", "sendCustomerNotice"]) {
    const body = action.slice(action.indexOf(`export async function ${name}`));
    assert.ok(body.indexOf("await requireAdmin()") > -1);
    assert.ok(body.indexOf("await requireAdmin()") < body.indexOf("prisma."), name);
  }
  assert.match(action, /^"use server";/);
});

test("서버: 학부모 번호는 학생·접수 id 로만 찾고 화면에 전체 번호를 돌려주지 않는다", () => {
  assert.doesNotMatch(action, /parentUserId:\s*string;\s*\}|kind: "KAKAO_CHANNEL_INVITE"; parentId/);
  assert.match(action, /kind: "KAKAO_CHANNEL_INVITE"; studentId: string/);
  assert.match(action, /s\."parentId" = k\."parentUserId"/);
  assert.match(action, /maskedRecipient: maskPhone\(notice\.phone\)/);
  const preview = action.slice(action.indexOf("export async function prepareCustomerNotice"), action.indexOf("export async function sendCustomerNotice"));
  assert.doesNotMatch(preview, /phone: notice\.phone|phone,\n/);
  // 감사 기록에는 번호·문구 원문 대신 지문
  assert.match(action, /phoneHash: hashMessageRecipientPhone/);
  assert.match(action, /bodyHash: hashMessageBody/);
});

test("서버: 미리보기에서는 보내지 않고, 보내기는 승인·재대조·중복 잠금 뒤에만", () => {
  const preview = action.slice(action.indexOf("export async function prepareCustomerNotice"), action.indexOf("export async function sendCustomerNotice"));
  assert.doesNotMatch(preview, /sendSmsDetailed|reserveMessageDelivery/);
  const send = action.slice(action.indexOf("export async function sendCustomerNotice"));
  const order = ["approved !== true", "CUSTOMER_NOTICE_PREVIEW", "resolveNotice(input.request)", "pg_advisory_xact_lock", "CUSTOMER_NOTICE_CLAIMED", "reserveMessageDelivery(", "claimMessageDelivery(", "sendSmsDetailed("];
  let last = -1;
  for (const marker of order) {
    const at = send.indexOf(marker);
    assert.ok(at > last, `${marker} 순서`);
    last = at;
  }
  assert.match(send, /"actorUserId" = \$2/); // 남이 만든 미리보기로는 못 보낸다
  assert.match(send, /make_interval\(mins => \$5::int\)/); // 같은 번호 30분 창
  assert.equal(T.CUSTOMER_NOTICE_DUPLICATE_WINDOW_MINUTES, 30);
  // 재시도·예약 없이 1건
  assert.doesNotMatch(action, /setTimeout|setInterval|for \(let attempt/);
});

test("화면: 확인 창(useAdminConfirm) 뒤에만 보내고, 자동 열기는 미리보기까지만", () => {
  assert.match(sender, /useAdminConfirm/);
  const send = sender.slice(sender.indexOf("async function send()"));
  assert.ok(send.indexOf("await confirm(") < send.indexOf("sendCustomerNotice("));
  const effect = sender.slice(sender.indexOf("useEffect(() => {"), sender.indexOf("async function send()"));
  assert.match(effect, /openPreview\(\)/);
  assert.doesNotMatch(effect, /send\(|sendCustomerNotice/);
  assert.doesNotMatch(sender, /window\.confirm/);
});

test("카카오 접수함: 처리를 마친 접수에 결과 안내 부품을 붙인다", () => {
  assert.match(kakaoUi, /<CustomerNoticeSender key=\{`\$\{row\.id\}:\$\{row\.status\}`\} kind="KAKAO_INTAKE_RESULT"/);
  assert.match(kakaoUi, /isIntakeResultStatus\(row\.status\) && identityOk/);
  assert.match(kakaoUi, /setJustDecidedId\(id\);\r?\n\s*router\.refresh\(\)/);
});

test("학생 상세: 학부모 번호가 있을 때 카카오채널 링크 보내기(학생 id 로만)", () => {
  const detail = readFileSync("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");
  assert.match(detail, /\{student\.parent\.phone && \([\s\S]{0,200}<CustomerNoticeSender kind="KAKAO_CHANNEL_INVITE" studentId=\{student\.id\} \/>/);
});

test("카카오 연결 화면의 채널 주소는 관리자 설정값에서 온다(박힌 주소 없음)", () => {
  const page = readFileSync("src/app/kakao-connect/page.tsx", "utf8");
  assert.doesNotMatch(page, /pf\.kakao\.com/);
  assert.match(page, /kakaoChannelLinks\(\(await getAcademySettings\(\)\)\?\.kakaoChannelUrl\)\.chatUrl/);
});
