// 학부모 문의 «이어 쓰기»(대화)·환불 문의 (2026-11-14 원장 결정표 c3·c11) — 실제로 실행·렌더해서 확인한다.
//  ① 규칙: 글 길이 한도 · 대화 순서 · 학부모에게 보이는 상태 · 답한 뒤 상태
//  ② 권한: 내 문의만 보고 이어 쓴다(남의 문의 id 는 0행) · 내 아이 청구만 환불 문의
//  ③ 학원 답: 대화에 한 줄 · 대기중 → 확인됨 · 새 표가 없으면 옛 칸(adminNote)에 저장
//  ④ 알림: 학원 답 1건 = 학부모 앱 알림 1건 · 학부모 추가 글 = 원장 앱 알림 · 문자·알림톡 없음
//  ⑤ 환불 문의: 납부 완료만 · 제목에 청구 내용 · 같은 청구에 열린 문의가 있으면 새로 만들지 않음 · 칸이 없어도 접수
//  ⑥ 화면: 대화 렌더 · 홈/설정의 «보낸 문의» 입구 · 기존 요청함 동작 그대로
//  ⑦ 마이그레이션 가드
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 파일을 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const rules = load("src/lib/requests/inquiryThreadRules.ts");

// ── 가짜 DB — 문의·글·청구를 메모리에 두고 SQL 글자로 갈래를 고른다 ────────────────
const missingTable = () => Object.assign(new Error('relation "ParentRequestMessage" does not exist'), { code: "P2010", meta: { code: "42P01" } });
const missingColumn = () => Object.assign(new Error('column "paymentId" does not exist'), { code: "P2010", meta: { code: "42703" } });

