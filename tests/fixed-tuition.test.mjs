// 학생별 고정 월 수강료(2026-11-16 원장 결정 — 결정표 x4).
// ① 입력 확인·기간 겹침·저장/삭제(가짜 DB)를 실제로 돌려 본다.
// ② 원장 전용인지(부원장 금액 숨김 규칙 유지) — 서버 동작 첫머리 requireOwner, 화면은 원장 전용 «청구/수납» 탭 안,
//    표는 브라우저 키로 못 읽게(RLS + 권한 회수). 빠져도 빌드·tsc 가 통과해 신호가 없으므로 소스로 못박는다.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const mod = await loadTsModule("src/lib/billing/fixed-tuition.ts");
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

test("입력 확인: 쉼표 금액 허용, 끝 달은 선택, 메모 다듬기", () => {
    assert.deepEqual(mod.validateFixedTuitionInput({ studentId: " s1 ", amount: "150,000", startMonth: "2027-01", endMonth: "", memo: "  원장 합의 " }),
        { studentId: "s1", amount: 150000, startMonth: "2027-01", endMonth: null, memo: "원장 합의" });
    assert.equal(mod.validateFixedTuitionInput({ studentId: "s1", amount: 0, startMonth: "2027-01" }).amount, 0);
});

test("입력 확인: 음수·소수·상한 초과·달 형식·끝<시작·긴 메모는 거절", () => {
    const base = { studentId: "s1", amount: 150000, startMonth: "2027-01" };
    for (const bad of [{ amount: -1 }, { amount: "1.5" }, { amount: 10000001 }, { amount: "abc" }, { startMonth: "2027-13" }, { startMonth: "" },
        { endMonth: "2026-12" }, { endMonth: "2027/02" }, { memo: "가".repeat(201) }, { studentId: "" }]) {
        assert.throws(() => mod.validateFixedTuitionInput({ ...base, ...bad }), mod.FixedTuitionError, JSON.stringify(bad));
    }
});

test("기간 겹침: 끝 없음은 무한, 맞닿기만 하면 안 겹침", () => {
    const r = (startMonth, endMonth = null) => ({ startMonth, endMonth });
    assert.equal(mod.fixedTuitionOverlaps(r("2027-01"), r("2027-05")), true);
    assert.equal(mod.fixedTuitionOverlaps(r("2027-01", "2027-03"), r("2027-04")), false);
    assert.equal(mod.fixedTuitionOverlaps(r("2027-01", "2027-03"), r("2027-03", "2027-06")), true);
    assert.equal(mod.fixedTuitionOverlaps(r("2027-05"), r("2027-01", "2027-04")), false);
});

/** 가짜 DB — 학생 잠금·기존 기간·INSERT·DELETE 만 흉내 낸다 */
function fakeDb(existing = [], studentFound = true) {
    const state = { inserted: [], deleted: [], rows: [...existing] };
    const tx = {
        async $queryRawUnsafe(sql, ...v) {
            if (sql.includes('FROM "Student" s WHERE s.id=$1 AND') && sql.includes("FOR UPDATE")) return studentFound ? [{ id: v[0] }] : [];
            if (sql.includes('SELECT "startMonth","endMonth" FROM "StudentFixedTuition"')) return state.rows.filter(r => r.studentId === v[0]);
            if (sql.startsWith('INSERT INTO "StudentFixedTuition"')) {
                const row = { id: v[0], studentId: v[1], amount: v[2], startMonth: v[3], endMonth: v[4], memo: v[5], actorUserId: v[6], createdAt: "2026-11-16 10:00" };
                state.inserted.push(row); state.rows.push(row);
                return [row];
            }
            if (sql.includes('FROM "StudentFixedTuition" WHERE "studentId"=$1 ORDER BY')) return state.rows.filter(r => r.studentId === v[0]);
            throw new Error(`unexpected ${sql}`);
        },
        async $executeRawUnsafe(sql, ...v) {
            assert.match(sql, /DELETE FROM "StudentFixedTuition" WHERE id=\$1 AND "studentId"=\$2/);
            const before = state.rows.length;
            state.rows = state.rows.filter(r => !(r.id === v[0] && r.studentId === v[1]));
            state.deleted.push(v);
            return before - state.rows.length;
        },
    };
    return { state, db: { ...tx, $transaction: (work) => work(tx) } };
}

