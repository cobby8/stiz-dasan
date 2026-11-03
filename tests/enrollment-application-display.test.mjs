import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
// 표시 함수만 메모리에서 실행한다. DB·인증·신청 저장 모듈은 로딩하지 않는다.
function loadPure(relative, cache = new Map()) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, { exports, Intl, Date, Object, Error,
        require: (name) => {
            assert.ok(name.startsWith("."), "표시 검사에서 외부 서비스 접근 금지");
            return loadPure(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)), cache);
        },
    });
    return exports;
}
const { formatPreferredSlotsShort: slots, formatEnrollmentMonthsShort: months } = loadPure("src/lib/enrollment-application-display.ts");
const customKey = "custom-b69b5136-ef82-4519-9b4e-d5759f2715a6";
const customClass = { name: "화요일 3교시", slotKey: customKey, dayOfWeek: "Tue", startTime: "15:00", endTime: "15:55" };

test("수강신청 추가반의 식별번호 69 대신 실제 화3을 표시한다", () => {
    assert.equal(slots(customKey, new Map([[customKey, customClass]])), "화3");
});

test("정규 키와 반 이름이 다르면 실제 반의 요일·교시를 우선한다", () => {
    assert.equal(slots("Fri-4", new Map([["Fri-4", { ...customClass, slotKey: "Fri-4" }]])), "화3");
});

test("교시 이름이 없는 정규반은 완전 일치하는 정규키를 해석한다", () => {
    assert.equal(slots("Tue-4", new Map([["Tue-4", { ...customClass, name: "초4 성장반", slotKey: "Tue-4" }]])), "화4");
});

test("교시 없는 추가반은 학년·코트·식별번호 대신 실제 시작시각을 표시한다", () => {
    assert.equal(slots(customKey, new Map([[customKey, { ...customClass, name: "초4 2코트 성장반", customStartTime: "15:10" }]])), "화 15:10");
});

test("조회되지 않은 수업·잘못된 정규키는 추정하지 않고 확인 필요로 남긴다", () => {
    assert.equal(slots("Tue-4", new Map()), "확인 필요");
    assert.equal(slots(customKey, new Map([[customKey, { ...customClass, name: "초4반", startTime: "" }]])), "확인 필요");
});

test("여러 희망 수업을 보존하며 중복 선택만 제거한다", () => {
    const classes = new Map([[customKey, customClass], ["Fri-5", { ...customClass, name: "금요일 5교시", dayOfWeek: "Fri", slotKey: "Fri-5" }]]);
    assert.equal(slots(`${customKey}, Fri-5,${customKey},missing`, classes), "화3 / 금5 / 확인 필요");
    assert.equal(classes.size, 2);
    assert.equal(slots(null, classes), null);
});

test("신청 월은 단일값과 빈 값을 읽기 쉽게 보여준다", () => {
    assert.equal(months("2026년 11월"), "2026년 11월");
    assert.equal(months(null), "-");
    assert.equal(months(" , "), "-");
});

test("10·11월을 모두 표시하며 선택 순서가 달라도 같은 결과다", () => {
    assert.equal(months("2026년 10월,2026년 11월"), "2026년 10·11월");
    assert.equal(months("2026년 11월,2026년 10월"), "2026년 10·11월");
});

test("연도가 바뀌는 신청 월은 양쪽 연도를 보존하고 정렬한다", () => {
    assert.equal(months("2027년 1월,2026년 12월,2027년 2월"), "2026년 12월 / 2027년 1·2월");
});

test("동일 월은 중복 제거하고 연도 없는 옛 값은 연도를 만들지 않는다", () => {
    assert.equal(months("2026년 11월,2026-11,2026년 10월"), "2026년 10·11월");
    assert.equal(months("11월,10월,11월"), "10·11월");
    assert.equal(months("2026년 13월,상담 후 결정"), "2026년 13월 / 상담 후 결정");
});

test("수강신청 목록은 검증한 표시 함수와 신청 월 제목을 실제로 사용한다", () => {
    const client = readFileSync(path.join(root, "src/app/admin/apply/ApplyAdminClient.tsx"), "utf8");
    assert.match(client, /import \{[^}]*formatEnrollmentMonthsShort[^}]*formatPreferredSlotsShort[^}]*\} from "@\/lib\/enrollment-application-display"/);
    assert.match(client, /formatPreferredSlotsShort\(app\.preferredSlotKeys, classesBySlotKey\)/);
    assert.match(client, /formatEnrollmentMonthsShort\(app\.enrollmentMonths\)/);
    assert.match(client, />신청 월<\/th>/);
    assert.doesNotMatch(client, /periodPart|function formatEnrollmentMonthsShort|수강 시작월/);
});