function fakeDb(seed = {}) {
  const state = {
    requests: seed.requests ?? [],
    messages: seed.messages ?? [],
    payments: seed.payments ?? [],
    notifications: [],
    calls: [],
    noMessageTable: seed.noMessageTable ?? false,
    noPaymentColumn: seed.noPaymentColumn ?? false,
    tick: 0,
  };
  const now = () => new Date(Date.UTC(2026, 10, 20, 3, 0, state.tick++));
  const run = async (sql, ...args) => {
    state.calls.push({ sql, args });
    if (/FROM "ParentRequestMessage"/.test(sql)) {
      if (state.noMessageTable) throw missingTable();
      return state.messages.filter((m) => args[0].includes(m.requestId)).sort((a, b) => a.createdAt - b.createdAt);
    }
    if (/INSERT INTO "ParentRequestMessage"/.test(sql)) {
      if (state.noMessageTable) throw missingTable();
      if (/'PARENT'/.test(sql)) {
        // 소유 확인이 INSERT 문 안에 있다: r.id = $1 AND r."userId" = $2
        assert.match(sql, /WHERE r\.id = \$1 AND r\."userId" = \$2/);
        const [requestId, userId, body] = args;
        const owned = state.requests.find((r) => r.id === requestId && r.userId === userId);
        if (!owned) return [];
        state.messages.push({ id: `m${state.messages.length + 1}`, requestId, authorRole: "PARENT", authorUserId: userId, body, createdAt: now() });
        return [{ id: requestId }];
      }
      const [requestId, adminId, body] = args;
      state.messages.push({ id: `m${state.messages.length + 1}`, requestId, authorRole: "ADMIN", authorUserId: adminId, body, createdAt: now() });
      return 1;
    }
    if (/^UPDATE "ParentRequest" r SET status = \$3/.test(sql.trim())) {
      const [requestId, userId, status] = args;
      const row = state.requests.find((r) => r.id === requestId && r.userId === userId);
      if (!row) return [];
      row.status = status;
      return [{ title: row.title, studentName: row.studentName ?? null }];
    }
    if (/UPDATE "ParentRequest" SET "adminNote" = \$2, status = \$3/.test(sql)) {
      const row = state.requests.find((r) => r.id === args[0]);
      row.adminNote = args[1];
      row.status = args[2];
      return 1;
    }
    if (/UPDATE "ParentRequest" SET status = \$2/.test(sql)) {
      state.requests.find((r) => r.id === args[0]).status = args[1];
      return 1;
    }
    if (/UPDATE "ParentRequest" SET "paymentId" = \$2/.test(sql)) {
      if (state.noPaymentColumn) throw missingColumn();
      const row = state.requests.find((r) => r.id === args[0] && r.userId === args[3]);
      row.paymentId = args[1];
      row.paymentAmount = args[2];
      return 1;
    }
    if (/FROM "ParentRequest"\s+WHERE "userId" = \$1 AND "paymentId" = \$2/.test(sql)) {
      if (state.noPaymentColumn) throw missingColumn();
      return state.requests.filter((r) => r.userId === args[0] && r.paymentId === args[1] && ["PENDING", "CONFIRMED"].includes(r.status));
    }
    if (/INSERT INTO "ParentRequest"/.test(sql)) {
      const [userId, studentId, title, content] = args;
      const row = { id: `r${state.requests.length + 1}`, userId, studentId, type: "OTHER", title, content, status: "PENDING", adminNote: null, createdAt: now() };
      state.requests.push(row);
      return [{ id: row.id }];
    }
    if (/FROM "Payment" p/.test(sql)) {
      // 내 아이 청구인지 같은 SQL 에서 확인한다
      assert.match(sql, /CHILD_ACCESS\(s,\$1\)/);
      return state.payments.filter((p) => p.id === args[1] && p.parentIds.includes(args[0]));
    }
    if (/FROM "ParentRequest" r/.test(sql) && /WHERE r\.id = \$1 AND r\."userId" = \$2/.test(sql)) {
      return state.requests.filter((r) => r.id === args[0] && r.userId === args[1]);
    }
    if (/FROM "ParentRequest" r/.test(sql) && /WHERE r\."userId" = \$1/.test(sql)) {
      return state.requests.filter((r) => r.userId === args[0]).sort((a, b) => b.createdAt - a.createdAt);
    }
    if (/FROM "ParentRequest" WHERE id = \$1/.test(sql)) return state.requests.filter((r) => r.id === args[0]);
    if (/FROM "User" WHERE role = 'ADMIN'/.test(sql)) return [{ id: "admin-1" }, { id: "admin-2" }];
    if (/INSERT INTO "Notification"/.test(sql)) {
      state.notifications.push({ userId: args[0], message: args[1], linkUrl: args[2], sql });
      return 1;
    }
    throw new Error(`가짜 DB 가 모르는 SQL: ${sql.slice(0, 120)}`);
  };
  return { state, $queryRawUnsafe: run, $executeRawUnsafe: run };
}

const serviceMocks = {
  "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `CHILD_ACCESS(${alias},${expr})` },
  "@/lib/studentVisibility": { notMergedStudent: () => "TRUE" },
};
const service = load("src/lib/requests/inquiry-thread.ts", serviceMocks);

const baseRequest = (over = {}) => ({
  id: "r1", userId: "parent-a", studentId: "s1", studentName: "김하늘", type: "OTHER", title: "김하늘 문의", content: "첫 글",
  status: "PENDING", adminNote: null, createdAt: new Date("2026-11-10T01:00:00Z"), ...over,
});

// ── ① 규칙 ───────────────────────────────────────────────────────────────────

test("① 글 길이: 2,000자까지 · 2,001자·빈 글 거절 · 줄바꿈 정리", () => {
  assert.equal(rules.INQUIRY_BODY_MAX, 2000);
  assert.equal(rules.cleanInquiryBody("가".repeat(2000)).ok, true);
  assert.equal(rules.cleanInquiryBody("가".repeat(2001)).ok, false, "넘긴 글을 잘라 저장하지 않는다");
  assert.equal(rules.cleanInquiryBody("   \n ").ok, false);
  assert.equal(rules.cleanInquiryBody(null).ok, false);
  assert.deepEqual(rules.cleanInquiryBody("  안녕\r\n\r\n\r\n\r\n하세요  "), { ok: true, body: "안녕\n\n하세요" });
});