test("저장: 겹치지 않으면 추가, 겹치면 거절(기존 기간을 알려 준다), 없는 학생 거절", async () => {
    const { db, state } = fakeDb([{ studentId: "s1", startMonth: "2026-09", endMonth: "2026-12" }]);
    const row = await mod.addFixedTuition(db, { studentId: "s1", amount: "150000", startMonth: "2027-01", memo: "원장 합의" }, "owner-1");
    assert.equal(row.amount, 150000); assert.equal(state.inserted[0].actorUserId, "owner-1");
    await assert.rejects(mod.addFixedTuition(db, { studentId: "s1", amount: 1, startMonth: "2027-06" }, "owner-1"), /2027-01~끝 없음 고정 수강료가 있어 기간이 겹칩니다/);
    // 다른 학생의 기간은 겹침에 세지 않는다
    await mod.addFixedTuition(db, { studentId: "s2", amount: 100000, startMonth: "2027-01" }, "owner-1");
    await assert.rejects(mod.addFixedTuition(fakeDb([], false).db, { studentId: "zz", amount: 1, startMonth: "2027-01" }, "owner-1"), /학생을 찾지 못했습니다/);
    await assert.rejects(mod.addFixedTuition(db, { studentId: "s3", amount: 1, startMonth: "2027-01" }, ""), /원장 확인이 필요합니다/);
});

test("삭제: 그 학생 것만 지운다(다른 학생 id 로는 0건)", async () => {
    const { db } = fakeDb([{ id: "fx1", studentId: "s1", startMonth: "2027-01", endMonth: null }]);
    assert.equal(await mod.deleteFixedTuition(db, "fx1", "other"), 0);
    assert.equal(await mod.deleteFixedTuition(db, "fx1", "s1"), 1);
});

test("읽기: 표가 아직 없으면(운영 적용 전) 빈 목록 + ready=false", async () => {
    const missing = { async $queryRawUnsafe() { const e = new Error('relation "StudentFixedTuition" does not exist'); e.code = "42P01"; throw e; } };
    assert.deepEqual(await mod.listFixedTuition(missing, "s1"), { ready: false, rows: [] });
});

// ───────────── ② 원장 전용(부원장 금액 숨김 규칙 유지) ─────────────

function fnBody(src, name) {
    const start = src.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} 를 찾지 못함`);
    const end = src.indexOf("\n}\n", start);
    return src.slice(start, end > 0 ? end : undefined);
}

test("서버 동작 3개는 모두 첫머리에서 원장 확인(requireOwner) — 부원장은 거절", () => {
    const src = read("src/app/actions/fixed-tuition.ts");
    for (const name of ["loadFixedTuition", "saveFixedTuition", "removeFixedTuition"]) {
        assert.match(fnBody(src, name).slice(0, 200), /await requireOwner\(\)/, name);
    }
    // requireOwner 는 ADMIN 만 통과시킨다(부원장 VICE_ADMIN 거절)
    assert.match(read("src/lib/auth-guard.ts"), /appUser\.role !== "ADMIN"\) \{\s*throw new Error\("원장 권한이 필요합니다/);
});

test("화면: 고정 수강료 칸은 원장 전용 «청구/수납» 탭 안에만 있다", () => {
    const src = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
    const payStart = src.indexOf('{activeTab === "pay" && canManageFinance && (');
    const payEnd = src.indexOf('{activeTab === "history"', payStart);
    assert.ok(payStart > 0 && payEnd > payStart);
    const at = src.indexOf("<FixedTuitionPanel");
    assert.ok(at > payStart && at < payEnd, "FixedTuitionPanel 은 원장 전용 탭 안에 있어야 한다");
    assert.equal(src.split("<FixedTuitionPanel").length - 1, 1, "다른 곳에 또 두지 않는다");
});

test("표는 서버만 — RLS 켜기 + anon·authenticated 권한 회수, 금액 CHECK 는 코드 상한과 같다", () => {
    const sql = read("prisma/migrations/20261116500000_student_fixed_tuition/migration.sql");
    assert.match(sql, /ALTER TABLE public\."StudentFixedTuition" ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\."StudentFixedTuition" FROM anon, authenticated;/);
    assert.match(sql, new RegExp(`amount <= ${mod.FIXED_TUITION_MAX_AMOUNT}\\b`));
    assert.match(sql, new RegExp(`char_length\\(memo\\) <= ${mod.FIXED_TUITION_MEMO_MAX}\\b`));
});
