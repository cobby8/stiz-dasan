// 상담 신청(2026-11-10 원장 승인 k1·m4) — 입력 검증·상태 전이·신청함 행·DB 제약 일치·권한 게이트를 실제로 돌려 확인한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/consult/consult-rules.ts");
const service = await loadTsModule("src/lib/consult/consult-service.ts");
const read = (p) => readFileSync(p, "utf8");
const MIGRATION = read("prisma/migrations/20261110160000_consult_request/migration.sql");

const GOOD = {
  studentName: "  김 동생 ",
  grade: "초2",
  guardianName: "김엄마",
  guardianPhone: "010-1234-5678",
  preferredDays: ["수", "월", "없는요일"],
  preferredTimes: ["평일 오후(방과 후)", "아무거나"],
  message: "형과 같은 시간에\r\n\r\n\r\n다닐 수 있을까요?",
  privacyConsent: true,
};

// ── DB 제약 ↔ 코드 상수 ──────────────────────────────────────────────────

const checkList = (column) => {
  const m = MIGRATION.match(new RegExp(`${column} IN \\(([^)]+)\\)`));
  assert.ok(m, `${column} CHECK 를 찾지 못했습니다`);
  return m[1].split(",").map((v) => v.trim().replace(/'/g, "")).sort();
};

test("DB CHECK 의 상태·경로 집합 = 코드 CONSULT_STATUSES·CONSULT_SOURCES (한쪽만 바꾸면 저장이 통째로 거부된다)", () => {
  assert.deepEqual(checkList("status"), [...rules.CONSULT_STATUSES].sort());
  assert.deepEqual(checkList("source"), [...rules.CONSULT_SOURCES].sort());
  // 신청함 칸 지도도 같은 상태 집합을 빠짐없이 덮는다
  assert.deepEqual(Object.keys(rules.CONSULT_STATUS_MAP).sort(), [...rules.CONSULT_STATUSES].sort());
});

test("마이그레이션: 여러 번 실행 가능 · 공개 키 차단(RLS) · 앱 신청 계정 필수 · 되돌림 SQL 주석", () => {
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS "ConsultRequest"/);
  assert.match(MIGRATION, /ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATION, /REVOKE ALL ON "ConsultRequest" FROM PUBLIC/);
  assert.match(MIGRATION, /source <> 'PARENT_APP' OR "requestedByUserId" IS NOT NULL/);
  assert.match(MIGRATION, /"guardianPhone" ~ '\^01\[016789\]\[0-9\]\{7,8\}\$'/);
  assert.match(MIGRATION, /--\s+DROP TABLE IF EXISTS "ConsultRequest";/);
  assert.match(MIGRATION, /사전 확인\(SELECT\)/);
  // schema.prisma 에도 같은 표가 있다(DB 사본)
  assert.match(read("prisma/schema.prisma"), /model ConsultRequest \{/);
});

// ── 입력 검증 ────────────────────────────────────────────────────────────

test("검증: 정상 입력은 정리돼서 통과 — 이름 공백·번호 숫자만·요일은 허용 목록 순서·모르는 값은 버림", () => {
  const r = rules.validateConsultInput(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.value.studentName, "김 동생");
  assert.equal(r.value.guardianPhone, "01012345678");
  assert.equal(r.value.preferredDays, "월·수");
  assert.equal(r.value.preferredTimes, "평일 오후(방과 후)");
  assert.equal(r.value.message, "형과 같은 시간에\n\n다닐 수 있을까요?"); // 빈 줄 여러 개는 하나로
});

test("검증: 필수 칸(학생 이름·학년·휴대폰·개인정보 동의)이 빠지면 거절", () => {
  const bad = (patch) => rules.validateConsultInput({ ...GOOD, ...patch });
  assert.equal(bad({ studentName: "   " }).ok, false);
  assert.equal(bad({ grade: "" }).ok, false);
  assert.equal(bad({ grade: "초7" }).ok, false); // 목록 밖 학년
  assert.equal(bad({ guardianPhone: "02-123-4567" }).ok, false); // 휴대폰 아님
  assert.equal(bad({ guardianPhone: "010-12" }).ok, false);
  assert.equal(bad({ privacyConsent: false }).ok, false);
  assert.equal(bad({ privacyConsent: "true" }).ok, false); // 글자 "true" 는 동의가 아니다(정확히 true 만)
  assert.equal(rules.validateConsultInput(null).ok, false);
});

test("검증: 선택 칸은 비워도 통과(최소 수집) · 너무 긴 글은 잘린다", () => {
  const r = rules.validateConsultInput({ studentName: "가".repeat(80), grade: "6세", guardianPhone: "01098765432", privacyConsent: true, message: "x".repeat(2000) });
  assert.equal(r.ok, true);
  assert.equal(r.value.studentName.length, rules.CONSULT_LIMITS.studentName);
  assert.equal(r.value.message.length, rules.CONSULT_LIMITS.message);
  assert.equal(r.value.guardianName, null);
  assert.equal(r.value.preferredDays, null);
  assert.equal(r.value.preferredTimes, null);
});

test("공개 경로는 PUBLIC_WEB/CHATBOT 만 — 화면이 PARENT_APP 을 보내도 앱 신청으로 저장되지 않는다", () => {
  assert.equal(rules.publicConsultSource("CHATBOT"), "CHATBOT");
  assert.equal(rules.publicConsultSource("PARENT_APP"), "PUBLIC_WEB");
  assert.equal(rules.publicConsultSource(undefined), "PUBLIC_WEB");
});

// ── 상태 지도·전이 ───────────────────────────────────────────────────────

test("신청함 칸: NEW=처리 필요 · CONTACTED=진행 중 · DONE/CANCELED=완료", () => {
  assert.deepEqual(rules.consultStatusesOf("ACTION"), ["NEW"]);
  assert.deepEqual(rules.consultStatusesOf("ONGOING"), ["CONTACTED"]);
  assert.deepEqual(rules.consultStatusesOf("DONE"), ["DONE", "CANCELED"]);
});

test("누를 수 있는 버튼: 새 상담 = 연락함·완료·취소·메모 / 연락함 = 완료·취소·메모 / 끝난 건 = 메모만", () => {
  assert.deepEqual(rules.consultActionsFor("NEW"), ["CONTACTED", "DONE", "CANCELED", "NOTE"]);
  assert.deepEqual(rules.consultActionsFor("CONTACTED"), ["DONE", "CANCELED", "NOTE"]);
  assert.deepEqual(rules.consultActionsFor("DONE"), ["NOTE"]);
  assert.deepEqual(rules.consultActionsFor("CANCELED"), ["NOTE"]);
});

// ── 저장(가짜 DB) ────────────────────────────────────────────────────────

function fakeDb({ existing = [], counts = {}, updated = [{ status: "CONTACTED" }] } = {}) {
  const calls = [];
  return {
    calls,
    async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; },
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("status = 'NEW'") && sql.includes("LOWER(\"studentName\")")) return existing;
      if (sql.includes("AS phone10")) return [{ phone10: 0, phoneDay: 0, ip10: 0, ipDay: 0, all10: 0, ...counts }];
      if (sql.startsWith("INSERT")) return [{ id: "new-id" }];
      if (sql.trimStart().startsWith("UPDATE")) return updated;
      return [];
    },
  };
}
const IP = "a".repeat(64);

