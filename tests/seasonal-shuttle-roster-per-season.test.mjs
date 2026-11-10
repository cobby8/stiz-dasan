import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// R-7②(2026-11-10): 확정 여부를 «시즌마다» 판정하는지 실제로 돌려 본다.
// 예전엔 보관 안 된 시즌 중 하나라도 확정본이 있으면 전체를 확정본으로만 읽어,
// 다음 방학 시즌(확정 전) 셔틀 신청자가 기사님 명단·학부모 화면·안내에서 통째로 빠졌다.
// 여기서는 가짜 DB 로 «여름 = 확정, 겨울 = 확정 전»을 만들어 결과를 본다.

function makeLoader(mocks) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const js = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const req = (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith("./")) return load(path.join(path.dirname(file), name).replace(/\\/g, "/") + ".ts");
      throw new Error(`unexpected import ${name}`);
    };
    vm.runInNewContext(js, { module, exports: module.exports, require: req, console, Math, JSON, Number, String, Array, Object, Set, Map, Error, Promise, Date });
    cache.set(file, module.exports);
    return module.exports;
  }
  return load;
}

function row(seasonId, id, name, extra = {}) {
  return { seasonId, shuttleRequestId: id, rosterId: `ro-${id}`, studentName: name, ride: true, classStart: "10:00", ...extra };
}

function fixture({ mode = true, confirmedSeasons = ["summer"], confirmed = [], fallback = [] } = {}) {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ sql, args });
      if (sql.includes(`"shuttleRosterConfirmedMode" AS mode`)) return [{ mode }];
      if (sql.includes(`SELECT DISTINCT sr."seasonId"`)) {
        const only = args[0];
        return confirmedSeasons.filter((s) => !only || s === only).map((s) => ({ seasonId: s }));
      }
      if (sql.includes(`FROM "SeasonalShuttleRoster" sr`) && sql.includes(`ANY($1::text[])`)) {
        return confirmed.filter((r) => args[0].includes(r.seasonId));
      }
      if (sql.includes(`FROM "SpecialProgramShuttleRequest" r`)) {
        // 폴백: 시즌 지정($1) 또는 확정 시즌 제외(마지막 인자 배열)를 흉내 낸다.
        const exclude = sql.includes(`NOT (a."seasonId" = ANY(`) ? args[args.length - 1] : [];
        const only = sql.includes(`a."seasonId" = $1`) ? args[0] : null;
        return fallback.filter((r) => (!only || r.seasonId === only) && !exclude.includes(r.seasonId));
      }
      throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
    },
  };
  const load = makeLoader({ "@/lib/prisma": { prisma }, "@/lib/auth-guard": { requireAdmin: async () => ({}) } });
  return { calls, mod: load("src/lib/seasonal/shuttleRoster.ts") };
}

const SUMMER = [row("summer", "s1", "가"), row("summer", "s2", "나")];
const WINTER_SRC = [row("winter", "w1", "다", { requestStatus: "APPROVED", classStart: "09:00" }), row("winter", "w2", "라", { requestStatus: "APPROVED" })];
const SUMMER_SRC = [row("summer", "s3", "마", { requestStatus: "APPROVED" })]; // 여름 확정 뒤 들어온 신청

test("여름 확정 + 겨울 확정 전 → 여름은 확정본만, 겨울은 신청 원본(다른 시즌이 확정됐다고 사라지지 않음)", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  const out = await mod.getConfirmedShuttleRoster();
  const byId = Object.fromEntries(out.map((e) => [e.shuttleRequestId, e.origin]));
  assert.deepEqual(byId, { s1: "CONFIRMED", s2: "CONFIRMED", w1: "FALLBACK", w2: "FALLBACK" });
  assert.ok(!("s3" in byId), "확정한 여름 시즌에 확정 뒤 들어온 신청이 섞이면 안 된다");
  // 합친 결과도 탑승·수업 시작·이름 순서
  assert.deepEqual(Array.from(out, (e) => e.shuttleRequestId), ["w1", "s1", "s2", "w2"]);
});

test("확정 시즌만 있을 때는 예전과 같다(확정본만)", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: SUMMER_SRC });
  const out = await mod.getConfirmedShuttleRoster();
  assert.deepEqual(out.map((e) => [e.shuttleRequestId, e.origin]), [["s1", "CONFIRMED"], ["s2", "CONFIRMED"]]);
});

test("R-7① 유지: 확정 시즌에서 전원을 빼도(보이는 행 0) 폴백이 되살아나지 않는다", async () => {
  const { mod } = fixture({ confirmed: [], fallback: SUMMER_SRC });
  assert.deepEqual(await mod.getConfirmedShuttleRoster("summer"), []);
  assert.deepEqual(await mod.getConfirmedShuttleRoster(), []);
});

test("킬 스위치가 꺼져 있거나 확정본이 없으면 전체 원본(예전 그대로)", async () => {
  const off = fixture({ mode: false, confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  assert.equal((await off.mod.getConfirmedShuttleRoster()).every((e) => e.origin === "FALLBACK"), true);
  const none = fixture({ confirmedSeasons: [], fallback: WINTER_SRC });
  assert.deepEqual((await none.mod.getConfirmedShuttleRoster()).map((e) => e.shuttleRequestId), ["w1", "w2"]);
});

test("시즌을 지정하면 그 시즌 기준만 본다", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  assert.deepEqual((await mod.getConfirmedShuttleRoster("winter")).map((e) => e.origin), ["FALLBACK", "FALLBACK"]);
  assert.deepEqual((await mod.getConfirmedShuttleRoster("summer")).map((e) => e.origin), ["CONFIRMED", "CONFIRMED"]);
});
