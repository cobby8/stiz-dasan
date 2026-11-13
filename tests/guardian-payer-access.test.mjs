// f8(2026-11-13) — 두 번째 보호자 결제 + 형제 간편 연결.
// 1) 결제 권한 판정(payerAccess.ts)을 실제로 실행한다 — 진짜 childAccessSql(가족 연결 표 켜짐)이 만든 SQL 을 받는 가짜 DB 로.
// 2) 형제 매칭 규칙(sibling-link-rules.ts)을 실제로 실행한다 — 같은 번호만, 다른 번호 제외, 남의 계정 아이는 승인 요청.
// 3) 서버 경로가 같은 판정을 쓰는지 소스 계약으로 못박는다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// ───────────────────────────── 모듈 로더(prisma 만 가짜) ─────────────────────────────
const FAKE_MODULES = {
    "@/lib/prisma": "export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__payerFake[key] });",
};
const loaded = new Map();
async function readTs(base) {
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        try {
            const p = `${base}${ext}`;
            return { path: p.replace(/\\/g, "/"), code: await readFile(p, "utf8") };
        } catch { /* 다음 */ }
    }
    throw new Error(`모듈 없음: ${base}`);
}
async function moduleUrl(file) {
    const key = file.replace(/\\/g, "/");
    if (loaded.has(key)) return loaded.get(key);
    const { path: resolved, code } = await readTs(file);
    let out = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const specs = [...out.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of new Set(specs)) {
        let url = null;
        if (FAKE_MODULES[spec]) url = `data:text/javascript;base64,${Buffer.from(FAKE_MODULES[spec]).toString("base64")}`;
        else if (spec.startsWith("@/")) url = await moduleUrl(path.join("src", spec.slice(2)));
        else if (spec.startsWith(".")) url = await moduleUrl(path.join(path.dirname(resolved), spec));
        if (url) out = out.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`);
    }
    const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
    loaded.set(key, url);
    return url;
}

// 가족 연결 표가 «준비됨»으로 보이게(childConnectionsAvailable 이 읽는 값)
process.env.CHILD_CONNECTIONS_ENABLED = "true";
globalThis.__payerFake = { async $queryRawUnsafe(sql) { if (/AS ready/.test(sql)) return [{ ready: true }]; return []; } };
const payer = await import(await moduleUrl("src/lib/payments/payerAccess.ts"));
const siblings = await loadTsModule("src/lib/account/sibling-link-rules.ts");

// ───────────────────────────── 1. 결제 권한 판정 ─────────────────────────────

/** 가상의 학원: 학생 2명(형제), 엄마(대표)·아빠(승인된 가족)·삼촌(연결 해제)·이웃(승인 대기만)·탈퇴 계정 */
function world() {
    return {
        users: [
            { id: "mom", authUserId: "auth-mom", withdrawnAt: null, name: "엄마", email: "mom@x", phone: "01011112222" },
            { id: "dad", authUserId: "auth-dad", withdrawnAt: null, name: "아빠", email: "dad@x", phone: "01033334444" },
            { id: "uncle", authUserId: "auth-uncle", withdrawnAt: null, name: "삼촌", email: "uncle@x", phone: null },
            { id: "neighbor", authUserId: "auth-nb", withdrawnAt: null, name: "이웃", email: "nb@x", phone: null },
            { id: "gone", authUserId: "auth-gone", withdrawnAt: "2026-11-01", name: "탈퇴", email: "gone@x", phone: null },
            { id: "legacy", authUserId: null, withdrawnAt: null, name: "옛 계정", email: "old@x", phone: null },
        ],
        students: [{ id: "kid-1", parentId: "mom" }, { id: "kid-2", parentId: "mom" }, { id: "kid-3", parentId: "legacy" }],
        access: [
            { studentId: "kid-1", userId: "dad", status: "ACTIVE" },
            { studentId: "kid-2", userId: "dad", status: "ACTIVE" },
            { studentId: "kid-1", userId: "uncle", status: "REVOKED" },
            { studentId: "kid-1", userId: "gone", status: "ACTIVE" },
        ],
        // 승인 대기 요청은 ParentStudentAccess 가 아니다 — 결제 권한을 주지 않는다
        pendingRequests: [{ studentId: "kid-1", requesterId: "neighbor", status: "PENDING" }],
    };
}

/** resolveLinkedPayer 가 보내는 SQL 을 «의미대로» 계산하는 가짜 DB. 받은 SQL 이 그 의미를 담고 있는지도 검사한다. */
function payerDb(w) {
    const seen = [];
    return {
        seen,
        async $queryRawUnsafe(sql, authUserId, studentIds) {
            seen.push(sql);
            assert.match(sql, /u\."authUserId" = \$1 OR \(u\."authUserId" IS NULL AND u\.id = \$1\)/, "로그인 sub(옛 로그인은 id)로만 찾는다");
            assert.match(sql, /u\."withdrawnAt" IS NULL/, "탈퇴 계정 제외");
            assert.match(sql, /s\."parentId" = u\."id"/, "주 보호자");
            assert.match(sql, /child_access\.status = 'ACTIVE'/, "가족 연결은 ACTIVE 만(해제·대기 불가)");
            assert.match(sql, /child_actor\."withdrawnAt" IS NULL/);
            assert.doesNotMatch(sql, /ChildLinkRequest/, "승인 대기 요청은 권한 근거가 아니다");
            const rows = [];
            for (const u of w.users) {
                if (!(u.authUserId === authUserId || (u.authUserId === null && u.id === authUserId)) || u.withdrawnAt) continue;
                const linked = w.students.filter((s) => studentIds.includes(s.id) && (s.parentId === u.id
                    || w.access.some((a) => a.studentId === s.id && a.userId === u.id && a.status === "ACTIVE")));
                const base = { id: u.id, name: u.name, email: u.email, phone: u.phone };
                if (linked.length === 0) rows.push({ ...base, studentId: null });
                for (const s of linked) rows.push({ ...base, studentId: s.id });
            }
            return rows;
        },
    };
}

test("결제 권한: 대표 보호자 허용", async () => {
    const db = payerDb(world());
    const found = await payer.resolveLinkedPayer(db, "auth-mom", ["kid-1"]);
    assert.equal(found?.id, "mom");
});

test("결제 권한: 가족 승인으로 연결된 두 번째 보호자도 허용(형제 둘 묶음도)", async () => {
    const db = payerDb(world());
    assert.equal((await payer.resolveLinkedPayer(db, "auth-dad", ["kid-1"]))?.id, "dad");
    const both = await payer.resolveLinkedPayer(db, "auth-dad", ["kid-1", "kid-2", "kid-1"]);
    assert.deepEqual(both, { id: "dad", name: "아빠", email: "dad@x", phone: "01033334444" }, "결제창 고객 정보 = 결제하는 사람");
});

test("결제 권한: 연결 안 된 학생은 거부(IDOR) — 묶음에 하나라도 섞이면 통째로 거부", async () => {
    const db = payerDb(world());
    assert.equal(await payer.resolveLinkedPayer(db, "auth-dad", ["kid-3"]), null);
    assert.equal(await payer.resolveLinkedPayer(db, "auth-dad", ["kid-1", "kid-3"]), null);
    assert.equal(await payer.resolveLinkedPayer(db, "auth-nobody", ["kid-1"]), null, "모르는 로그인");
});

test("결제 권한: 해제된 연결·승인 대기·탈퇴 계정은 거부", async () => {
    const db = payerDb(world());
    assert.equal(await payer.resolveLinkedPayer(db, "auth-uncle", ["kid-1"]), null, "REVOKED");
    assert.equal(await payer.resolveLinkedPayer(db, "auth-nb", ["kid-1"]), null, "승인 대기(PENDING 요청)만 있음");
    assert.equal(await payer.resolveLinkedPayer(db, "auth-gone", ["kid-1"]), null, "탈퇴");
});

test("결제 권한: 빈 학생 목록·빈 로그인은 DB 를 부르지 않고 거부", async () => {
    const db = payerDb(world());
    assert.equal(await payer.resolveLinkedPayer(db, "auth-mom", []), null);
    assert.equal(await payer.resolveLinkedPayer(db, "", ["kid-1"]), null);
    assert.equal(db.seen.length, 0);
});

test("결제 권한(순수): 같은 로그인 줄 중 학생 전부와 연결된 계정만 고른다", () => {
    const rows = [
        { id: "b", name: null, email: null, phone: null, studentId: "kid-1" },
        { id: "a", name: null, email: null, phone: null, studentId: null },
    ];
    assert.equal(payer.pickLinkedPayer(rows, ["kid-1"])?.id, "b");
    assert.equal(payer.pickLinkedPayer(rows, ["kid-1", "kid-2"]), null);
    assert.equal(payer.pickLinkedPayer(rows, []), null);
});

// ───────────────────────────── 2. 형제 간편 연결 규칙 ─────────────────────────────

const VERIFIED = "01055556666"; // 본인인증한 번호(숫자만)
const VERIFIED_NAME = "김아빠";    // 본인인증한 이름
const matches = (digits) => digits === VERIFIED;
const ACTOR = "dad";
const plan = (rows) => siblings.buildSiblingPlan(rows, ACTOR, matches, VERIFIED_NAME);
function kid(over = {}) {
    return {
        studentId: "kid-1", studentName: "김하나", className: "초등 A반",
        primaryId: "mom", primaryName: "이엄마", primaryRole: "PARENT", primaryAuthUserId: "auth-mom", primaryEmail: "mom@x", primaryPhone: "010-1111-2222",
        primaryCanApprove: true, guardians: [{ name: "김 아빠", phone: "010-5555-6666" }], alreadyLinked: false, pendingRequest: false, ...over,
    };
}
// 학원이 만든 빈 계정(로그인 없음·합성 이메일)이 주 보호자 — 이름·번호가 본인인증과 같다
const PLACEHOLDER = { primaryId: "ph", primaryName: "김아빠", primaryAuthUserId: null, primaryEmail: "parent_01055556666@stiz.local",
    primaryPhone: "010-5555-6666", primaryCanApprove: false, guardians: [] };

test("형제 매칭: 같은 보호자 기록 안에서 번호+이름이 모두 같아야 한다(하이픈·+82·띄어쓰기 정리), 다른 번호는 제외", () => {
    const rows = [
        kid({ studentId: "k1", studentName: "가", guardians: [{ name: "김아빠", phone: "010-5555-6666" }] }),
        kid({ studentId: "k2", studentName: "나", guardians: [{ name: " 김 아빠 ", phone: "+82 10-5555-6666" }] }),
        kid({ studentId: "k3", studentName: "다", guardians: [{ name: "김아빠", phone: "010-5555-6667" }] }), // 끝자리 다름
        kid({ studentId: "k4", studentName: "라", guardians: [{ name: "김아빠", phone: null }, { name: null, phone: "" }] }),
        kid({ studentId: "k5", studentName: "마", guardians: [], primaryPhone: "01055556666", primaryName: "김아빠" }), // 주 보호자 계정 기록
    ];
    assert.deepEqual(plan(rows).map((p) => p.studentId).sort(), ["k1", "k2", "k5"]);
    // 자리채움 번호로 엉뚱한 아이가 맞지 않는다
    assert.equal(siblings.samePhone("010-0000-0000", () => true), false);
    assert.equal(siblings.samePhone("", () => true), false);
    assert.deepEqual(siblings.buildSiblingPlan(rows, ACTOR, matches, "  "), [], "인증 이름이 비면 아무것도 제안하지 않는다");
});

test("형제 보안(HIGH): 번호만 같고 이름이 다르면 바로 연결·승인 요청 모두 안 하고, 목록에 이름·반도 내보내지 않는다", () => {
    // 번호 재할당·학원 오입력·조부모 번호 — 빈 계정이 주 보호자여도 이름이 다르면 남의 아이일 수 있다
    const reassigned = kid({ ...PLACEHOLDER, studentName: "남의아이", className: "중등 B반", primaryName: "박할머니" });
    assert.deepEqual(plan([reassigned]), []);
    // 다른 계정이 주 보호자, 보호자 기록 번호는 같지만 이름이 다름 → 승인 요청도 보내지 않는다
    const otherGuardian = kid({ studentName: "남의아이2", guardians: [{ name: "박할머니", phone: "010-5555-6666" }] });
    assert.deepEqual(plan([otherGuardian]), []);
    // 번호와 이름이 «서로 다른 기록»에서 하나씩 맞는 것도 불인정(같은 기록 안에서 둘 다)
    const split = kid({ primaryName: "김아빠", primaryPhone: "010-1111-2222", guardians: [{ name: "박할머니", phone: "010-5555-6666" }] });
    assert.deepEqual(plan([split]), []);
    // 화면 응답에도 흔적이 없다(이름·반·개수)
    const pub = siblings.toPublicSiblings(plan([reassigned, otherGuardian, split]));
    assert.deepEqual(pub, []);
    assert.doesNotMatch(JSON.stringify(pub), /남의아이|중등 B반/);
});

test("형제 보안(HIGH): 같은 번호·이름이 서로 다른 대표 계정 여러 곳에 걸리면 바로 연결을 전부 막는다", () => {
    const familyA = kid({ ...PLACEHOLDER, studentId: "a1", studentName: "가" });
    const familyB = kid({ ...PLACEHOLDER, primaryId: "ph-2", studentId: "b1", studentName: "나" });
    const items = plan([familyA, familyB]);
    assert.deepEqual(items.map((p) => p.action), ["ASK_ACADEMY", "ASK_ACADEMY"]);
    assert.equal(siblings.hasSiblingWork(items), false);
    // 같은 대표 계정의 형제 둘이면 둘 다 바로 연결
    const sameFamily = plan([familyA, kid({ ...PLACEHOLDER, studentId: "a2", studentName: "다" })]);
    assert.deepEqual(sameFamily.map((p) => p.action), ["LINK", "LINK"]);
    assert.equal(siblings.isSingleFamily(["x", "x"]), true);
    assert.equal(siblings.isSingleFamily(["x", "y"]), false);
    assert.equal(siblings.isSingleFamily([]), false);
});

test("형제 처리: 정상 형제(빈 계정 주 보호자·번호+이름 일치)는 바로 연결, 다른 사람이 쓰는 계정이면 가족 승인 요청", () => {
    assert.equal(plan([kid(PLACEHOLDER)])[0].action, "LINK");
    const [item] = plan([kid()]);
    assert.equal(item.action, "REQUEST_APPROVAL");
    assert.equal(item.approverId, "mom", "승인자 = 주 보호자 계정");
    // 빈 계정인데 번호가 다르면(다른 보호자가 주 보호자) 바로 연결하지 않는다 — 승인해 줄 사람도 없어 학원 문의
    const otherPlaceholder = { ...PLACEHOLDER, primaryName: "이엄마", primaryEmail: "parent_01011112222@stiz.local", primaryPhone: "010-1111-2222",
        guardians: [{ name: "김아빠", phone: "010-5555-6666" }] };
    assert.equal(plan([kid(otherPlaceholder)])[0].action, "ASK_ACADEMY");
    // 해제된 적 있는 연결은 «바로 연결»로 되살리지 않는다
    assert.equal(plan([kid({ ...PLACEHOLDER, revokedAccess: true })])[0].action, "ASK_ACADEMY");
    // 로그인하는 실제 계정은 번호·이름이 같아도 바로 연결하지 않는다(그 계정의 승인)
    assert.equal(plan([kid({ primaryId: "other", primaryName: "김아빠", primaryPhone: "010-5555-6666", primaryEmail: "other@x" })])[0].action, "REQUEST_APPROVAL");
});

test("형제 처리: 이미 연결·승인 대기·승인 불가 계정", () => {
    assert.equal(plan([kid({ alreadyLinked: true })])[0].action, "ALREADY_LINKED");
    assert.equal(plan([kid({ primaryId: ACTOR })])[0].action, "ALREADY_LINKED");
    assert.equal(plan([kid({ pendingRequest: true })])[0].action, "PENDING");
    assert.equal(plan([kid({ primaryCanApprove: false })])[0].action, "ASK_ACADEMY");
    assert.equal(siblings.hasSiblingWork([{ action: "ALREADY_LINKED" }, { action: "PENDING" }, { action: "ASK_ACADEMY" }]), false);
    assert.equal(siblings.hasSiblingWork([{ action: "ASK_ACADEMY" }, { action: "LINK" }]), true);
});

test("형제 제안: 화면에는 이름·반·처리 방법만 — 학생 id·승인자·번호를 내보내지 않는다, 같은 아이는 한 번", () => {
    const items = plan([kid({ studentId: "k1", studentName: "나" }), kid({ studentId: "k1", studentName: "나" }), kid({ studentId: "k2", studentName: "가", className: null })]);
    assert.equal(items.length, 2);
    const pub = siblings.toPublicSiblings(items);
    assert.deepEqual(pub, [
        { name: "가", className: null, action: "REQUEST_APPROVAL" },
        { name: "나", className: "초등 A반", action: "REQUEST_APPROVAL" },
    ]);
    for (const item of pub) assert.deepEqual(Object.keys(item).sort(), ["action", "className", "name"]);
});

// ───────────────────────────── 3. 소스 계약 — 같은 판정을 모든 경로가 쓴다 ─────────────────────────────

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ledgerSrc = read("src/lib/payment-ledger.ts");
const linksSrc = read("src/lib/account/child-links.ts");
const routeSrc = read("src/app/api/account/child-links/route.ts");

test("계약: 결제 시작·승인 직전·묶음 후보·화면 버튼이 payerAccess 한 곳을 쓴다", () => {
    assert.match(ledgerSrc, /import \{ payerAccessSql, resolveLinkedPayer \} from "@\/lib\/payments\/payerAccess";/);
    assert.match(ledgerSrc, /const payer = await resolveLinkedPayer\(prisma, owner\.authUserId, \[row\.studentId\]\);/, "청구서 조회·단건 결제 시작");
    assert.match(ledgerSrc, /const confirmPayer = await resolveLinkedPayer\(/, "토스 승인 직전");
    assert.match(ledgerSrc, /confirmPayer\.id !== tx\.parentId/, "주문을 만든 사람만 승인");
    assert.match(ledgerSrc, /\(\$\{await payerAccessSql\("s", "\$1"\)\}\) AS "isPayer"/, "묶음 후보");
    assert.match(read("src/lib/queries.ts"), /\(\$\{await payerAccessSql\("s", "\$1"\)\}\) AS "canPay"/, "마이페이지 홈");
    assert.doesNotMatch(read("src/lib/queries.ts"), /canCheckout: s\.parentId === parent\.id/);
    // 승인 직전 재확인은 «이미 승인된 주문 복구»보다 뒤 — 돈이 나간 주문은 장부 반영을 막지 않는다
    const confirm = ledgerSrc.slice(ledgerSrc.indexOf("export async function confirmTossPayment("));
    assert.ok(confirm.indexOf("if (storedApproval) return finalizeApprovedTossPayment") < confirm.indexOf("const confirmPayer"));
    assert.ok(confirm.indexOf("const confirmPayer") < confirm.indexOf("claimTossConfirmInTx"), "토스 승인 전에 확인");
});

test("계약: 형제 «모두 연결»은 화면이 보낸 학생 id 를 받지 않고 서버가 다시 계산, 주 보호자는 바꾸지 않는다", () => {
    const linkAll = linksSrc.slice(linksSrc.indexOf("export async function linkAllSiblings("));
    assert.match(linkAll, /buildSiblingPlan\(await loadSiblingRows\(tx,/);
    assert.match(linkAll, /readSiblingProof\(tx, actor, sessionHash, true\)/, "본인인증 증명을 잠그고");
    assert.match(linkAll, /"proofUsedAt"=NOW\(\)/, "끝에 증명을 소모");
    assert.match(linkAll, /grant\(tx, item\.studentId, actor\.id, "REGISTERED_CONTACT", null\)/);
    assert.doesNotMatch(linkAll, /UPDATE "Student"/, "주 보호자(Student.parentId) 변경 금지");
    assert.match(routeSrc, /linkAllSiblings\(current,sessionHash,body\.relation\)/, "학생 id 는 받지 않는다");
    const proposal = linksSrc.slice(linksSrc.indexOf("export async function getSiblingProposal("), linksSrc.indexOf("async function oneRequestPerProof("));
    assert.match(proposal, /items: toPublicSiblings\(plan\)/, "응답은 이름·반·처리 방법만");
    // 번호+이름 둘 다 — 본인인증 이름을 규칙에 넘긴다(목록·모두 연결 양쪽)
    assert.equal((linksSrc.match(/proofMatcher\(String\(proof\.phoneHash\)\), String\(proof\.verifiedName\)\)/g) ?? []).length, 2);
    // 같은 연락처 여러 가족 = 자동 연결 금지 — 본인인증 자동 연결과 형제 연결이 같은 함수
    assert.match(linksSrc, /if \(isSingleFamily\(children\.map\(row => row\.parentId\)\)\)/);
    // 번호는 원본을 남기지 않는 인증 원장 해시로 비교한다
    assert.match(linksSrc, /childIdentityHash\(`phone:\$\{digits\}`\) === phoneHash/);
});

test("계약: 인증 1건으로 여러 요청 — 마이그레이션은 UNIQUE 만 일반 색인으로 바꾸고, 적용 전에는 1건만 만든다", () => {
    const sql = read("prisma/migrations/20261113220000_child_link_request_multi_per_proof/migration.sql");
    assert.match(sql, /DROP CONSTRAINT IF EXISTS "ChildLinkRequest_challengeId_key"/);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS "ChildLinkRequest_challengeId_idx"/);
    assert.doesNotMatch(sql, /DELETE|UPDATE|DROP TABLE|DROP COLUMN/i);
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model ChildLinkRequest {"));
    assert.doesNotMatch(model.slice(0, model.indexOf("}")), /challengeId\s+String\s+@unique/);
    assert.match(linksSrc, /conname='ChildLinkRequest_challengeId_key'/);
});
