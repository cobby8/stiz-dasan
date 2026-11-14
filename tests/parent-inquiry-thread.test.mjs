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
  // 부분 유일 색인 ParentRequest_open_refund_key 흉내: 같은 사람·같은 청구에 열린(PENDING·CONFIRMED) 환불 문의는 하나
  const uniqueRefund = () => Object.assign(new Error('duplicate key value violates unique constraint "ParentRequest_open_refund_key"'), { code: "P2010", meta: { code: "23505" } });
  const openRefundClash = (row, nextStatus) => Boolean(row.paymentId) && ["PENDING", "CONFIRMED"].includes(nextStatus)
    && state.requests.some((o) => o.id !== row.id && o.userId === row.userId && o.paymentId === row.paymentId && ["PENDING", "CONFIRMED"].includes(o.status));
  const run = async (sql, ...args) => {
    state.calls.push({ sql, args });
    if (/^\s*SELECT m\.id, m\."requestId"/.test(sql)) {
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
        // 횟수 제한도 같은 INSERT 문 안: 마지막 학원 글 뒤의 학부모 글 수 < $4
        assert.match(sql, /m\."authorRole" = 'PARENT'[\s\S]*a\."authorRole" = 'ADMIN'[\s\S]*< \$4/);
        const mine = state.messages.filter((m) => m.requestId === requestId);
        const lastAdmin = mine.map((m) => m.authorRole).lastIndexOf("ADMIN");
        if (mine.slice(lastAdmin + 1).length >= args[3]) return [];
        state.messages.push({ id: `m${state.messages.length + 1}`, requestId, authorRole: "PARENT", authorUserId: userId, body, createdAt: now() });
        return [{ id: requestId }];
      }
      const [requestId, adminId, body] = args;
      state.messages.push({ id: `m${state.messages.length + 1}`, requestId, authorRole: "ADMIN", authorUserId: adminId, body, createdAt: now() });
      return 1;
    }
    if (/^\s*SELECT o\.id FROM "ParentRequest" r/.test(sql)) {
      const self = state.requests.find((r) => r.id === args[0] && r.userId === args[1]);
      return state.requests.filter((o) => self && o.id !== self.id && o.userId === self.userId && o.paymentId === self.paymentId && ["PENDING", "CONFIRMED"].includes(o.status)).map((o) => ({ id: o.id }));
    }
    if (/^UPDATE "ParentRequest" r SET status = \$3/.test(sql.trim())) {
      const [requestId, userId, status] = args;
      const row = state.requests.find((r) => r.id === requestId && r.userId === userId);
      if (!row) return [];
      if (openRefundClash(row, status)) throw uniqueRefund();
      row.status = status;
      return [{ title: row.title, studentName: row.studentName ?? null, adminNote: row.adminNote ?? null }];
    }
    if (/UPDATE "ParentRequest" SET "adminNote" = \$2, status = \$3/.test(sql)) {
      // 읽은 뒤 바뀌었으면 0행(다른 관리자의 답을 덮지 않는다)
      assert.match(sql, /WHERE id = \$1 AND "adminNote" IS NOT DISTINCT FROM \$4 RETURNING id/);
      const row = state.requests.find((r) => r.id === args[0] && (r.adminNote ?? null) === (args[3] ?? null));
      if (!row) return [];
      row.adminNote = args[1];
      row.status = args[2];
      return [{ id: row.id }];
    }
    if (/UPDATE "ParentRequest" SET status = \$2/.test(sql)) {
      const row = state.requests.find((r) => r.id === args[0]);
      if (openRefundClash(row, args[1])) throw uniqueRefund();
      row.status = args[1];
      return 1;
    }
    if (/FROM "ParentRequest"\s+WHERE "userId" = \$1 AND "paymentId" = \$2/.test(sql)) {
      if (state.noPaymentColumn) throw missingColumn();
      return state.requests.filter((r) => r.userId === args[0] && r.paymentId === args[1] && ["PENDING", "CONFIRMED"].includes(r.status));
    }
    if (/INSERT INTO "ParentRequest"/.test(sql)) {
      const [userId, studentId, title, content, paymentId, paymentAmount] = args;
      const linked = /"paymentId", "paymentAmount"\)/.test(sql);
      if (linked) {
        if (state.noPaymentColumn) throw missingColumn();
        // 청구 연결과 중복 확인이 같은 문장 안에 있다
        assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM "ParentRequest" x\s+WHERE x\."userId" = \$1 AND x\."paymentId" = \$5::text AND x\.status IN \('PENDING', 'CONFIRMED'\)\)/);
        const open = state.requests.some((r) => r.userId === userId && r.paymentId === paymentId && ["PENDING", "CONFIRMED"].includes(r.status));
        // raceOnce = «확인할 때는 없었는데 넣는 순간 다른 요청이 먼저 넣었다» → 유일 색인 위반(23505)
        if (state.raceOnce) {
          state.raceOnce = false;
          state.requests.push({ id: "r-race", userId, studentId, type: "OTHER", title, content, status: "PENDING", adminNote: null, createdAt: now(), paymentId, paymentAmount });
          throw Object.assign(new Error('duplicate key value violates unique constraint "ParentRequest_open_refund_key"'), { code: "P2010", meta: { code: "23505" } });
        }
        if (open) return [];
      }
      const row = { id: `r${state.requests.length + 1}`, userId, studentId, type: "OTHER", title, content, status: "PENDING", adminNote: null, createdAt: now(), ...(linked ? { paymentId, paymentAmount } : {}) };
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
  assert.deepEqual(ok, { ok: true, requestId: "r1", title: "김하늘 문의", studentName: "김하늘", notifyAdmins: true });
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
  // 두 번째 답은 덮어쓰지 않고 뒤에 이어 붙는다(코드 리뷰 F1)
  assert.equal((await service.addAdminInquiryReply(db, "admin-1", "r1", "추가 안내")).ok, true);
  assert.equal(db.state.requests[0].adminNote, "답변입니다\n\n추가 안내");
  // 합쳐서 2,000자를 넘으면 거절(앞선 답은 그대로)
  const full = await service.addAdminInquiryReply(db, "admin-1", "r1", "가".repeat(1995));
  assert.equal(full.ok, false);
  assert.match(full.error, /가득 찼습니다/);
  assert.equal(db.state.requests[0].adminNote, "답변입니다\n\n추가 안내");
  assert.deepEqual(rules.appendLegacyAnswer(null, " 첫 답 "), { ok: true, note: "첫 답" });
  assert.equal(rules.appendLegacyAnswer("가".repeat(1000), "나".repeat(998)).ok, true, "딱 2,000자");
  assert.equal(rules.appendLegacyAnswer("가".repeat(1000), "나".repeat(999)).ok, false);
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

  // 학원 답(여기서는 옛 답변) 뒤 첫 글이라 원장 알림이 간다
  db.state.requests[0].adminNote = "옛 답변";
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
  // 열린 환불 문의는 사람·청구당 하나 — 열린 상태 집합은 코드(NOT EXISTS)와 같다
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "ParentRequest_open_refund_key"\s+ON public\."ParentRequest" \("userId", "paymentId"\)\s+WHERE "paymentId" IS NOT NULL AND status IN \('PENDING', 'CONFIRMED'\);/);
  assert.match(sql, /-- DROP INDEX IF EXISTS public\."ParentRequest_open_refund_key";/);
  for (const undo of [/-- DROP TABLE IF EXISTS public\."ParentRequestMessage";/, /-- ALTER TABLE public\."ParentRequest" DROP COLUMN IF EXISTS "paymentId";/, /-- ALTER TABLE public\."ParentRequest" DROP COLUMN IF EXISTS "paymentAmount";/]) assert.match(sql, undo);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/, "실행되는 줄에는 지우는 문이 없다");
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model ParentRequestMessage \{/);
  assert.match(schema, /paymentId\s+String\?/);
});

