import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// 실제 함수를 메모리에서 실행한다. DB·인증·발송 모듈은 로딩하지 않는다.
const root = path.resolve(import.meta.dirname, "..");
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
            assert.ok(name.startsWith("."), "외부 모듈 접근 금지");
            return loadPure(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)), cache);
        },
    });
    return exports;
}
const display = loadPure("src/lib/trial-schedule-display.ts");
const time = loadPure("src/lib/trial-schedule-time.ts");
const modals = readFileSync(path.join(root, "src/app/admin/trial/TrialCrmModals.tsx"), "utf8");
const client = readFileSync(path.join(root, "src/app/admin/trial/TrialCrmClient.tsx"), "utf8");
const actions = readFileSync(path.join(root, "src/app/actions/admin.ts"), "utf8");
const fixtureClass = {
    id: "fixture-class", name: "화요일 3교시", dayOfWeek: "Tue",
    slotKey: "custom-b69b5136-ef82-4519-9b4e-d5759f2715a6", startTime: "15:00", endTime: "15:55",
};

function functionsFrom(source, names, bindings = {}) {
    const sf = ts.createSourceFile("fixture.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const nodes = sf.statements.filter((node) => names.includes(node.name?.text
        || node.declarationList?.declarations[0]?.name?.text));
    const code = ts.transpileModule(nodes.map((node) => node.getText(sf)).join("\n"), {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText.replace(/export /g, "");
    const context = vm.createContext({ Date, Intl, Object, Error, ...bindings });
    vm.runInContext(code, context);
    return context;
}

function saveHarness(initial = {}) {
    let row = { id: "fixture-lead", status: "NEW", preferredSlotKey: "Fri-4", preferredDay: "금", preferredPeriod: "4", ...initial };
    let writes = 0;
    const ctx = functionsFrom(actions, ["TRIAL_LEAD_COLUMNS", "updateTrialLead"], {
        normalizedTrialPreferencePatch: display.normalizedTrialPreferencePatch,
        seoulDateInputValue: time.seoulDateInputValue,
        requireAdmin: async () => ({ appUserId: "fixture-admin" }),
        ensureTrialLeadTable: async () => {},
        revalidatePath: () => {}, revalidateTrialAdminCaches: () => {},
        resolveCanonicalTrialSchedule: async (input) => time.resolveTrialScheduleFromRow({
            overrideStart: null, overrideHidden: false, scheduleStart: null, scheduleDay: null,
            scheduleHidden: false, scheduleActiveFrom: null, scheduleActiveTo: null,
            customStart: fixtureClass.startTime, customDay: "Tue", customHidden: false,
            classStart: fixtureClass.startTime, classDay: "Tue", classSlotKey: fixtureClass.slotKey, className: fixtureClass.name,
        }, input),
        prisma: {
            $queryRawUnsafe: async (sql) => {
                if (sql.includes('FROM "TrialLead"')) return [{ ...row }];
                if (sql.includes('FROM "Class"')) return [{ slotKey: fixtureClass.slotKey }];
                throw new Error("예상하지 않은 조회");
            },
            $executeRawUnsafe: async (sql, ...values) => {
                assert.match(sql, /^UPDATE "TrialLead" SET/);
                writes++;
                for (const match of sql.matchAll(/"(\w+)" = \$(\d+)/g)) row[match[1]] = values[Number(match[2]) - 1];
                return 1;
            },
        },
        console,
    });
    return { save: ctx.updateTrialLead, read: () => ({ ...row }), writes: () => writes };
}

test("추가반 UUID의 69를 교시로 읽지 않고 명시된 화3을 표시한다", () => {
    assert.equal(display.trialClassShortLabel(fixtureClass), "화3");
    assert.equal(display.trialClassShortLabel({ ...fixtureClass, name: "초4~6 성장반 3교시" }), "화3");
    assert.equal(display.trialClassShortLabel({ ...fixtureClass, name: "성장반" }), "화15:00");
});

test("희망 요일·교시 저장 후 재조회하면 옛 금4 키도 화3으로 갱신된다", async () => {
    const harness = saveHarness();
    await harness.save("fixture-lead", { preferredDay: "화", preferredPeriod: "3" });
    assert.equal(harness.read().preferredSlotKey, "Tue-3");
    assert.equal(harness.read().preferredDay, "화");
    assert.equal(harness.read().preferredPeriod, "3");
    assert.equal(harness.writes(), 1);
});

test("희망 수업을 변경하지 않은 정보 수정은 기존 추가반 키를 보존한다", () => {
    const patch = display.normalizedTrialPreferencePatch({ preferredDay: "화", preferredPeriod: "3" }, {
        preferredDay: "화", preferredPeriod: "3", preferredSlotKey: fixtureClass.slotKey,
    });
    assert.equal(Object.keys(patch).length, 0);
});

test("이미 희망값과 옛 정규 키가 다른 신청도 재저장 시 일치시키며 확정 수업은 보존한다", async () => {
    const harness = saveHarness({ preferredDay: "화", preferredPeriod: "3", scheduledClassId: fixtureClass.id,
        scheduledDate: "2026-11-10T06:00:00Z" });
    await harness.save("fixture-lead", { preferredDay: "화", preferredPeriod: "3" });
    assert.equal(harness.read().preferredSlotKey, "Tue-3");
    assert.equal(harness.read().scheduledClassId, fixtureClass.id);
    assert.equal(harness.read().scheduledDate, "2026-11-10T06:00:00Z");
});

test("희망 필드를 모두 지우면 옛 키도 제거하며 불완전한 조합은 저장 전에 거부한다", async () => {
    const harness = saveHarness();
    await assert.rejects(harness.save("fixture-lead", { preferredDay: "잘못된요일", preferredPeriod: "3" }));
    assert.equal(harness.writes(), 0);
    await harness.save("fixture-lead", { preferredDay: null, preferredPeriod: null });
    assert.equal(harness.read().preferredSlotKey, null);
});

test("선택한 반과 수동 시간 저장→재조회→목록 표시는 화3·15:30으로 일치하며 발송하지 않는다", async () => {
    const harness = saveHarness();
    const savedAt = "2026-11-10T15:30:00+09:00";
    const result = await harness.save("fixture-lead", {
        status: "SCHEDULED", scheduledDate: savedAt, scheduledClassId: fixtureClass.id,
    });
    const read = harness.read();
    assert.equal(read.scheduledDate, savedAt);
    assert.equal(read.scheduledClassId, fixtureClass.id);
    assert.equal(display.trialConfirmedClassShortLabel(fixtureClass, read.scheduledDate), "화3 · 15:30");
    assert.equal(result.scheduledSms.attempted, false);
    assert.equal(result.attendedSms.attempted, false);
});

test("날짜·수업 요일 불일치는 실제 서버 검증에서 쓰기 전에 거부된다", async () => {
    const harness = saveHarness();
    await assert.rejects(harness.save("fixture-lead", {
        status: "SCHEDULED", scheduledDate: "2026-11-11T15:00:00+09:00", scheduledClassId: fixtureClass.id,
    }), /요일/);
    assert.equal(harness.writes(), 0);
});

test("확정 상세는 실제 확정 시간이고 기본·기간별·보정 시간은 희망 안내에 적용한다", () => {
    const ctx = functionsFrom(client, ["formatConfirmedSchedule"], {
        getPreferredClass: () => null,
        seoulTimeInputValue: time.seoulTimeInputValue,
        formatCompactDate: () => "2026.11.10",
    });
    assert.equal(ctx.formatConfirmedSchedule({ scheduledClassId: fixtureClass.id, scheduledDate: "2026-11-10T06:30:00Z" },
        new Map([[fixtureClass.id, fixtureClass]])), "2026.11.10 15:30 · 화요일 3교시");
    assert.equal(display.trialClassTimeRange({ ...fixtureClass, startTimeOverride: "14:00", endTimeOverride: "14:55" }, "2026-11-10"), "14:00~14:55");
    assert.equal(display.trialClassTimeRange({ ...fixtureClass, scheduleStartTime: "16:00", scheduleEndTime: "16:55",
        scheduleActiveFrom: "2026-11-01", scheduleActiveTo: "2026-11-30" }, "2026-11-10"), "16:00~16:55");
});

test("실제 목록·짧은 확정일정 함수도 재조회한 수동시각을 표시한다", () => {
    const ctx = functionsFrom(client, ["formatTrialListScheduleShort", "formatConfirmedScheduleShort"], {
        trialConfirmedClassShortLabel: display.trialConfirmedClassShortLabel,
        getPreferredClass: () => null, formatShortDate: () => "11/10",
    });
    const lead = { scheduledClassId: fixtureClass.id, scheduledDate: "2026-11-10T06:30:00Z" };
    const classes = new Map([[fixtureClass.id, fixtureClass]]);
    assert.equal(ctx.formatTrialListScheduleShort(lead, classes), "화3 · 15:30");
    assert.equal(ctx.formatConfirmedScheduleShort(lead, classes), "11/10 화3 · 15:30");
    assert.equal(ctx.formatConfirmedScheduleShort({ ...lead, scheduledDate: "2026-11-10T06:00:00Z" }, classes), "11/10 화3 · 15:00");
});

test("교시 없는 추가반도 기간별 시작시간과 실제 확정시간을 일치시킨다", () => {
    const custom = { ...fixtureClass, name: "성장반", scheduleStartTime: "16:00", scheduleEndTime: "16:55",
        scheduleActiveFrom: "2026-11-01", scheduleActiveTo: "2026-11-30" };
    assert.equal(display.trialConfirmedClassShortLabel(custom, "2026-11-10T07:00:00Z"), "화16:00");
    assert.equal(display.trialConfirmedClassShortLabel(custom, "2026-11-10T07:30:00Z"), "화16:30");
    assert.equal(display.trialConfirmedClassShortLabel(custom, "2026-11-10T07:00:00Z", true), "화16:00");
});

test("첫 서버 화면의 Date 객체와 재조회 ISO 문자열 모두 변경창을 열 수 있다", () => {
    const ctx = functionsFrom(modals, ["dateInputValue", "timeInputValue", "isDateOnlySchedulePlaceholder"], time);
    for (const value of [new Date("2026-11-10T06:00:00Z"), "2026-11-10T06:00:00Z"]) {
        assert.equal(ctx.isDateOnlySchedulePlaceholder(value), false);
        assert.equal(ctx.dateInputValue(value), "2026-11-10");
        assert.equal(ctx.timeInputValue(value), "15:00");
    }
    assert.equal(ctx.isDateOnlySchedulePlaceholder("2026-11-10"), true);
});

test("날짜 조회가 취소된 후 늦게 도착한 성공 응답도 상태를 덮지 않는다", () => {
    const callback = modals.match(/\.then\(\(available\) => \{([\s\S]*?)\n            \}\)/)?.[1];
    assert.ok(callback);
    let calls = 0;
    const controller = new AbortController(); controller.abort();
    vm.runInNewContext(`(available => {${callback}})([])`, {
        controller, setOptions: () => { calls++; }, lead: {}, dateInputValue: () => "", scheduledDate: "date",
        setScheduledClassId: () => { calls++; }, setScheduledTime: () => { calls++; },
    });
    assert.equal(calls, 0);
});