test("저장: 줄 세우기(advisory lock) 후 INSERT · 경로/계정/접속 지문이 그대로 들어간다", async () => {
  const db = fakeDb();
  const r = await service.createConsultRequest(db, GOOD, { source: "CHATBOT", clientIpHash: IP });
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.id, "new-id");
  assert.match(db.calls[0].sql, /pg_advisory_xact_lock/);
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT"));
  assert.deepEqual(insert.values.slice(7), ["CHATBOT", null, IP]);
  assert.equal(insert.values[3], "01012345678");
});

test("저장: 이상한 접속 지문은 버리고, 하루 안 같은 번호·같은 학생의 새 상담은 새로 만들지 않는다", async () => {
  const odd = fakeDb();
  await service.createConsultRequest(odd, GOOD, { source: "PUBLIC_WEB", clientIpHash: "1.2.3.4" });
  assert.equal(odd.calls.find((c) => c.sql.startsWith("INSERT")).values[9], null);

  const dup = fakeDb({ existing: [{ id: "old-id" }] });
  const r = await service.createConsultRequest(dup, GOOD, { source: "PUBLIC_WEB" });
  assert.deepEqual([r.ok, r.duplicate, r.id], [true, true, "old-id"]);
  assert.equal(dup.calls.some((c) => c.sql.startsWith("INSERT")), false);
});