test("① 대화 순서: 첫 글 → 옛 답변 → 이어 쓴 글(쓴 시각 순)", () => {
  const head = { id: "r1", content: "첫 글", adminNote: " 옛 답변 ", status: "CONFIRMED", createdAt: "2026-11-10T01:00:00.000Z" };
  const thread = rules.buildInquiryThread(head, [
    { id: "b", authorRole: "ADMIN", body: "학원 둘째 답", createdAt: "2026-11-12T01:00:00.000Z" },
    { id: "a", authorRole: "PARENT", body: "추가 글", createdAt: "2026-11-11T01:00:00.000Z" },
    { id: "c", authorRole: "PARENT", body: "같은 시각 뒤", createdAt: "2026-11-12T01:00:00.000Z" },
  ]);
  assert.deepEqual(thread.map((b) => [b.author, b.body]), [
    ["PARENT", "첫 글"], ["ADMIN", "옛 답변"], ["PARENT", "추가 글"], ["ADMIN", "학원 둘째 답"], ["PARENT", "같은 시각 뒤"],
  ]);
  assert.equal(thread[1].at, null, "옛 답변은 쓴 시각을 모른다 — 시각을 보이지 않는다");
  // 답이 없으면 첫 글만
  assert.equal(rules.buildInquiryThread({ ...head, adminNote: "  " }, []).length, 1);
  // 모르는 authorRole 은 학부모 글로(학원 글로 둔갑하지 않는다)
  assert.equal(rules.buildInquiryThread({ ...head, adminNote: null }, [{ id: "x", authorRole: "??", body: "b", createdAt: head.createdAt }])[1].author, "PARENT");
});

test("① 학부모에게 보이는 상태: 답변 대기 / 답변 옴 / 완료 / 반려", () => {
  const s = rules.inquiryParentStatus;
  assert.equal(s({ status: "PENDING", adminNote: null }, null), "WAITING");
  assert.equal(s({ status: "PENDING", adminNote: "답" }, null), "ANSWERED", "옛 답변만 있어도 답변 옴");
  assert.equal(s({ status: "CONFIRMED", adminNote: "답" }, "PARENT"), "WAITING", "내가 마지막으로 썼으면 다시 답변 대기");
  assert.equal(s({ status: "PENDING", adminNote: null }, "ADMIN"), "ANSWERED");
  assert.equal(s({ status: "COMPLETED", adminNote: null }, "PARENT"), "DONE");
  assert.equal(s({ status: "REJECTED", adminNote: null }, "ADMIN"), "REJECTED");
  assert.deepEqual(Object.values(rules.INQUIRY_PARENT_STATUS_LABEL), ["답변 대기", "답변 옴", "완료", "반려"]);
  assert.equal(rules.inquiryFirstLine("\n\n  첫 줄  \n둘째 줄"), "첫 줄");
});

test("① 답한 뒤 상태: 대기중만 확인됨으로 · 고른 상태가 있으면 그 값 · 학부모가 쓰면 대기중", () => {
  assert.equal(rules.statusAfterAdminReply("PENDING"), "CONFIRMED");
  assert.equal(rules.statusAfterAdminReply("COMPLETED"), "COMPLETED");
  assert.equal(rules.statusAfterAdminReply("PENDING", "COMPLETED"), "COMPLETED");
  assert.equal(rules.statusAfterAdminReply("PENDING", "INVENTED"), "CONFIRMED", "모르는 상태는 무시");
  assert.equal(rules.statusAfterParentMessage(), "PENDING");
});

// ── ② 권한 ───────────────────────────────────────────────────────────────────