// ── ⑨ 보안 검수 권장(2026-11-14) ─────────────────────────────────────────────

test("⑨ 연속 글 한도: 학원 답 전 학부모 글 5개까지 · 6번째는 안내(전화) · 학원이 답하면 다시 쓸 수 있다", async () => {
  assert.equal(rules.INQUIRY_PARENT_STREAK_MAX, 5);
  const db = fakeDb({ requests: [baseRequest()] });
  for (let i = 1; i <= 5; i++) assert.equal((await service.addParentInquiryMessage(db, "parent-a", "r1", `글 ${i}`)).ok, true, `${i}번째`);
  const sixth = await service.addParentInquiryMessage(db, "parent-a", "r1", "글 6");
  assert.deepEqual(sixth, { ok: false, error: rules.INQUIRY_WAITING_LIMIT_MESSAGE, waitingLimit: true });
  assert.equal(db.state.messages.length, 5, "6번째는 저장되지 않는다");
  // 남의 문의는 한도 안내가 아니라 «찾을 수 없음»(있는지 없는지를 알려 주지 않는다)
  assert.deepEqual(await service.addParentInquiryMessage(db, "parent-b", "r1", "남의 글"), { ok: false, error: service.INQUIRY_NOT_FOUND });
  await service.addAdminInquiryReply(db, "admin-1", "r1", "답변");
  assert.equal((await service.addParentInquiryMessage(db, "parent-a", "r1", "답 뒤 첫 글")).ok, true);
  // 화면: 한도 안내에 전화 버튼(막다른 곳 금지)
  const form = read("src/app/mypage/requests/[id]/InquiryReplyForm.tsx");
  assert.match(form, /if \(result\.waitingLimit\) setWaitingLimit\(true\);/);
  assert.match(form, /\{waitingLimit && tel && \(\s*<a href=\{`tel:\$\{tel\}`\}/);
  assert.match(read("src/app/mypage/requests/[id]/page.tsx"), /academyPhone=\{await getUsableAcademyPhone\(\)\}/);
});

test("⑨ 원장 알림은 «학원 답 뒤 첫 글»에만 — 연달아 쓴 글에는 만들지 않는다", async () => {
  const n = rules.shouldNotifyAdminsOfFollowUp;
  assert.deepEqual([n(null, null), n(null, " 옛 답변 "), n("ADMIN", null), n("PARENT", "옛 답변")], [false, true, true, false]);

  // 답이 아직 없는 문의: 처음 문의 때 이미 알림이 갔다 → 이어 쓴 글은 알림 없음
  const fresh = fakeDb({ requests: [baseRequest()] });
  const a = loadActions(fresh);
  assert.equal((await a.actions.sendInquiryFollowUp("r1", "추가 1")).ok, true);
  assert.equal(a.sent.adminNotices.length, 0);
  // 학원 답 뒤 첫 글만 알림, 그다음 글은 없음
  await service.addAdminInquiryReply(fresh, "admin-1", "r1", "답변");
  await a.actions.sendInquiryFollowUp("r1", "답 뒤 첫 글");
  assert.equal(a.sent.adminNotices.length, 2, "원장 계정 2개에 한 번씩");
  await a.actions.sendInquiryFollowUp("r1", "답 뒤 둘째 글");
  assert.equal(a.sent.adminNotices.length, 2);
  assert.equal(fresh.state.requests[0].status, "PENDING", "알림이 없어도 요청함 «대기중»에는 다시 뜬다");
  // 한도에 걸리면 알림도 없다
  for (let i = 0; i < 5; i++) await a.actions.sendInquiryFollowUp("r1", `더 ${i}`);
  const blocked = await a.actions.sendInquiryFollowUp("r1", "한도 밖");
  assert.deepEqual([blocked.ok, blocked.waitingLimit], [false, true]);
  assert.equal(a.sent.adminNotices.length, 2);
});

test("⑨ 환불 문의 중복: 동시에 두 번 눌러 유일 색인에 걸리면 먼저 만들어진 문의로 안내 · 조회 실패를 삼켜 새로 만들지 않는다", async () => {
  const db = fakeDb({ payments: [paidBill()] });
  db.state.raceOnce = true;
  const raced = await service.createRefundInquiry(db, "parent-a", "pay-1", "");
  assert.deepEqual([raced.ok, raced.existing, raced.requestId], [true, true, "r-race"]);
  assert.equal(db.state.requests.length, 1, "두 번째 문의는 만들어지지 않았다");
  assert.equal(service.isUniqueViolation(Object.assign(new Error("x"), { meta: { code: "23505" } })), true);
  assert.equal(service.isUniqueViolation(new Error("relation does not exist")), false);
  // 종결된 뒤에는 다시 문의할 수 있다
  db.state.requests[0].status = "COMPLETED";
  const again = await service.createRefundInquiry(db, "parent-a", "pay-1", "");
  assert.deepEqual([again.ok, again.existing], [true, false]);
  const source = read("src/lib/requests/inquiry-thread.ts");
  assert.doesNotMatch(source, /UPDATE "ParentRequest" SET "paymentId"/, "만든 뒤 따로 연결하지 않는다(한 문장)");
  // 환불 문의 만들기 안에서만 본다(이어 쓰기의 «열린 다른 문의 안내용» 조회는 실패해도 안내만 빠진다)
  assert.doesNotMatch(source.slice(source.indexOf("export async function createRefundInquiry")), /status IN \('PENDING', 'CONFIRMED'\)[\s\S]{0,160}\.catch\(\(\) => \[\]/, "조회 실패를 빈 목록으로 삼키지 않는다");
});

test("⑨ 환불 사유 길이는 문의 글과 같은 함수로(빈 값만 허용)", async () => {
  assert.deepEqual(rules.cleanInquiryBody("  ", { allowEmpty: true }), { ok: true, body: "" });
  assert.equal(rules.cleanInquiryBody("가".repeat(2001), { allowEmpty: true }).ok, false);
  assert.equal(rules.cleanInquiryBody("").ok, false, "기본은 빈 글 거절 그대로");
  const db = fakeDb({ payments: [paidBill()] });
  assert.equal((await service.createRefundInquiry(db, "parent-a", "pay-1", "가".repeat(2001))).ok, false);
  assert.equal(db.state.requests.length, 0);
  assert.match(read("src/lib/requests/inquiry-thread.ts"), /cleanInquiryBody\(rawReason, \{ allowEmpty: true \}\)/);
});

test("⑨ 새 문의 하루(KST) 20건 상한: 넣는 문장 안에서 센다", () => {
  assert.equal(rules.INQUIRY_DAILY_NEW_MAX, 20);
  const admin = read("src/app/actions/admin.ts");
  const body = admin.slice(admin.indexOf("export async function createParentRequest"), admin.indexOf("export async function updateRequestStatus"));
  assert.match(body, /SELECT gen_random_uuid\(\)::text, \$1, \$2, \$3, \$4, \$5, \$6::timestamptz, 'PENDING', NOW\(\), NOW\(\)\s+WHERE \(SELECT COUNT\(\*\) FROM "ParentRequest" d\s+WHERE d\."userId" = \$1\s+AND \(d\."createdAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date\) < \$7/);
  assert.match(body, /requestedDate, INQUIRY_DAILY_NEW_MAX,/);
  assert.match(body, /if \(insertedCount === 0\) throw new Error\("오늘은 문의를 더 보낼 수 없어요/);
  // 권한 확인(내 아이)·허용 유형은 그대로
  assert.match(body, /childAccessWhere\(parent\.appUserId\)/);
  assert.match(body, /allowedTypes = new Set\(\["ABSENCE", "SHUTTLE", "EARLY_LEAVE", "OTHER"\]\)/);
});

// ── ⑩ 코드 리뷰 권장(2026-11-14) ─────────────────────────────────────────────

test("⑩ F2 상태만 바꿀 때 가는 학부모 알림도 그 문의 대화로(«보낸 문의»)", () => {
  const admin = read("src/app/actions/admin.ts");
  const body = admin.slice(admin.indexOf("export async function updateRequestStatus"), admin.indexOf("export async function getParentRequestStatusForAdmin"));
  assert.match(body, /'메시지 상담 상태 안내', \$2, \$3, false, NOW\(\)\)/);
  assert.match(body, /`\/mypage\/requests\/\$\{id\}`,\s*\);/);
  assert.match(body, /보낸 문의에서 확인해 주세요\.", url: `\/mypage\/requests\/\$\{id\}`, tag: "REQUEST"/);
  assert.doesNotMatch(body, /보낸 메시지|'\/mypage'|url: "\/mypage"/);
});

test("⑩ F3 홈 «답변 옴 N건»: 최근 7일 안에 답이 달린 문의만", async () => {
  const now = Date.parse("2026-11-20T03:00:00Z");
  const c = rules.countRecentAnswered;
  assert.equal(c([
    { status: "ANSWERED", answeredAt: "2026-11-19T00:00:00.000Z" },
    { status: "ANSWERED", answeredAt: "2026-11-13T03:00:00.000Z" }, // 딱 7일 전 = 포함
    { status: "ANSWERED", answeredAt: "2026-11-13T02:59:59.000Z" }, // 7일 넘음
    { status: "ANSWERED", answeredAt: null },
    { status: "ANSWERED", answeredAt: "엉뚱한 값" },
    { status: "WAITING", answeredAt: "2026-11-19T00:00:00.000Z" },
    { status: "DONE", answeredAt: "2026-11-19T00:00:00.000Z" },
  ], now), 2);
  // 목록이 «마지막 글이 학원 답일 때 그 시각»을 준다 · 옛 답변만 있으면 문의가 마지막으로 바뀐 시각
  const db = fakeDb({ requests: [
    baseRequest({ id: "r1" }),
    baseRequest({ id: "r2", adminNote: "옛 답변", updatedAt: new Date("2026-11-12T00:00:00Z") }),
    baseRequest({ id: "r3" }),
  ] });
  await service.addAdminInquiryReply(db, "admin-1", "r1", "답");
  await service.addAdminInquiryReply(db, "admin-1", "r3", "답");
  await service.addParentInquiryMessage(db, "parent-a", "r3", "다시 여쭤요");
  const rows = Object.fromEntries((await service.listMyInquiries(db, "parent-a")).map((row) => [row.id, row]));
  assert.match(rows.r1.answeredAt, /^2026-11-20T/);
  assert.equal(rows.r2.answeredAt, "2026-11-12T00:00:00.000Z");
  assert.equal(rows.r3.answeredAt, null, "내가 마지막으로 썼으면 답변 대기");
  assert.match(read("src/app/mypage/page.tsx"), /answered: countRecentAnswered\(myInquiries, Date\.now\(\)\)/);
  // 안 쓰게 된 옛 함수는 지웠다
  assert.doesNotMatch(read("src/lib/queries.ts"), /getMyRequests/);
  assert.doesNotMatch(read("src/lib/mypage/summary.ts"), /countRecentAnswers/);
});

test("⑩ F4 신청 내역의 «학원 답변» = 마지막 학원 글 · 문의는 «대화 보기 ▸»", async () => {
  const db = fakeDb({ requests: [baseRequest({ adminNote: "옛 답변" }), baseRequest({ id: "r2", adminNote: "옛 답변만" })] });
  await service.addAdminInquiryReply(db, "admin-1", "r1", "첫 답");
  await service.addParentInquiryMessage(db, "parent-a", "r1", "추가 글");
  await service.addAdminInquiryReply(db, "admin-1", "r1", "마지막 답");
  const last = await service.lastAdminAnswers(db, ["r1", "r2"]);
  assert.equal(last.get("r1"), "마지막 답");
  assert.equal(last.has("r2"), false, "이어 쓴 학원 글이 없으면 옛 답변 칸을 쓴다");
  const timeline = read("src/lib/requests/parent-timeline.ts");
  assert.match(timeline, /lastAdminAnswers\(prisma, inquiries\.map\(\(r\) => r\.id\)\)\.catch/);
  assert.match(timeline, /answer: lastAnswers\.get\(r\.id\) \?\? r\.adminNote \?\? null, openHref: `\/mypage\/requests\/\$\{r\.id\}`/);
  assert.match(read("src/app/mypage/classes/RequestTimeline.tsx"), /row\.kind === "PARENT_REQUEST" \? "대화 보기 ▸" : "신청 화면에서 보기"/);
});

test("⑩ F6 열린 환불 문의가 있으면 새 사유를 그 문의에 덧붙인다", async () => {
  const db = fakeDb({ payments: [paidBill()] });
  const { actions, sent } = loadActions(db);
  const first = await actions.sendRefundInquiry("pay-1", "이사 갑니다");
  const second = await actions.sendRefundInquiry("pay-1", "계좌는 국민 123 입니다");
  assert.deepEqual([second.ok, second.requestId, second.notice], [true, first.requestId, "이미 보낸 환불 문의에 덧붙였어요"]);
  assert.equal(db.state.requests.length, 1);
  assert.deepEqual(db.state.messages.map((m) => [m.requestId, m.authorRole, m.body]), [[first.requestId, "PARENT", "계좌는 국민 123 입니다"]]);
  assert.equal(sent.adminNotices.length, 2, "학원 답 전이라 덧붙인 글에는 알림을 더 만들지 않는다(접수 알림 2건뿐)");
  // 사유 없이 다시 누르면 덧붙이지 않는다
  const third = await actions.sendRefundInquiry("pay-1", "  ");
  assert.equal(third.notice, "이미 보낸 환불 문의가 있어요.");
  assert.equal(db.state.messages.length, 1);
});

test("⑩ F7·F8 목록 날짜 칸 폭 · 계좌 안내 링크는 실제 문의 폼으로", () => {
  assert.match(read("src/app/mypage/requests/page.tsx"), /<span className="w-14 shrink-0 whitespace-nowrap text-sm tabular-nums/);
  // 링크 목적지(/mypage#parent-request-form)를 홈이 받아 폼을 편다
  assert.match(read("src/app/mypage/payments/PaymentRequestClient.tsx"), /입금 계좌는 <Link href="\/mypage#parent-request-form"/);
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /if \(id === "parent-request-form"\) setShowRequestForm\(true\);/);
  assert.match(home, /<div id="parent-request-form"/);
});

// ── ⑪ 재검수 권장: 열린 환불 문의 유일 제약에 걸렸을 때 ───────────────────────────

const twoRefunds = () => fakeDb({ requests: [
  baseRequest({ id: "old", title: "환불 문의 · 옛 건", status: "COMPLETED", paymentId: "pay-1", paymentAmount: 72000 }),
  baseRequest({ id: "open", title: "환불 문의 · 열린 건", status: "PENDING", paymentId: "pay-1", paymentAmount: 72000 }),
] });

test("⑪ 종결된 환불 문의에 이어 쓰면: 글은 남고, 열려 있는 다른 환불 문의를 알려 준다", async () => {
  const db = twoRefunds();
  const result = await service.addParentInquiryMessage(db, "parent-a", "old", "한 가지 더 여쭤요");
  assert.equal(result.ok, true);
  assert.equal(result.openRefundRequestId, "open");
  assert.deepEqual(db.state.messages.map((m) => [m.requestId, m.body]), [["old", "한 가지 더 여쭤요"]], "쓴 글은 버리지 않는다");
  assert.equal(db.state.requests[0].status, "COMPLETED", "다시 열리지는 않는다");
  // 서버 동작이 그 id 를 화면까지 넘기고, 화면은 안내 + 그 문의로 가는 링크를 보인다
  const again = await loadActions(db).actions.sendInquiryFollowUp("old", "또 한 가지");
  assert.deepEqual([again.ok, again.openRefundRequestId], [true, "open"]);
  const form = read("src/app/mypage/requests/[id]/InquiryReplyForm.tsx");
  assert.match(form, /setOpenRefundId\(result\.openRefundRequestId \?\? null\);/);
  assert.match(form, /\{OPEN_REFUND_EXISTS_PARENT\}\{" "\}\s*<Link href=\{`\/mypage\/requests\/\$\{openRefundId\}`\}/);
  assert.equal(rules.OPEN_REFUND_EXISTS_PARENT, "이 청구에는 열려 있는 환불 문의가 따로 있어요");
  // 겹치지 않는 보통 문의는 그대로(안내 없음)
  const plain = fakeDb({ requests: [baseRequest({ status: "COMPLETED" })] });
  assert.equal((await service.addParentInquiryMessage(plain, "parent-a", "r1", "추가")).openRefundRequestId, undefined);
});

test("⑪ 관리자 답 + 상태: 유일 제약에 걸리면 답은 저장하고 «상태는 바뀌지 않았습니다»를 화면까지 돌려준다", async () => {
  const db = twoRefunds();
  const result = await service.addAdminInquiryReply(db, "admin-1", "old", "다시 확인해 보겠습니다", "PENDING");
  assert.deepEqual([result.ok, result.status, result.statusNote], [true, "COMPLETED", rules.REPLY_SAVED_STATUS_KEPT]);
  assert.match(result.statusNote, /답은 저장했고 상태는 바뀌지 않았습니다\(같은 청구에 열린 환불 문의가 있음\)/);
  assert.equal(db.state.messages.length, 1, "답은 저장됐다");
  const viaAction = await loadActions(db).actions.replyToParentRequest("old", "한 번 더 안내", "CONFIRMED");
  assert.deepEqual([viaAction.saved, viaAction.status, viaAction.note], [true, "COMPLETED", rules.REPLY_SAVED_STATUS_KEPT]);
  assert.equal(db.state.notifications.length, 1, "답 1건 = 학부모 알림 1건은 그대로");
  // 상태를 고르지 않은 답(종결 상태 유지)은 걸리지 않는다
  assert.equal((await service.addAdminInquiryReply(db, "admin-1", "old", "참고 안내")).statusNote, undefined);
  // 요청함·신청함이 그 글을 보인다
  assert.match(read("src/app/admin/requests/RequestsAdminClient.tsx"), /setFeedback\(result\.note \? `\$\{result\.note\} \$\{saved\}` : saved\);/);
  assert.match(read("src/app/admin/inbox/InboxClient.tsx"), /text: partial \|\| `\$\{row\.studentName \?\? row\.title\} · \$\{action\.label\} 처리했습니다\.` \}/);
  assert.match(read("src/app/admin/requests/RequestsAdminClient.tsx"), /if \(!result\.saved && "error" in result && result\.error\) \{\s*setFeedback\(result\.error\);/);
});

test("⑪ 하루 새 문의 상한 주석이 실제 동작과 같다: 환불 문의는 건수에 세어지지만 막지는 않는다", () => {
  const source = read("src/lib/requests/inquiryThreadRules.ts");
  assert.match(source, /환불 문의도 같은 표에 쌓여 이 «건수»에는 세어지지만, 환불 문의 자체는 이 상한으로 막지 않는다/);
  // 실제 동작: 상한은 홈 문의 폼(createParentRequest)에만 있고, 환불 문의 서버 함수에는 없다
  assert.doesNotMatch(read("src/lib/requests/inquiry-thread.ts"), /INQUIRY_DAILY_NEW_MAX/);
  assert.match(read("src/app/actions/admin.ts"), /requestedDate, INQUIRY_DAILY_NEW_MAX,/);
});

// ── ⑧ 청구 화면의 «환불 문의»(c11) ──────────────────────────────────────────────

test("⑧ 청구 세부 시트: 납부 완료 항목에만 «환불 문의» · 결제·입금 알림·영수증 흐름은 그대로", () => {
  const Link = ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children);
  const Client = load("src/app/mypage/payments/PaymentRequestClient.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { useRouter: () => ({ refresh() {}, push() {} }) },
    "@/app/actions/parent-inquiry": { sendRefundInquiry: async () => ({ ok: true, requestId: "r1" }) },
  }).default;
  const row = (id, extra = {}) => ({
    paymentId: id, studentId: "s1", studentName: "김하늘", description: null, amount: 72000, status: "PENDING", type: "TUITION",
    year: 2026, month: 11, method: null, paidProvider: null, dueDate: "2026-11-10", paidDate: null, invoiceNo: null, invoiceId: `inv-${id}`,
    canCheckout: true, receiptUrl: null, virtualAccount: null, pending: [], resolved: [], ...extra,
  });
  const render = (rows) => renderToStaticMarkup(React.createElement(Client, { payReady: true, initialOpenYm: "2026-11", rows }));

  const paid = render([row("p1", { status: "PAID", paidDate: "2026-11-05" })]);
  assert.match(paid, /<button type="button" aria-expanded="false"[^>]*>환불 문의<\/button>/);
  assert.match(paid, />영수증 요청<\/button>/, "영수증 요청은 그대로");
  const unpaid = render([row("p2")]);
  assert.doesNotMatch(unpaid, /환불 문의/, "미납 청구에는 없다");
  assert.match(unpaid, /href="\/payments\/inv-p2"[^>]*>결제하기/, "결제하기는 그대로");
  assert.doesNotMatch(render([row("p3", { status: "REFUNDED" })]), /환불 문의/, "이미 환불된 청구에는 없다");

  const source = read("src/app/mypage/payments/PaymentRequestClient.tsx");
  assert.match(source, /await sendRefundInquiry\(paymentId, refundReason\)/);
  assert.match(source, /href=\{`\/mypage\/requests\/\$\{refundSent\[row\.paymentId\]\.id\}`\}/, "보낸 뒤 그 문의 대화로");
  assert.match(source, /\{refundSent\[row\.paymentId\]\.notice \?\? "환불 문의를 보냈어요\."\}/, "이미 열린 문의가 있었으면 그 안내를 보인다");
  // 결제 동작은 건드리지 않았다(같은 주소·같은 요청 몸통)
  assert.match(source, /href=\{`\/payments\/\$\{encodeURIComponent\(row\.invoiceId!\)\}`\}/);
  assert.match(source, /send\(\{ paymentId, kind: "PAYMENT_CLAIM", method, paidOn, depositorName, note \}\)/);
  assert.match(source, /send\(\{ paymentId, kind: "RECEIPT", receiptType, receiptTarget, note \}\)/);
  assert.match(source, /fetch\("\/api\/mypage\/payment-request"/);
  // 막다른 문구 정리: 계좌를 모를 때 «학원에 문의해 주세요» 대신 문의 폼으로
  assert.doesNotMatch(source, /학원에 문의해 주세요/);
  assert.match(source, /입금 계좌는 <Link href="\/mypage#parent-request-form"/);
});