test("저장: 한도(번호 10분 3건·하루 6건·접속 주소·전체 10분 30건)를 넘으면 거절", async () => {
  for (const counts of [{ phone10: 3 }, { phoneDay: 6 }, { ip10: 5 }, { ipDay: 15 }, { all10: 30 }]) {
    const db = fakeDb({ counts });
    const r = await service.createConsultRequest(db, GOOD, { source: "PUBLIC_WEB", clientIpHash: IP });
    assert.equal(r.ok, false, JSON.stringify(counts));
    assert.equal(db.calls.some((c) => c.sql.startsWith("INSERT")), false);
  }
});

test("저장: 앱 신청(PARENT_APP)은 계정 없이는 거절 · 입력이 틀리면 DB 를 건드리지 않는다", async () => {
  const db = fakeDb();
  assert.equal((await service.createConsultRequest(db, GOOD, { source: "PARENT_APP", requestedByUserId: "" })).ok, false);
  assert.equal((await service.createConsultRequest(db, { ...GOOD, privacyConsent: false }, { source: "PUBLIC_WEB" })).ok, false);
  assert.equal(db.calls.length, 0);
  const ok = fakeDb();
  assert.equal((await service.createConsultRequest(ok, GOOD, { source: "PARENT_APP", requestedByUserId: "user-1" })).ok, true);
  assert.equal(ok.calls.find((c) => c.sql.startsWith("INSERT")).values[8], "user-1");
});

// ── 관리자 처리(가짜 DB) ─────────────────────────────────────────────────

test("처리: 모르는 버튼·빈 id·메모 없는 메모 저장은 DB 전에 거절", async () => {
  const db = fakeDb();
  assert.equal((await service.transitionConsultRequest(db, "id1", "DELETE", undefined, "admin")).ok, false);
  assert.equal((await service.transitionConsultRequest(db, "", "DONE", undefined, "admin")).ok, false);
  assert.equal((await service.transitionConsultRequest(db, "id1", "NOTE", undefined, "admin")).ok, false);
  assert.equal(db.calls.length, 0);
});

test("처리: 조건부 UPDATE — 허용된 «이전 상태» 목록과 처리한 관리자를 넘기고, 못 바꾸면 쉬운 말로 실패", async () => {
  const db = fakeDb();
  const r = await service.transitionConsultRequest(db, "id1", "CONTACTED", "  통화함  ", "admin-1");
  assert.deepEqual(r, { ok: true, status: "CONTACTED" });
  const [id, to, noteGiven, note, admin, from] = db.calls[0].values;
  assert.deepEqual([id, to, noteGiven, note, admin, from], ["id1", "CONTACTED", true, "통화함", "admin-1", ["NEW"]]);

  const memoOnly = fakeDb({ updated: [{ status: "DONE" }] });
  await service.transitionConsultRequest(memoOnly, "id1", "NOTE", "", "admin-1");
  assert.deepEqual(memoOnly.calls[0].values.slice(1, 4), [null, true, null]); // 상태 그대로 · 메모 지움

  const none = fakeDb({ updated: [] });
  assert.equal((await service.transitionConsultRequest(none, "id1", "DONE", undefined, "admin-1")).ok, false);
  assert.equal(none.calls[0].values[2], false); // 메모를 안 넘기면 메모는 건드리지 않는다
});

// ── 신청함 공통 행 ───────────────────────────────────────────────────────

test("신청함 행: kind=CONSULT · 칸/이름 · 연락처는 보기 좋게 · 연락한 날은 KST 달력 날짜 · 버튼 목록", () => {
  const row = service.toConsultInboxRow({
    id: "c1", studentName: "김동생", grade: "초2", guardianName: "김엄마", guardianPhone: "01012345678",
    preferredDays: "월·수", preferredTimes: "평일 오후(방과 후)", message: "형과 같은 반", source: "PARENT_APP",
    requestedByUserId: "u1", status: "CONTACTED", adminNote: "11일 다시 전화", contactedAt: "2026-11-10T16:30:00.000Z", // KST 11-11 01:30
    closedAt: null, handledByUserId: "a1", handledByName: "원장", createdAt: new Date("2026-11-10T01:00:00.000Z"),
  });
  assert.equal(row.kind, "CONSULT");
  assert.equal(row.bucket, "ONGOING");
  assert.equal(row.statusLabel, "연락함");
  assert.equal(row.createdAt, "2026-11-10T01:00:00.000Z");
  assert.equal(row.detailHref, "/admin/inbox?kind=CONSULT");
  const facts = Object.fromEntries(row.facts);
  assert.equal(facts["연락처"], "010-1234-5678");
  assert.equal(facts["연락한 날"], "2026-11-11"); // UTC 로 자르면 11-10 이 나온다(자정 경계)
  assert.equal(facts["접수 경로"], "학부모 앱");
  assert.equal(row.ref.phone, "01012345678");
  assert.equal(row.ref.actions, "DONE,CANCELED,NOTE");
  assert.match(row.summary, /희망 월·수 평일 오후/);
});

