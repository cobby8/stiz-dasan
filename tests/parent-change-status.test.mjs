import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 학부모 홈 «반 상태 한 줄» + 수강 변경 결정 앱 알림 문구(2026-11-10 신청함 1단계).
// 순수 함수라 실제로 실행해 확인한다.
const source = await readFile("src/lib/enrollment/parentChangeStatus.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildClassStatusLine, buildChangeDecisionNotice, shortMd, CHANGE_NOTICE_LINK } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

const parentLib = await readFile("src/lib/enrollment/parent-change-request.ts", "utf8");
const notify = await readFile("src/lib/enrollment/change-decision-notify.ts", "utf8");
const delivery = await readFile("src/lib/operational-notification-delivery.ts", "utf8");
const queries = await readFile("src/lib/queries.ts", "utf8");

const base = { enrollmentStatus: "ACTIVE", scheduled: null, pending: null, pausedResumeOn: null, today: "2026-11-10" };

test("날짜 줄임은 문자열로만 — 형식이 아니면 빈 값", () => {
  assert.equal(shortMd("2026-12-01"), "12/1");
  assert.equal(shortMd("2027-01-15"), "1/15");
  assert.equal(shortMd(null), "");
  assert.equal(shortMd("2026-12-1"), "");
});

test("그냥 다니는 반은 줄이 없다", () => {
  assert.equal(buildClassStatusLine(base), null);
});

test("승인된 휴원 = «휴원 예정 · 12/1부터»(복귀일 있으면 덧붙임)", () => {
  assert.equal(
    buildClassStatusLine({ ...base, scheduled: { kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: null } }).text,
    "휴원 예정 · 12/1부터",
  );
  assert.equal(
    buildClassStatusLine({ ...base, scheduled: { kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: "2027-01-05" } }).text,
    "휴원 예정 · 12/1부터 · 1/5 복귀 예정",
  );
});

test("적용일이 지났는데 반영 전인 승인 건은 «예정»이라 하지 않는다", () => {
  const line = buildClassStatusLine({ ...base, scheduled: { kind: "CLASS_CHANGE", effectiveFrom: "2026-11-01", resumeOn: null } });
  assert.equal(line.text, "반 변경 승인 · 학원에서 반영 중");
});

test("검토 중 · 휴원 중 · 복귀 예정", () => {
  assert.equal(buildClassStatusLine({ ...base, pending: { kind: "PAUSE", effectiveFrom: "2026-12-01" } }).text, "휴원 신청 검토 중");
  assert.equal(buildClassStatusLine({ ...base, enrollmentStatus: "PAUSED" }).text, "휴원 중");
  assert.equal(buildClassStatusLine({ ...base, enrollmentStatus: "PAUSED", pausedResumeOn: "2027-01-05" }).text, "휴원 중 · 복귀 예정 1/5");
  assert.equal(
    buildClassStatusLine({ ...base, enrollmentStatus: "PAUSED", pending: { kind: "RESUME", effectiveFrom: "2026-12-01" } }).text,
    "휴원 중 · 복귀 신청 검토 중",
  );
  // 승인된 예정이 검토 중보다 먼저
  assert.equal(
    buildClassStatusLine({ ...base, pending: { kind: "WITHDRAW", effectiveFrom: "2026-12-01" }, scheduled: { kind: "PAUSE", effectiveFrom: "2026-12-01", resumeOn: null } }).text,
    "휴원 예정 · 12/1부터",
  );
});

test("결정·적용 알림 문구", () => {
  const common = { studentName: "김루빈", className: "월요일 4교시", kind: "PAUSE", effectiveFrom: "2026-12-01" };
  assert.equal(buildChangeDecisionNotice({ ...common, event: "APPROVED" }).message, "김루빈 월요일 4교시 휴원 신청이 승인됐어요(12/1부터)");
  assert.equal(
    buildChangeDecisionNotice({ ...common, event: "REJECTED", decisionNote: "이번 달은  어렵습니다" }).message,
    "김루빈 월요일 4교시 휴원 신청이 거절됐어요: 이번 달은 어렵습니다",
  );
  assert.equal(buildChangeDecisionNotice({ ...common, event: "REJECTED", decisionNote: null }).message, "김루빈 월요일 4교시 휴원 신청이 거절됐어요");
  assert.equal(buildChangeDecisionNotice({ ...common, event: "APPLIED" }).message, "김루빈 월요일 4교시 휴원이 시작됐어요(12/1부터)");
  // 긴 사유는 잘라서 알림 칸을 넘지 않게
  const long = buildChangeDecisionNotice({ ...common, event: "REJECTED", decisionNote: "가".repeat(200) }).message;
  assert.ok(long.endsWith("…") && long.length < 140);
  assert.equal(CHANGE_NOTICE_LINK, "/mypage/enrollment-change");
});

test("알림은 신청 학부모 한 명·앱만·중복 키·EXTERNAL 장부", () => {
  assert.match(notify, /stableEventKey: `enrollment-change:\$\{requestId\}:\$\{event\}`/);
  // 받는 사람 = 신청자(취소 요청 결과 CANCEL_* 만 취소를 요청한 보호자 — 2026-11-10 d8)
  assert.match(notify, /let recipientUserId = row\.requestedByUserId;/);
  assert.match(notify, /^\s+recipientUserId,$/m);
  assert.match(notify, /audienceScope: "EXTERNAL"/);
  // 관리자 직접 변경(신청자 = 결정자)은 건너뛰고, 지금도 보호자인지 childAccessSql 로 다시 본다
  assert.match(notify, /row\.requestedByUserId === row\.decidedByUserId\) \{[\s\S]{0,120}return "SKIPPED"/);
  assert.match(notify, /childAccessSql\("s", "\$2"\)/);
  // 문자·알림톡 경로를 쓰지 않는다
  assert.doesNotMatch(notify, /sendTrackedSms|sendParentSms|alimtalk/i);
  // 사유는 거절 알림에만
  assert.match(notify, /decisionNote: event === "REJECTED" \|\| event === "CANCEL_REJECTED" \? note : null/);
  // 장부 기본값은 운영진(INTERNAL) 그대로
  assert.match(delivery, /input\.audienceScope === "EXTERNAL" \? "EXTERNAL" : "INTERNAL"/);
});

test("학부모 조회는 자녀 권한 + 병합 학생 제외, 지난 결과는 3개월·거절만 사유", () => {
  const lines = parentLib.slice(parentLib.indexOf("export async function getParentClassStatusLines"), parentLib.indexOf("export type SubmitChangeInput"));
  assert.match(lines, /childAccessSql\("s", "\$1"\)/);
  assert.match(lines, /notMergedStudent\("s"\)/);
  assert.match(lines, /e\.status IN \('ACTIVE','PAUSED'\)/);
  const history = parentLib.slice(parentLib.indexOf("export async function getEnrollmentChangeHistory"), parentLib.indexOf("export type ParentClassStatusLine"));
  assert.match(history, /childAccessSql\("s", "\$1"\)/);
  assert.match(history, /notMergedStudent\("s"\)/);
  assert.match(history, /interval '3 months'/);
  assert.match(history, /CASE WHEN r\.status = 'REJECTED' THEN r\."decisionNote" ELSE NULL END/);
});

test("getMyPageData 의 «이번 달»은 KST 달력(서버 getFullYear/getMonth 금지)", () => {
  const fn = queries.slice(queries.indexOf("export async function getMyPageData"), queries.indexOf("export async function getMyPageHistory"));
  assert.doesNotMatch(fn, /getFullYear\(\)|getMonth\(\)/);
  assert.match(fn, /todayKst\(\)\.slice\(0, 7\)/);
  // 수강 중 기준(ACTIVE)은 그대로 — 휴원 반은 별도 조회(getParentClassStatusLines)로 보인다
  assert.match(fn, /e\.status = 'ACTIVE'/);
});