test("② 내 문의만: 목록·한 건·이어 쓰기 모두 로그인 사용자로 묶는다", async () => {
  const db = fakeDb({ requests: [baseRequest(), baseRequest({ id: "r2", userId: "parent-b", title: "남의 문의" })] });
  assert.deepEqual((await service.listMyInquiries(db, "parent-a")).map((r) => r.id), ["r1"]);
  assert.equal(await service.getMyInquiry(db, "parent-a", "r2"), null, "남의 문의는 열리지 않는다");
  assert.equal((await service.getMyInquiry(db, "parent-a", "r1")).title, "김하늘 문의");

  const denied = await service.addParentInquiryMessage(db, "parent-a", "r2", "남의 문의에 쓰기");
  assert.deepEqual(denied, { ok: false, error: service.INQUIRY_NOT_FOUND });
  assert.equal(db.state.messages.length, 0, "아무것도 쓰이지 않았다");
  assert.equal(db.state.requests[1].status, "PENDING");
});

test("② 이어 쓰기: 대화 끝에 붙고 · 종결된 문의도 대기중으로 돌아온다 · 길이 한도", async () => {
  const db = fakeDb({ requests: [baseRequest({ status: "COMPLETED", adminNote: "옛 답변" })] });
  const tooLong = await service.addParentInquiryMessage(db, "parent-a", "r1", "가".repeat(2001));
  assert.equal(tooLong.ok, false);
  assert.equal(db.state.messages.length, 0);

  const ok = await service.addParentInquiryMessage(db, "parent-a", "r1", "  한 가지 더 여쭤요  ");
  assert.deepEqual(ok, { ok: true, requestId: "r1", title: "김하늘 문의", studentName: "김하늘" });
  assert.equal(db.state.requests[0].status, "PENDING", "관리자 요청함 «대기중»에 다시 뜬다");
  const detail = await service.getMyInquiry(db, "parent-a", "r1");
  assert.deepEqual(detail.bubbles.map((b) => [b.author, b.body]), [["PARENT", "첫 글"], ["ADMIN", "옛 답변"], ["PARENT", "한 가지 더 여쭤요"]]);
  assert.equal(detail.status, "WAITING");
  assert.equal(detail.canReply, true);
});

test("② 새 표가 없는 환경: 화면은 첫 글·옛 답변만 보이고, 이어 쓰기는 안내로 거절", async () => {
  const db = fakeDb({ requests: [baseRequest({ adminNote: "옛 답변" })], noMessageTable: true });
  const rows = await service.listMyInquiries(db, "parent-a");
  assert.equal(rows[0].status, "ANSWERED");
  const detail = await service.getMyInquiry(db, "parent-a", "r1");
  assert.equal(detail.bubbles.length, 2);
  assert.equal(detail.canReply, false);
  assert.deepEqual(await service.addParentInquiryMessage(db, "parent-a", "r1", "추가"), { ok: false, error: service.INQUIRY_REPLY_UNAVAILABLE });
});

// ── ③ 학원 답 ────────────────────────────────────────────────────────────────

test("③ 학원 답: 대화에 한 줄 · 대기중 → 확인됨 · 상태를 같이 고르면 그 상태", async () => {
  const db = fakeDb({ requests: [baseRequest()] });
  const first = await service.addAdminInquiryReply(db, "admin-1", "r1", "확인해 보겠습니다");
  assert.deepEqual(first, { ok: true, parentUserId: "parent-a", title: "김하늘 문의", status: "CONFIRMED", legacy: false });
  assert.equal(db.state.requests[0].adminNote, null, "옛 칸은 건드리지 않는다");
  const second = await service.addAdminInquiryReply(db, "admin-1", "r1", "처리했습니다", "COMPLETED");
  assert.equal(second.status, "COMPLETED");
  const thread = await service.getInquiryThreadForAdmin(db, "r1");
  assert.deepEqual(thread.bubbles.map((b) => [b.author, b.body]), [["PARENT", "첫 글"], ["ADMIN", "확인해 보겠습니다"], ["ADMIN", "처리했습니다"]]);
  assert.equal((await service.addAdminInquiryReply(db, "admin-1", "none", "답")).ok, false);
  assert.equal((await service.addAdminInquiryReply(db, "admin-1", "r1", " ")).ok, false);
  // 신청함 상세 줄
  const facts = await service.inquiryFollowUpFacts(db, ["r1"]);
  assert.deepEqual(facts.get("r1"), [["학원 답", "확인해 보겠습니다"], ["학원 답", "처리했습니다"]]);
});

