import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// @ts-expect-error -- Node의 타입 제거 실행기는 런타임 확장자를 요구한다.
import { OTHER_REVENUE_CATEGORIES, OTHER_REVENUE_CATEGORY_LABEL, OTHER_REVENUE_MAX_AMOUNT, OTHER_REVENUE_METHODS, OTHER_REVENUE_METHOD_LABEL, OTHER_REVENUE_NOTE_MAX, OTHER_REVENUE_TITLE_MAX, OtherRevenueError, otherRevenueMonthRange, validateOtherRevenueInput } from "./other-revenue-rules.ts";

// 통과하는 기본 입력 — 각 테스트가 한 칸만 바꿔 본다
const base = { revenueDate: "2026-11-17", category: "SCHOOL_CLUB", title: "OO초 스포츠클럽 11월 강사료", amount: "300,000", method: "BANK", note: "" };

const rejects = (patch: Record<string, unknown>, label: string) =>
    assert.throws(() => validateOtherRevenueInput({ ...base, ...patch }), (e: unknown) => e instanceof OtherRevenueError, label);

test("정상 입력은 저장 값으로 바뀐다(쉼표·원·앞뒤 공백 정리, 빈 메모는 null)", () => {
    const draft = validateOtherRevenueInput({ ...base, title: "  강사료  ", amount: " 300,000원 " });
    assert.deepEqual(draft, { revenueDate: "2026-11-17", category: "SCHOOL_CLUB", title: "강사료", amount: 300000, method: "BANK", note: null });
    assert.equal(validateOtherRevenueInput({ ...base, amount: 15000 }).amount, 15000);
    assert.equal(validateOtherRevenueInput({ ...base, note: " 승인 1234 " }).note, "승인 1234");
});

test("날짜: YYYY-MM-DD 이고 실제로 있는 날만", () => {
    for (const bad of ["", "2026-11-1", "2026/11/17", "2026-13-01", "2026-02-30", "2026-11-17T00:00", null, 20261117]) rejects({ revenueDate: bad }, String(bad));
    assert.equal(validateOtherRevenueInput({ ...base, revenueDate: "2028-02-29" }).revenueDate, "2028-02-29"); // 윤년
    rejects({ revenueDate: "2027-02-29" }, "윤년 아님");
    assert.equal(validateOtherRevenueInput({ ...base, revenueDate: "2026-12-31" }).revenueDate, "2026-12-31"); // 연말
});

test("금액: 1원 이상 원 단위 정수만 — 0·음수·소수·글자·빈칸·상한 초과는 거절", () => {
    for (const bad of [0, "0", -1, "-5000", 1.5, "1000.5", "abc", "", null, undefined, Number.NaN, Infinity, OTHER_REVENUE_MAX_AMOUNT + 1]) rejects({ amount: bad }, String(bad));
    assert.equal(validateOtherRevenueInput({ ...base, amount: 1 }).amount, 1);
    assert.equal(validateOtherRevenueInput({ ...base, amount: OTHER_REVENUE_MAX_AMOUNT }).amount, OTHER_REVENUE_MAX_AMOUNT);
});

test("분류·결제수단: 정해진 값만", () => {
    for (const c of OTHER_REVENUE_CATEGORIES) assert.equal(validateOtherRevenueInput({ ...base, category: c }).category, c);
    for (const m of OTHER_REVENUE_METHODS) assert.equal(validateOtherRevenueInput({ ...base, method: m }).method, m);
    for (const bad of ["", "school_club", "TUITION", null]) rejects({ category: bad }, `분류 ${bad}`);
    for (const bad of ["", "CARD", "bank", null]) rejects({ method: bad }, `수단 ${bad}`);
});

test("글자 수: 내용 1~200자, 메모 500자까지", () => {
    rejects({ title: "" }, "빈 내용");
    rejects({ title: "   " }, "공백 내용");
    assert.equal(validateOtherRevenueInput({ ...base, title: "가".repeat(OTHER_REVENUE_TITLE_MAX) }).title.length, OTHER_REVENUE_TITLE_MAX);
    rejects({ title: "가".repeat(OTHER_REVENUE_TITLE_MAX + 1) }, "201자");
    assert.equal(validateOtherRevenueInput({ ...base, note: "가".repeat(OTHER_REVENUE_NOTE_MAX) }).note?.length, OTHER_REVENUE_NOTE_MAX);
    rejects({ note: "가".repeat(OTHER_REVENUE_NOTE_MAX + 1) }, "501자");
});

test("화면 글자: 모든 값에 한국어 이름이 있다", () => {
    assert.deepEqual(OTHER_REVENUE_CATEGORIES.map((c) => OTHER_REVENUE_CATEGORY_LABEL[c]), ["학교 스포츠클럽", "특강(사이트 학생 아님)", "대관", "기타"]);
    assert.deepEqual(OTHER_REVENUE_METHODS.map((m) => OTHER_REVENUE_METHOD_LABEL[m]), ["계좌이체", "카드(POS)", "현금", "이용권", "기타"]);
});

test("달 범위: [그 달 1일, 다음 달 1일) — 연말 넘김, 틀린 달은 null", () => {
    assert.deepEqual(otherRevenueMonthRange("2026-11"), { from: "2026-11-01", to: "2026-12-01" });
    assert.deepEqual(otherRevenueMonthRange("2026-12"), { from: "2026-12-01", to: "2027-01-01" });
    for (const bad of ["", "2026-13", "2026-1", "2026-11-01", null, undefined]) assert.equal(otherRevenueMonthRange(bad), null, String(bad));
});

test("코드의 값 목록 = 마이그레이션 CHECK 의 값 목록(다르면 DB 가 저장을 거부한다)", () => {
    const sql = readFileSync("prisma/migrations/20261117200000_other_revenue/migration.sql", "utf8");
    const listOf = (column: string) => {
        const m = new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
        assert.ok(m, `${column} CHECK 없음`);
        return m[1].split(",").map((s) => s.trim().replace(/'/g, ""));
    };
    assert.deepEqual(listOf("category"), [...OTHER_REVENUE_CATEGORIES]);
    assert.deepEqual(listOf("method"), [...OTHER_REVENUE_METHODS]);
    assert.match(sql, /char_length\(title\) BETWEEN 1 AND 200/);
    assert.match(sql, /char_length\(note\) <= 500/);
    assert.match(sql, /CHECK \(amount > 0\)/);
    assert.match(sql, /DROP TABLE IF EXISTS public\."OtherRevenue";/);
    assert.match(sql, /FORCE ROW LEVEL SECURITY/);
});