test("관리자 알림 글에는 연락처를 넣지 않는다(잠금 화면 노출 방지)", () => {
  const text = rules.consultAdminAlertText({ studentName: "김동생", grade: "초2", preferredDays: "월", preferredTimes: null }, "CHATBOT");
  assert.equal(text, "김동생 (초2) · 희망 월 · 챗봇");
  assert.doesNotMatch(text, /010/);
});

// ── 권한 게이트·연결 지점(소스 확인) ─────────────────────────────────────

const actions = read("src/app/actions/consult.ts");
const fnBody = (name) => {
  const start = actions.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, name);
  const next = actions.indexOf("\nexport ", start + 10);
  return actions.slice(start, next < 0 ? undefined : next);
};

test("권한: 관리자 처리는 requireAdmin 을 DB 보다 먼저 · 앱 신청은 requireVerifiedParent 로 계정을 서버가 정한다", () => {
  assert.match(actions, /^"use server";/);
  const update = fnBody("updateConsultRequest");
  assert.ok(update.indexOf("await requireAdmin()") >= 0 && update.indexOf("await requireAdmin()") < update.indexOf("transitionConsultRequest(prisma"));
  assert.match(update, /admin\.appUserId/); // 처리한 사람은 화면 값이 아니라 로그인 계정

  const parent = fnBody("submitParentConsultRequest");
  assert.match(parent, /requireVerifiedParent\(\)\)\.appUserId/);
  assert.match(parent, /saveAndNotify\(input, "PARENT_APP", parentUserId\)/);

  const pub = fnBody("submitConsultRequest");
  assert.match(pub, /if \(input\?\.honeypot\)/); // 스팸 숨김 칸
  assert.match(pub, /publicConsultSource\(input\?\.source\), null\)/); // 공개 신청은 계정 id 를 받지 않는다
  assert.doesNotMatch(pub, /requestedByUserId/);
});

test("알림: 관리자 벨·웹푸시만(코치·문자 없음), 링크는 신청함 상담 탭", () => {
  assert.match(actions, /notifyAdmins\("CONSULT_REQUEST", "상담 신청", consultAdminAlertText\(value, source\), CONSULT_INBOX_HREF, \{\s*notifyCoaches: false,/);
  assert.doesNotMatch(actions, /adminTrigger|sendParentSms|sendTrackedSms/);
});

test("연결 지점: /apply 세 번째 칸 · 챗봇 [ACTION:CONSULT] · 학부모 ⋯ 메뉴 · 신청함 연결부", () => {
  const apply = read("src/app/apply/ApplyPageClient.tsx");
  assert.match(apply, /href="\/apply\/consult" className="public-btn-secondary/); // 주인공(체험·수강) 버튼 2개는 그대로
  const chat = read("src/app/api/chat/route.ts");
  assert.match(chat, /reply\.includes\("\[ACTION:CONSULT\]"\)/);
  assert.match(chat, /"\/apply\/consult\?from=chatbot"/);
  assert.match(chat, /응답 맨 끝에 \[ACTION:CONSULT\] 태그/);
  assert.match(read("src/app/apply/consult/page.tsx"), /from\?\.toLowerCase\(\) === "chatbot" \? "CHATBOT"/);
  assert.match(read("src/app/mypage/ParentMoreMenu.tsx"), /href: "\/mypage\/consult"/);
  const consultPage = read("src/app/mypage/consult/page.tsx");
  assert.match(consultPage, /requireVerifiedParent\(\)/);
  const inbox = read("src/lib/requests/consult-inbox.ts");
  assert.match(inbox, /export async function listConsultInboxRows\(/);
  assert.match(inbox, /export async function countConsultAction\(\): Promise<number>/);
});

test("공개 상담 화면은 컴팩트 배너 · 체험 전용 주황 규칙을 건드리지 않는다", () => {
  const page = read("src/app/apply/consult/page.tsx");
  assert.match(page, /className="public-page-hero public-page-hero--compact /);
  // 주황 버튼은 /apply/trial 링크에만 걸린다 — 상담 버튼 주소는 그 선택자에 안 걸린다
  assert.doesNotMatch(read("src/components/public-sport.css"), /apply\/consult/);
});