test("③ 새 표가 없으면 예전처럼 adminNote 한 줄에 저장한다(답변 기능이 멈추지 않는다)", async () => {
  const db = fakeDb({ requests: [baseRequest()], noMessageTable: true });
  const result = await service.addAdminInquiryReply(db, "admin-1", "r1", "답변입니다");
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
  assert.equal(db.state.requests[0].adminNote, "답변입니다");
  assert.equal(db.state.requests[0].status, "CONFIRMED");
  assert.equal((await service.inquiryFollowUpFacts(db, ["r1"])).size, 0);
});

// ── ④ 알림 ───────────────────────────────────────────────────────────────────

function loadActions(db, { parentId = "parent-a", admin = true } = {}) {
  const sent = { adminNotices: [], pushes: [], revalidated: [] };
  const actions = load("src/app/actions/parent-inquiry.ts", {
    ...serviceMocks,
    "next/cache": { revalidatePath: (p) => sent.revalidated.push(p), revalidateTag: () => {} },
    "@/lib/auth-guard": {
      requireVerifiedParent: async () => { if (!parentId) throw new Error("UNAUTHORIZED"); return { appUserId: parentId }; },
      requireAdmin: async () => { if (!admin) throw new Error("FORBIDDEN"); return { appUserId: "admin-1" }; },
    },
    "@/lib/prisma": { prisma: db },
    "@/lib/notification": { createNotificationRecord: async (data) => { sent.adminNotices.push(data); } },
    "@/lib/pushNotification": { sendPushToUser: async (userId, payload) => { sent.pushes.push({ userId, payload }); return { status: "SENT" }; } },
  });
  return { actions, sent };
}

test("④ 학원 답 1건 = 학부모 앱 알림 1건(누르면 그 문의 대화) · 상태를 같이 바꿔도 1건", async () => {
  const db = fakeDb({ requests: [baseRequest()] });
  const { actions, sent } = loadActions(db);
  const result = await actions.replyToParentRequest("r1", "답변입니다", "COMPLETED");
  assert.deepEqual(result, { saved: true, status: "COMPLETED", notification: "REGISTERED" });
  assert.equal(db.state.notifications.length, 1, "알림은 한 번만");
  assert.equal(db.state.notifications[0].userId, "parent-a");
  assert.equal(db.state.notifications[0].linkUrl, "/mypage/requests/r1");
  assert.match(db.state.notifications[0].sql, /'REQUEST'/);
  assert.equal(sent.pushes.length, 1);
  assert.equal(sent.pushes[0].payload.tag, "REQUEST");
  assert.equal(sent.pushes[0].payload.url, "/mypage/requests/r1");
  // 저장에 실패하면 알림도 없다
  assert.equal((await actions.replyToParentRequest("none", "답")).saved, false);
  assert.equal(db.state.notifications.length, 1);
});

test("④ 관리자만 답할 수 있다 · 학부모 추가 글은 원장 앱 알림(REQUEST)만", async () => {
  const db = fakeDb({ requests: [baseRequest()] });
  await assert.rejects(loadActions(db, { admin: false }).actions.replyToParentRequest("r1", "답"), /FORBIDDEN/);
  await assert.rejects(loadActions(db, { admin: false }).actions.getParentRequestThreadForAdmin("r1"), /FORBIDDEN/);
  assert.equal(db.state.messages.length, 0);

  const { actions, sent } = loadActions(db);
  assert.deepEqual(await actions.sendInquiryFollowUp("r1", "추가 글"), { ok: true, requestId: "r1" });
  assert.deepEqual(sent.adminNotices.map((n) => [n.userId, n.type, n.title, n.linkUrl]), [
    ["admin-1", "REQUEST", "문의 추가 글", "/admin/requests"], ["admin-2", "REQUEST", "문의 추가 글", "/admin/requests"],
  ]);
  assert.equal(sent.adminNotices[0].message, "김하늘 - 김하늘 문의");
  assert.equal(db.state.notifications.length, 0, "학부모 본인에게는 알림을 만들지 않는다");
  // 로그인이 풀렸으면 아무것도 쓰지 않는다
  const out = loadActions(db, { parentId: null });
  assert.equal((await out.actions.sendInquiryFollowUp("r1", "추가")).ok, false);
  assert.equal(db.state.messages.length, 1);
});

test("④ 문자·알림톡을 보내지 않는다(앱 안 알림만)", () => {
  for (const file of ["src/app/actions/parent-inquiry.ts", "src/lib/requests/inquiry-thread.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /sendTrackedSms|sendParentSms|notifyAdmins\(|alimtalk|sendFailClosedTrackedSms/i, file);
  }
});

// ── ⑤ 환불 문의 ──────────────────────────────────────────────────────────────

const paidBill = (over = {}) => ({
  id: "pay-1", amount: 72000, status: "PAID", type: "TUITION", description: null, year: 2026, month: 11,
  studentId: "s1", studentName: "김하늘", parentIds: ["parent-a"], ...over,
});

test("⑤ 환불 문의 제목: «환불 문의 · 2026-11 수강료 72,000원»", () => {
  assert.equal(rules.refundInquiryTitle({ year: 2026, month: 11, label: "수강료", amount: 72000 }), "환불 문의 · 2026-11 수강료 72,000원");
  assert.equal(rules.refundInquiryTitle({ year: null, month: null, label: "유니폼", amount: 30000 }), "환불 문의 · 유니폼 30,000원");
  assert.equal(rules.refundInquiryContent("  ", "환불 문의 · 2026-11 수강료 72,000원"), "2026-11 수강료 72,000원 환불을 문의합니다.");
  assert.equal(rules.refundInquiryContent(" 이사 갑니다 ", "x"), "이사 갑니다");
  assert.equal(rules.canAskRefund("PAID"), true);
  for (const status of ["PENDING", "OVERDUE", "REFUNDED", "CANCELED"]) assert.equal(rules.canAskRefund(status), false, status);
});

test("⑤ 내 아이의 납부 완료 청구만 · 청구 id·금액이 문의에 연결된다", async () => {
  const db = fakeDb({ payments: [paidBill(), paidBill({ id: "pay-other", parentIds: ["parent-b"] }), paidBill({ id: "pay-unpaid", status: "PENDING" })] });
  assert.deepEqual(await service.createRefundInquiry(db, "parent-a", "pay-other", ""), { ok: false, error: service.REFUND_PAYMENT_NOT_FOUND });
  assert.deepEqual(await service.createRefundInquiry(db, "parent-a", "pay-unpaid", ""), { ok: false, error: service.REFUND_NOT_PAID });
  assert.equal(db.state.requests.length, 0);

  const made = await service.createRefundInquiry(db, "parent-a", "pay-1", "이사 갑니다");
  assert.equal(made.ok, true);
  assert.equal(made.existing, false);
  assert.match(made.title, /^환불 문의 · 2026-11 .*72,000원$/);
  const row = db.state.requests[0];
  assert.deepEqual([row.userId, row.studentId, row.type, row.status, row.content, row.paymentId, row.paymentAmount],
    ["parent-a", "s1", "OTHER", "PENDING", "이사 갑니다", "pay-1", 72000]);
  // 같은 청구에 열린 문의가 있으면 새로 만들지 않고 그 문의로
  const again = await service.createRefundInquiry(db, "parent-a", "pay-1", "");
  assert.deepEqual([again.ok, again.existing, again.requestId], [true, true, row.id]);
  assert.equal(db.state.requests.length, 1);
  // 대화로 이어진다
  assert.equal((await service.addParentInquiryMessage(db, "parent-a", row.id, "계좌는 문자로 드릴게요")).ok, true);
});

test("⑤ 청구 연결 칸이 없는 환경에서도 접수된다(제목에 청구 내용)", async () => {
  const db = fakeDb({ payments: [paidBill()], noPaymentColumn: true });
  const made = await service.createRefundInquiry(db, "parent-a", "pay-1", "");
  assert.equal(made.ok, true);
  assert.match(db.state.requests[0].title, /환불 문의 · 2026-11/);
  assert.equal(db.state.requests[0].paymentId, undefined);
});

test("⑤ 환불 문의 접수 → 원장 앱 알림 · 이미 열린 문의면 알림을 다시 만들지 않는다", async () => {
  const db = fakeDb({ payments: [paidBill()] });
  const { actions, sent } = loadActions(db);
  const first = await actions.sendRefundInquiry("pay-1", "");
  assert.equal(first.ok, true);
  assert.equal(sent.adminNotices.length, 2);
  assert.equal(sent.adminNotices[0].title, "환불 문의 접수");
  assert.match(sent.adminNotices[0].message, /^김하늘 - 환불 문의 · 2026-11 /);
  const second = await actions.sendRefundInquiry("pay-1", "");
  assert.deepEqual([second.ok, second.requestId, second.notice], [true, first.requestId, "이미 보낸 환불 문의가 있어요."]);
  assert.equal(sent.adminNotices.length, 2);
});

// ── ⑥ 화면 ───────────────────────────────────────────────────────────────────

test("⑥ 대화 렌더: 순서 그대로 · 보는 사람 글은 «나» · 옛 답변은 시각 없음", () => {
  const InquiryThread = load("src/components/parent/InquiryThread.tsx").default;
  const html = renderToStaticMarkup(React.createElement(InquiryThread, {
    viewer: "PARENT",
    bubbles: [
      { key: "first", author: "PARENT", body: "첫 글", timeLabel: "11. 10. 10:00" },
      { key: "legacy-answer", author: "ADMIN", body: "옛 답변", timeLabel: "" },
      { key: "m1", author: "PARENT", body: "추가 글\n둘째 줄", timeLabel: "11. 11. 09:00" },
    ],
  }));
  assert.ok(html.indexOf("첫 글") < html.indexOf("옛 답변") && html.indexOf("옛 답변") < html.indexOf("추가 글"));
  assert.equal((html.match(/data-inquiry-author="PARENT"/g) ?? []).length, 2);
  assert.match(html, /<span class="font-semibold">나<\/span><span class="tabular-nums"> · 11\. 10\. 10:00<\/span>/);
  assert.match(html, /<span class="font-semibold">학원<\/span><\/p>/, "옛 답변은 시각을 그리지 않는다");
  // 관리자가 보면 학부모 글은 «학부모», 학원 글은 «나»
  const adminHtml = renderToStaticMarkup(React.createElement(InquiryThread, { viewer: "ADMIN", bubbles: [{ key: "a", author: "PARENT", body: "글", timeLabel: "" }, { key: "b", author: "ADMIN", body: "답", timeLabel: "" }] }));
  assert.match(adminHtml, />학부모</);
  assert.match(adminHtml, />나</);
  assert.doesNotMatch(read("src/components/parent/InquiryThread.tsx"), /#[0-9a-fA-F]{3,6}\b|font-(extrabold|black)|material-symbols|UiIcon/);
});

test("⑥ «보낸 문의» 입구는 홈·설정에 늘 있다 · 목록·대화 화면은 내 문의만", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  // 조건 없이 그리는 줄(«처리할 일» 칸 밖)
  const always = home.slice(home.indexOf('<ul aria-label="더 보기"'));
  assert.match(always.slice(0, 700), /<Link href="\/mypage\/requests" className=\{TODO_ROW\}>/);
  assert.doesNotMatch(home, /보낸 메시지/, "옛 이름·옛 목록은 «보낸 문의» 화면으로 옮겼다");
  assert.match(read("src/app/mypage/settings/page.tsx"), /<LinkRow href="\/mypage\/requests" label="보낸 문의" \/>/);
  assert.match(read("src/app/mypage/MyPageBottomNav.tsx"), /"\/mypage\/requests"/);

  const list = read("src/app/mypage/requests/page.tsx");
  assert.match(list, /listMyInquiries\(prisma, parent\.appUserId\)/);
  assert.match(list, /href=\{`\/mypage\/requests\/\$\{row\.id\}`\}/);
  assert.match(list, /href="\/mypage#parent-request-form"/, "새 문의는 홈 문의 폼 한 곳");
  const detail = read("src/app/mypage/requests/[id]/page.tsx");
  assert.match(detail, /getMyInquiry\(prisma, parent\.appUserId, id\)/);
  assert.match(detail, /if \(!inquiry\) notFound\(\)/);
  // 신청 내역(수업 탭)의 문의 줄도 대화 화면으로
  assert.match(read("src/lib/requests/parent-timeline.ts"), /openHref: `\/mypage\/requests\/\$\{r\.id\}`/);
});

test("⑥ 관리자 요청함: 대화를 보이고 답을 이어 쓴다 · 상태만 바꾸는 기존 동작은 그대로", () => {
  const client = read("src/app/admin/requests/RequestsAdminClient.tsx");
  assert.match(client, /getParentRequestThreadForAdmin\(id\)/);
  assert.match(client, /<InquiryThread\s+viewer="ADMIN"/);
  assert.match(client, /replyToParentRequest\(id, draft, status\)/);
  assert.match(client, /updateRequestStatus\(req\.id, s\.value, note\)/, "초안이 없으면 기존 상태 변경 그대로");
  assert.match(client, /const note = req\.adminNote \?\? "";/, "저장된 옛 답변을 지우지 않는다");
  const inbox = read("src/app/admin/inbox/InboxClient.tsx");
  assert.match(inbox, /note\.trim\(\) \? replyToParentRequest\(row\.id, note\.trim\(\), status\) : updateRequestStatus\(row\.id, status\)/);
  assert.match(read("src/lib/requests/admin-inbox.ts"), /inquiryFollowUpFacts\(prisma, inquiryIds\)\.catch/);
  // 상태 변경 서버 동작은 손대지 않았다(허용 상태·2,000자·같은 값 재전송 안 함)
  const admin = read("src/app/actions/admin.ts");
  assert.match(admin, /\["PENDING", "CONFIRMED", "COMPLETED", "REJECTED"\]\.includes\(status\)/);
  assert.match(admin, /WHERE id = \$3 AND status = \$4 AND "adminNote" IS NOT DISTINCT FROM \$5 RETURNING id/);
});

// ── ⑦ 마이그레이션 ───────────────────────────────────────────────────────────

test("⑦ 마이그레이션: 여러 번 돌려도 같은 결과 · RLS 강제 · 권한 회수 · 되돌림 주석 · timestamptz", () => {
  const sql = read("prisma/migrations/20261115110000_parent_request_thread/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."ParentRequestMessage"/);
  assert.match(sql, /"createdAt" TIMESTAMPTZ\(6\) NOT NULL DEFAULT NOW\(\)/);
  assert.match(sql, /CHECK \("authorRole" IN \('PARENT', 'ADMIN'\)\)/);
  assert.match(sql, /CHECK \(char_length\(body\) BETWEEN 1 AND 2000\)/, "코드 한도(INQUIRY_BODY_MAX)와 같은 값");
  assert.match(sql, /REFERENCES public\."ParentRequest" \(id\)\s+ON DELETE CASCADE/);
  assert.match(sql, /ALTER TABLE public\."ParentRequestMessage" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE public\."ParentRequestMessage" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."ParentRequestMessage" FROM anon, authenticated;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "paymentId" TEXT;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "paymentAmount" INTEGER;/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "ParentRequest_paymentId_idx"/);
  for (const undo of [/-- DROP TABLE IF EXISTS public\."ParentRequestMessage";/, /-- ALTER TABLE public\."ParentRequest" DROP COLUMN IF EXISTS "paymentId";/, /-- ALTER TABLE public\."ParentRequest" DROP COLUMN IF EXISTS "paymentAmount";/]) assert.match(sql, undo);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/, "실행되는 줄에는 지우는 문이 없다");
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model ParentRequestMessage \{/);
  assert.match(schema, /paymentId\s+String\?/);
});
