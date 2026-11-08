import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-09 원생 등록 재설계(2차): 창 하나 3단계 + 서버 액션 registerStudent 한 번(트랜잭션 하나).
// 신청서 승인에서 정원 경고·셔틀 위치 저장을 공용 함수로 뽑았다 → «승인 동작이 바뀌지 않음»을 실제 실행으로 못박는다.
// 수강료 상수는 프로그램 화면 2곳에서 한 곳으로 모았다 → 금액이 그대로인지 못박는다.

const tuition = await loadTsModule("src/lib/billing/regular-tuition-preview.ts");
const pricing = await loadTsModule("src/lib/billing/workbench-pricing.ts");
const capacity = await loadTsModule("src/lib/enrollment/class-capacity.ts");
const shuttle = await loadTsModule("src/lib/students/student-shuttle-location-upsert.ts");
const rules = await loadTsModule("src/lib/students/student-register-rules.ts");
const commencement = await loadTsModule("src/lib/enrollment/commencement.ts");
const { buildEnrollmentOperationsEvent } = await loadTsModule("src/lib/operations-events/admin-hooks.ts");

const admin = await readFile("src/app/actions/admin.ts", "utf8");
const action = await readFile("src/app/actions/student-register.ts", "utf8");
const modal = await readFile("src/app/admin/students/StudentRegisterModal.tsx", "utf8");
const programsList = await readFile("src/app/admin/programs/ProgramsAdminClient.tsx", "utf8");
const programForm = await readFile("src/app/admin/programs/ProgramFormPanel.tsx", "utf8");
const trialClient = await readFile("src/app/admin/trial/TrialCrmClient.tsx", "utf8");

function fnBlock(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} 를 찾지 못했습니다`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

// ── 수강료 미리보기(s-fee) ─────────────────────────────────────────────────

test("[요금] 주 횟수별 셔틀 자동 요금은 예전 값 그대로(1만·1.5만·2만·2만)", () => {
  assert.deepEqual(tuition.REGULAR_FREQ_TIERS.map((t) => [t.key, t.label, t.autoShuttle]), [
    ["priceWeek1", "주 1회", 10000],
    ["priceWeek2", "주 2회", 15000],
    ["priceWeek3", "주 3회", 20000],
    ["priceDaily", "매일반", 20000],
  ]);
  // 셔틀비 판정: 주말 없음 · 0 = 끔 · 양수 = 직접 입력 · 그 밖 = 자동
  assert.equal(tuition.shuttleFeeAmount(null, "priceWeek2", true), null);
  assert.equal(tuition.shuttleFeeAmount(0, "priceWeek2", false), null);
  assert.equal(tuition.shuttleFeeAmount(30000, "priceWeek2", false), 30000);
  assert.equal(tuition.shuttleFeeAmount(null, "priceWeek2", false), 15000);
  assert.equal(tuition.isWeekendOnlyDays(["Sat", "Sun"]), true);
  assert.equal(tuition.isWeekendOnlyDays(["Sat", "Mon"]), false);
  assert.equal(tuition.isWeekendOnlyDays([]), false);
});

test("[요금] 프로그램 화면 2곳은 상수를 따로 갖지 않고 공용 모듈을 쓴다", () => {
  for (const [label, source] of [["ProgramsAdminClient", programsList], ["ProgramFormPanel", programForm]]) {
    assert.match(source, /from "@\/lib\/billing\/regular-tuition-preview"/, label);
    assert.doesNotMatch(source, /autoShuttle: 1\d000/, `${label}: 금액 상수 복사본이 남아 있으면 안 된다`);
    assert.match(source, /const FREQ_TIERS = REGULAR_FREQ_TIERS/, label);
  }
  assert.match(programsList, /shuttleFeeAmount\(shuttleFeeOverride, freqKey, weekend\)/);
});

/** 청구 준비(workbench)가 같은 학생·같은 반으로 내놓을 «제안값» — 청구 모듈 함수를 직접 불러 계산 */
function billingSuggestion(programs, classes, onRoster) {
  const byId = new Map(programs.map((p) => [p.id, p]));
  const plans = pricing.planWeeklyTuition(classes.map((c) => {
    const p = byId.get(c.programId);
    return { key: `s1:${c.id}`, studentId: "s1", programId: p.id, programName: p.name, price: p.price, priceWeek1: p.priceWeek1, priceWeek2: p.priceWeek2, priceWeek3: p.priceWeek3, priceDaily: p.priceDaily };
  }));
  const tuitionTotal = [...plans.values()].reduce((sum, plan) => sum + plan.baseAmount, 0);
  const shuttle = pricing.planShuttleFee(onRoster, classes.map((c) => {
    const p = byId.get(c.programId);
    return { dayOfWeek: c.dayOfWeek, slotKey: c.slotKey, runsShuttle: p.runsShuttle, shuttleFeeOverride: p.shuttleFeeOverride };
  }));
  return { tuitionTotal, shuttleFee: shuttle.amount };
}

const PROGRAMS = [
  { id: "hobby", name: "주중취미", price: 100000, priceWeek1: 100000, priceWeek2: 160000, priceWeek3: 210000, priceDaily: null, shuttleFeeOverride: null, runsShuttle: true },
  { id: "match", name: "주중경기", price: 110000, priceWeek1: 110000, priceWeek2: 180000, priceWeek3: null, priceDaily: null, shuttleFeeOverride: 25000, runsShuttle: true },
  { id: "weekend", name: "주말반", price: 120000, priceWeek1: 120000, priceWeek2: null, priceWeek3: null, priceDaily: null, shuttleFeeOverride: null, runsShuttle: true },
  { id: "elite", name: "대표팀", price: 150000, priceWeek1: 150000, priceWeek2: null, priceWeek3: null, priceDaily: null, shuttleFeeOverride: null, runsShuttle: true },
];
const cls = (id, programId, dayOfWeek, slotKey = null) => ({ id, programId, dayOfWeek, slotKey });

test("[요금] 미리보기 = 청구 제안값(대표 5가지)", () => {
  const cases = [
    ["주2회 한 프로그램 + 셔틀", [cls("a", "hobby", "Mon"), cls("b", "hobby", "Wed")], true, { tuitionTotal: 160000, shuttleFee: 15000 }],
    ["반 4개(주4회 칸 없음 → 청구와 같은 대체 계산)", [cls("a", "hobby", "Mon"), cls("b", "hobby", "Tue"), cls("c", "hobby", "Wed"), cls("d", "hobby", "Thu")], true, { tuitionTotal: 400000, shuttleFee: 20000 }],
    ["여러 프로그램 + 셔틀(직접 입력 셔틀비가 있으면 그 값)", [cls("a", "hobby", "Mon"), cls("b", "match", "Thu")], true, { tuitionTotal: 170000, shuttleFee: 25000 }], // 5a2ec1d9 «여러 프로그램 합산» 규칙 반영
    ["주말 판정은 반 요일 기준(주말 반은 셔틀 횟수에서 빠짐)", [cls("a", "hobby", "Tue"), cls("b", "weekend", "Sat")], true, { tuitionTotal: 220000, shuttleFee: 10000 }],
    ["일8 대표팀이면 셔틀비 전체 면제", [cls("a", "hobby", "Mon"), cls("b", "elite", "Sun", "Sun-8")], true, { tuitionTotal: 250000, shuttleFee: 0 }],
  ];
  for (const [label, classes, shuttleOn, expected] of cases) {
    const preview = tuition.previewRegularTuition(PROGRAMS, classes, shuttleOn);
    const billing = billingSuggestion(PROGRAMS, classes, shuttleOn);
    assert.deepEqual({ tuitionTotal: preview.tuitionTotal, shuttleFee: preview.shuttleFee }, billing, `${label}: 청구 제안값과 달라졌다`);
    assert.deepEqual(billing, expected, `${label}: 기대 금액`);
  }
  // 셔틀을 안 쓰면 0, 여러 프로그램이면 청구 화면과 같은 경고가 붙는다
  assert.equal(tuition.previewRegularTuition(PROGRAMS, [cls("a", "hobby", "Mon")], false).shuttleFee, 0);
  assert.match(tuition.previewRegularTuition(PROGRAMS, [cls("a", "hobby", "Mon"), cls("b", "match", "Thu")], true).lines[0].warning ?? "", /여러 프로그램/);
});

test("[요금] 미리보기는 자체 계산 없이 청구 모듈을 부르고, 셔틀 자동 요금 상수도 청구 모듈 하나", async () => {
  const source = await readFile("src/lib/billing/regular-tuition-preview.ts", "utf8");
  assert.match(source, /from "@\/lib\/billing\/workbench-pricing"/);
  assert.match(source, /planWeeklyTuition\(enrollments\)/);
  assert.match(source, /planShuttleFee\(useShuttle,/);
  assert.doesNotMatch(source, /1[05]_?000|20_?000/, "금액 숫자를 따로 두지 않는다");
  assert.deepEqual(tuition.REGULAR_FREQ_TIERS.map((t) => t.autoShuttle), [
    pricing.AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[1], pricing.AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[2],
    pricing.AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[3], pricing.AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[3],
  ]);
});

// ── 신청서 승인에서 뽑은 공용 함수 — 승인 동작 고정 ────────────────────────

test("[정원] 정원을 채운 반만 경고(current >= capacity), 대문자 별칭도 읽는다, 읽기만 한다", async () => {
  assert.equal(capacity.overCapacityRow("c1", { name: "월4", capacity: 10, current: 9 }), null);
  assert.deepEqual(capacity.overCapacityRow("c1", { name: "월4", capacity: 10, current: 10 }), { classId: "c1", name: "월4", current: 10, capacity: 10 });
  assert.deepEqual(capacity.overCapacityRow("c2", { CAPACITY: "8", CURRENT: "9" }), { classId: "c2", name: "", current: 9, capacity: 8 });
  assert.equal(capacity.overCapacityRow("c3", undefined), null);
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return values[0] === "full" ? [{ name: "가득", capacity: 5, current: 5 }] : [{ name: "여유", capacity: 5, current: 1 }]; } };
  assert.deepEqual(await capacity.findOverCapacityClasses(db, ["ok", "full"]), [{ classId: "full", name: "가득", current: 5, capacity: 5 }]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /INSERT|UPDATE|DELETE/);
    assert.match(call.sql, /e\.status = 'ACTIVE' AND s\."mergedIntoStudentId" IS NULL/, "병합된 학생 제외");
  }
});

test("[셔틀 위치] 공용 저장 SQL·인자 순서는 승인 경로 원문과 같고, 장소명이 없으면 도로명→지번", async () => {
  const calls = [];
  const tx = { async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; } };
  const base = { studentId: "s1", kind: "PICKUP", address: "지번", roadAddress: "도로명", latitude: 37.1, longitude: 127.1, placeId: "pl", source: "SEARCH", accuracyMeters: 5, confirmedAt: "2026-11-09T01:00:00.000Z", consentVersion: "v1" };
  await shuttle.upsertStudentShuttleLocation(tx, { ...base, name: "정문" });
  await shuttle.upsertStudentShuttleLocation(tx, { ...base, name: null });
  await shuttle.upsertStudentShuttleLocation(tx, { ...base, name: null, roadAddress: null });
  assert.deepEqual(calls[0].values, ["s1", "PICKUP", "지번", "도로명", 37.1, 127.1, "pl", "SEARCH", 5, "2026-11-09T01:00:00.000Z", "v1", "정문"]);
  assert.equal(calls[1].values[11], "도로명");
  assert.equal(calls[2].values[11], "지번");
  assert.match(calls[0].sql, /INSERT INTO "StudentShuttleLocation"[\s\S]*ON CONFLICT \("studentId", kind\) DO UPDATE SET/);
  assert.match(calls[0].sql, /gen_random_uuid\(\)::text, \$1, \$2, \$12, \$3, \$4,/);
});

/**
 * 실제 approveEnrollApplication 함수 본문을 꺼내 가짜 db 로 실행한다(enrollment-commencement 하네스와 같은 방식).
 * 이번에는 공용 함수(정원·셔틀 위치)를 진짜 모듈로 넣어 «뽑기 전과 같은 동작»인지 본다.
 */
function approvalHarness({ capacityRow = { name: "합성반", capacity: 10, current: 3 }, shuttleNeeded = false } = {}) {
  const ast = ts.createSourceFile("admin.ts", admin, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "approveEnrollApplication");
  const javascript = ts.transpileModule(fn.getText(ast).replace("export async function", "async function"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const writes = [], events = [], reads = [];
  const location = (prefix, label) => ({
    [prefix]: label, [`${prefix}Address`]: `${label} 지번`, [`${prefix}RoadAddress`]: `${label} 도로명`,
    [`${prefix}Latitude`]: 37.6, [`${prefix}Longitude`]: 127.15, [`${prefix}PlaceId`]: null, [`${prefix}Source`]: "MAP_PIN",
    [`${prefix}AccuracyMeters`]: null, [`${prefix}ConfirmedAt`]: "2026-11-01T00:00:00.000Z",
  });
  const app = {
    id: "application-a", status: "PENDING", childName: "합성", childBirthDate: "2018-01-01", parentName: "합성부모", parentPhone: "01000000000",
    requestedStartOn: "2026-12-01", shuttleNeeded,
    ...(shuttleNeeded ? { ...location("shuttlePickup", "탑승"), ...location("shuttleDropoff", "하차"), shuttleLocationConsentVersion: "test", shuttleLocationConsentAt: "2026-11-01T00:00:00.000Z" } : {}),
  };
  const tx = {
    async $queryRawUnsafe(sql, ...args) {
      reads.push(sql);
      if (sql.includes("c.capacity AS capacity")) return [capacityRow];
      if (sql.includes('FROM "Class" c JOIN "Program"')) return [{ id: "class-a" }];
      if (sql.includes('FROM "EnrollmentApplication"')) return [app];
      if (sql.includes('SELECT id FROM "Student"')) return [{ id: "student-a" }];
      if (sql.includes('SELECT name AS "className"')) return [{ className: "합성반" }];
      if (sql.includes('SELECT "classId" FROM "Enrollment"')) return [];
      if (sql.includes('SELECT id, status FROM "Enrollment"')) return [];
      if (sql.includes('INSERT INTO "Enrollment"')) { writes.push({ sql, args }); return [{ id: "enrollment-a", updatedAt: new Date("2026-11-03T04:00:00Z") }]; }
      throw Error(`unexpected query: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...args) { writes.push({ sql, args }); return 1; },
  };
  const ctx = vm.createContext({
    console, Date, Set, Number, String, Boolean, Error, Array, Object,
    requireAdmin: async () => ({ appUserId: "admin-a" }), normalizeApprovalClassIds: (ids) => ids,
    prisma: { ...tx, $transaction: async (run) => run(tx) }, ...commencement,
    ApprovalAbort: class extends Error {}, ParentSelectionRequired: class extends Error {},
    parentPhoneDigits: () => "01000000000", resolveApprovalParent: async () => "parent-a", verifyEnrollmentParentAuth: () => {},
    notMergedStudent: () => "true", SHUTTLE_LOCATION_CONSENT_VERSION: "test",
    buildEnrollmentOperationsEvent, enqueueWebsiteOperationsEventInTransaction: async (_tx, event) => events.push(event),
    // 이번에 뽑은 공용 함수 — 진짜 모듈
    findOverCapacityClasses: capacity.findOverCapacityClasses, upsertStudentShuttleLocation: shuttle.upsertStudentShuttleLocation,
    revalidatePath() {}, revalidateApplyAdminCaches() {}, revalidateStudentAdminCaches() {},
  });
  const approve = vm.runInContext(`${javascript};approveEnrollApplication`, ctx);
  return { writes, events, reads, approve: (data = {}) => approve("application-a", { classIds: ["class-a"], ...data }) };
}

test("[승인 고정] 정원을 채운 반이면 아무것도 쓰지 않고 CAPACITY_WARNING, force 면 그대로 승인", async () => {
  const full = approvalHarness({ capacityRow: { name: "합성반", capacity: 10, current: 10 } });
  const warned = await full.approve();
  // vm 안에서 만든 객체라 프로토타입이 달라 JSON 으로 값만 비교한다
  assert.deepEqual(JSON.parse(JSON.stringify(warned)), { ok: false, code: "CAPACITY_WARNING", classes: [{ classId: "class-a", name: "합성반", current: 10, capacity: 10 }] });
  assert.equal(full.writes.length, 0);
  assert.equal(full.events.length, 0);
  const forced = approvalHarness({ capacityRow: { name: "합성반", capacity: 10, current: 10 } });
  assert.equal((await forced.approve({ force: true })).approved, true);
  assert.equal(forced.reads.some((sql) => sql.includes("c.capacity AS capacity")), false, "force 면 정원을 읽지도 않는다");
  // 여유 있으면 경고 없이 승인
  assert.equal((await approvalHarness().approve()).approved, true);
});

test("[승인 고정] 셔틀 위치 2건을 예전과 같은 인자로 저장한다(장소명 = 신청서 라벨)", async () => {
  const h = approvalHarness({ shuttleNeeded: true });
  assert.equal((await h.approve({ force: true })).approved, true);
  const saved = h.writes.filter((w) => w.sql.includes('INSERT INTO "StudentShuttleLocation"'));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0].args, ["student-a", "PICKUP", "탑승 지번", "탑승 도로명", 37.6, 127.15, null, "MAP_PIN", null, "2026-11-01T00:00:00.000Z", "test", "탑승"]);
  assert.deepEqual(saved[1].args.slice(0, 2), ["student-a", "DROPOFF"]);
  assert.equal(saved[1].args[11], "하차");
  assert.match(admin, /upsertLocation\("PICKUP", "shuttlePickup"\)/);
});

// ── 입력 규칙(창·서버 공용) ────────────────────────────────────────────────

const TODAY = "2026-11-09";
function validInput(patch = {}) {
  return {
    student: { name: "김루빈", birthDate: "2016-03-15", gender: "남" },
    guardians: [{ relation: "엄마", name: "김엄마", phone: "010-1234-5678" }],
    classIds: ["c1"],
    assignLater: false,
    startOn: "2026-11-10",
    shuttle: { needed: false },
    privacyConfirmed: true,
    ...patch,
  };
}

test("[규칙] 반 필수(«반은 나중에 배정»으로만 건너뜀)·주 보호자 휴대폰 필수·개인정보 확인 필수", () => {
  assert.equal(rules.validateStudentRegisterInput(validInput(), TODAY).ok, true);
  const noClass = rules.validateStudentRegisterInput(validInput({ classIds: [] }), TODAY);
  assert.equal(noClass.ok, false);
  assert.equal(noClass.step, 2);
  assert.equal(rules.validateStudentRegisterInput(validInput({ classIds: [], assignLater: true }), TODAY).ok, true);
  assert.equal(rules.validateStudentRegisterInput(validInput({ classIds: ["c1"], assignLater: true }), TODAY).ok, false, "둘 다면 헷갈린다");
  const noPhone = rules.validateStudentRegisterInput(validInput({ guardians: [{ relation: "엄마", name: "김엄마", phone: "" }] }), TODAY);
  assert.equal(noPhone.ok, false);
  assert.equal(noPhone.step, 1);
  assert.equal(rules.validateStudentRegisterInput(validInput({ guardians: [{ relation: "엄마", name: "김엄마", phone: "000-0000-0000" }] }), TODAY).ok, false, "자리채움 번호");
  const noPrivacy = rules.validateStudentRegisterInput(validInput({ privacyConfirmed: false }), TODAY);
  assert.equal(noPrivacy.ok, false);
  assert.equal(noPrivacy.step, 3);
});

test("[규칙] 생년월일·시작일은 실재하는 달력 날짜만, 생년은 미래 금지", () => {
  for (const birthDate of ["2016-02-30", "2016315", "2027-01-01", "1949-12-31"]) {
    assert.equal(rules.validateStudentRegisterInput(validInput({ student: { name: "가", birthDate } }), TODAY).ok, false, birthDate);
  }
  assert.equal(rules.validateStudentRegisterInput(validInput({ student: { name: "가", birthDate: "2016-02-29" } }), TODAY).ok, true, "윤년");
  assert.equal(rules.validateStudentRegisterInput(validInput({ student: { name: "가", birthDate: TODAY } }), TODAY).ok, true, "오늘까지는 허용");
  assert.equal(rules.validateStudentRegisterInput(validInput({ startOn: "2026-13-01" }), TODAY).ok, false);
  assert.equal(rules.validateStudentRegisterInput(validInput({ startOn: "2026-11-01T00:00:00Z" }), TODAY).ok, false);
});

test("[규칙] 보조 보호자: 빈 줄은 건너뛰고, 같은 번호 두 번·최대 6명 초과는 막는다", () => {
  const ok = rules.validateStudentRegisterInput(validInput({
    guardians: [
      { relation: "엄마", name: "김엄마", phone: "010-1234-5678" },
      { relation: "", name: "", phone: "" },
      { relation: "아빠", name: "", phone: "010 9999 8888" },
    ],
  }), TODAY);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.primaryGuardian, { relation: "엄마", name: "김엄마", phone: "01012345678" });
  assert.deepEqual(ok.value.extraGuardians, [{ relation: "아빠", name: "아빠", phone: "01099998888" }], "이름이 비면 관계명(학생 상세 규칙과 같음)");
  const dup = rules.validateStudentRegisterInput(validInput({
    guardians: [{ relation: "엄마", name: "김엄마", phone: "01012345678" }, { relation: "아빠", name: "김아빠", phone: "010-1234-5678" }],
  }), TODAY);
  assert.equal(dup.ok, false);
  const many = Array.from({ length: 7 }, (_, i) => ({ relation: "기타 보호자", name: `보호자${i}`, phone: `0101234000${i}` }));
  assert.equal(rules.validateStudentRegisterInput(validInput({ guardians: many }), TODAY).ok, false);
});

test("[규칙] 셔틀 위치·사진 동의·유니폼 값 검증", () => {
  const loc = { address: "다산동 1", roadAddress: "다산순환로 1", latitude: 37.6, longitude: 127.15, source: "SEARCH", placeName: "정문" };
  const shuttleOk = rules.validateStudentRegisterInput(validInput({ shuttle: { needed: true, pickup: loc, dropoff: null } }), TODAY);
  assert.equal(shuttleOk.ok, true);
  assert.equal(shuttleOk.value.shuttle.pickup.name, "정문");
  assert.equal(shuttleOk.value.shuttle.dropoff, null);
  assert.equal(rules.validateStudentRegisterInput(validInput({ shuttle: { needed: true, pickup: { ...loc, latitude: 200 } } }), TODAY).ok, false);
  assert.equal(rules.validateStudentRegisterInput(validInput({ shuttle: { needed: true, pickup: { ...loc, source: "GUESS" } } }), TODAY).ok, false);
  // 셔틀을 끄면 위치는 저장하지 않는다
  assert.equal(rules.validateStudentRegisterInput(validInput({ shuttle: { needed: false, pickup: loc } }), TODAY).value.shuttle.pickup, null);
  // 사진 동의: 갤러리는 내부 보관이 있어야(사진 동의 화면과 같은 규칙), 확인 방법 필수
  const media = (m) => rules.validateStudentRegisterInput(validInput({ mediaConsent: m }), TODAY);
  assert.equal(media({ internalAllowed: true, galleryAllowed: true, instagramAllowed: false, method: "WRITTEN" }).ok, true);
  assert.equal(media({ internalAllowed: false, galleryAllowed: true, instagramAllowed: false, method: "WRITTEN" }).ok, false);
  assert.equal(media({ internalAllowed: true, galleryAllowed: false, instagramAllowed: false, method: "" }).ok, false);
  assert.equal(rules.validateStudentRegisterInput(validInput({ uniformStatus: "수령완료" }), TODAY).ok, true);
  assert.equal(rules.validateStudentRegisterInput(validInput({ uniformStatus: "아무거나" }), TODAY).ok, false);
});

test("[규칙] 유니폼 허용값은 학생 상세 저장(updateStudentUniform)과 같은 목록 한 곳", () => {
  assert.deepEqual([...rules.UNIFORM_STATUS_VALUES], ["보유", "미보유", "신청", "주문", "수령완료", "미수령", "확인보류", "해당없음", "미신청"]);
  assert.match(fnBlock(admin, "updateStudentUniform"), /new Set<string>\(UNIFORM_STATUS_VALUES\)/);
});

test("[규칙] 지점은 반 장소에서 자동(원본 문장 형식 그대로), 모르면 null — 1호점(폐점)은 새 선택지에 없다", () => {
  assert.equal(rules.branchFromClassLocation("평내호평 체육관"), "평내호평점");
  assert.equal(rules.branchFromClassLocation("다산 아트홀"), "2호점 : 행정복지센터(다산아트홀) 앞");
  assert.equal(rules.branchFromClassLocation("2호점"), "2호점 : 행정복지센터(다산아트홀) 앞");
  assert.equal(rules.branchFromClassLocation("체육관 B"), null);
  assert.equal(rules.branchFromClassLocation(null), null);
  assert.equal(rules.branchFromClassLocations([null, "체육관", "호평"]), "평내호평점");
  // POS 대사(classifyBranch)는 «2호점»으로 시작해야 다산2호점으로 본다
  assert.ok(rules.REGISTER_BRANCH_OPTIONS[0].value.startsWith("2호점"));
  assert.equal(rules.REGISTER_BRANCH_OPTIONS.some((o) => o.value.startsWith("1호점")), false);
  assert.equal(rules.branchLabel("2호점 : 행정복지센터(다산아트홀) 앞"), "다산2호점");
  assert.equal(rules.validateStudentRegisterInput(validInput({ classIds: [], assignLater: true, branch: "1호점 : 새봄중학교 앞" }), TODAY).ok, false);
});

test("[규칙] 중복 의심: 이름+생년 또는 이름+보호자 번호", () => {
  const rows = [
    { id: "a", name: "김루빈", birthDate: "2016-03-15", phoneDigits: ["01000000001"], classNames: ["월4"] },
    { id: "b", name: "김루빈", birthDate: "2015-01-01", phoneDigits: ["01012345678"], classNames: [] },
    { id: "c", name: "김루빈", birthDate: "2014-01-01", phoneDigits: ["01099990000"], classNames: [] },
    { id: "d", name: "이루빈", birthDate: "2016-03-15", phoneDigits: ["01012345678"], classNames: [] },
  ];
  const found = rules.findDuplicateSuspects(rows, { name: " 김루빈 ", birthDate: "2016-03-15", guardianPhones: ["010-1234-5678", ""] });
  assert.deepEqual(found.map((d) => [d.id, d.reason]), [["a", "SAME_BIRTH"], ["b", "SAME_GUARDIAN_PHONE"]]);
});

test("[규칙] 생년 KST 날짜: 무tz 컬럼에 «두 번» 걸고, 자정 행·전날 15:00 행 모두 원래 생일", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const model = schema.slice(schema.indexOf("model Student {"), schema.indexOf("}", schema.indexOf("model Student {")));
  assert.match(model, /\n\s*birthDate\s+DateTime\s*\n/, "@db.Timestamptz 가 없는 = 시간대 없는 timestamp");
  assert.equal(rules.STUDENT_BIRTH_KST_YMD_SQL("s"), `to_char((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')`);
  // 같은 규칙의 JS 판(값을 UTC 로 보고 서울 날짜로)
  assert.equal(rules.birthDateKstYmd("2016-03-15 00:00:00"), "2016-03-15", "자정 저장 행 → KST 09:00 → 같은 날");
  assert.equal(rules.birthDateKstYmd("2016-03-14 15:00:00"), "2016-03-15", "한국 자정을 UTC 로 넣은 행 → 다음 날 = 원래 생일");
  assert.equal(rules.birthDateKstYmd("2016-03-14 14:59:59"), "2016-03-14");
  assert.equal(rules.birthDateKstYmd("2015-12-31 15:00:00.000"), "2016-01-01", "연말 경계");
  assert.equal(rules.birthDateKstYmd("2016-02-28 15:00:00"), "2016-02-29", "윤년");
  assert.equal(rules.birthDateKstYmd(new Date("2016-03-14T15:00:00.000Z")), "2016-03-15");
  assert.equal(rules.birthDateKstYmd(""), "");
  // 중복 확인 SQL 은 이 조각을 쓴다(날짜만 자르지 않는다)
  assert.match(action, /\$\{STUDENT_BIRTH_KST_YMD_SQL\("s"\)\} AS "birthDate"/);
  assert.doesNotMatch(action, /to_char\(s\."birthDate", 'YYYY-MM-DD'\)/);
});

test("[규칙] 새로 저장하는 생년 형식은 기존 등록 경로(createStudent·엑셀)와 같은 «YYYY-MM-DD → ::timestamp» 자정", () => {
  assert.match(fnBlock(action, "registerStudent"), /VALUES \(gen_random_uuid\(\)::text, \$1, \$2::timestamp,/);
  assert.match(admin.slice(admin.indexOf("async function insertAdminStudentWithGuardian(")), /VALUES \(gen_random_uuid\(\)::text, \$1, \$2::timestamp,/);
});

test("[규칙] 개인정보 동의 확인은 agreementsJSON 의 adminRegister 아래에 누가·언제·그날", () => {
  assert.deepEqual(JSON.parse(rules.buildAdminRegisterAgreements("admin-1", "2026-11-09T01:02:03.000Z", "2026-11-09")), {
    adminRegister: { privacy: true, by: "admin-1", at: "2026-11-09T01:02:03.000Z", on: "2026-11-09" },
  });
});

// ── 서버 액션 registerStudent — 한 트랜잭션·같은 규칙 ─────────────────────

test("[등록] 관리자 확인 → 검증 → 정원·중복 경고(읽기만) → 트랜잭션 하나로 저장", () => {
  const body = fnBlock(action, "registerStudent");
  assert.match(body, /const admin = await requireAdmin\(\)/);
  assert.match(body, /validateStudentRegisterInput\(input, today\)/);
  assert.equal((body.match(/prisma\.\$transaction\(/g) || []).length, 1, "저장은 트랜잭션 하나");
  const tx = body.indexOf("prisma.$transaction(");
  assert.ok(body.indexOf("findOverCapacityClasses(prisma, classIds)") < tx, "정원 경고는 쓰기 전에");
  assert.ok(body.indexOf("readDuplicateCandidates(") < tx, "중복 확인도 쓰기 전에");
  assert.match(body, /code: "CAPACITY_WARNING"/);
  assert.match(body, /code: "DUPLICATE_SUSPECT"/);
  const inTx = body.slice(tx);
  for (const needle of [
    "FOR SHARE OF c, p",
    "linkParentAccountForNewStudent(tx, data.primaryGuardian)",
    'INSERT INTO "Student"',
    "insertPrimaryGuardian(tx, studentId, data.primaryGuardian)",
    '"isPrimary", "createdAt", "updatedAt")\n                     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, false',
    '"startsOn"',
    "buildEnrollmentOperationsEvent({",
    "effectiveDate: data.startOn",
    "enqueueWebsiteOperationsEventInTransaction(tx, event)",
    "upsertStudentShuttleLocation(tx,",
    'INSERT INTO "StudentMediaConsent"',
    'UPDATE "TrialLead"',
    '"convertedDate" = COALESCE("convertedDate", NOW())',
  ]) assert.ok(inTx.includes(needle), `트랜잭션 안에 있어야 함: ${needle}`);
  // 지점 = 반 장소 자동, 모를 때만 직접 고른 값 / 개인정보 확인 기록
  assert.match(inTx, /branchFromClassLocations\(locked\.map\(\(c\) => c\.location\)\) \?\? data\.branch/);
  assert.match(inTx, /buildAdminRegisterAgreements\(admin\.appUserId, new Date\(\)\.toISOString\(\), today\)/);
});

test("[등록] 번호 잠금을 잡은 직후 트랜잭션 안에서 중복을 다시 본다(동시 등록)", () => {
  const body = fnBlock(action, "registerStudent");
  const inTx = body.slice(body.indexOf("prisma.$transaction("));
  const lock = inTx.indexOf("linkParentAccountForNewStudent(tx, data.primaryGuardian)");
  const recheck = inTx.indexOf("readDuplicateCandidates(tx, data.student.name)");
  const insert = inTx.indexOf('INSERT INTO "Student"');
  assert.ok(lock >= 0 && lock < recheck && recheck < insert, "잠금 → 재확인 → 학생 INSERT 순서");
  assert.match(inTx, /if \(!data\.allowDuplicate\) \{\s*const again = findDuplicateSuspects\(await readDuplicateCandidates\(tx, data\.student\.name\), duplicateTarget\);\s*if \(again\.length > 0\) throw new RegisterDuplicate\(again\);/);
  assert.match(body, /if \(e instanceof RegisterDuplicate\) \{\s*return \{ ok: false, code: "DUPLICATE_SUSPECT", duplicates: e\.duplicates/);
});

test("[엑셀] 일괄 등록 설명 주석이 실제 동작(학생 1명 = 트랜잭션 하나)과 맞다", () => {
  assert.doesNotMatch(admin, /트랜잭션 사용 불가이므로/);
  assert.match(admin, /학생 1명 신규 분기\(계정 확정·학생·보호자1~3\)는 트랜잭션 하나/);
});

test("[화면] 체험 생년은 글자 자르기 대신 서울 날짜로 채운다", async () => {
  const trialModals = await readFile("src/app/admin/trial/TrialCrmModals.tsx", "utf8");
  const fn = trialModals.slice(trialModals.indexOf("function trialRegisterPrefill"));
  assert.match(fn, /const birth = seoulDateInputValue\(lead\.childBirthDate\)/);
  assert.doesNotMatch(fn.slice(0, 600), /\.slice\(0, 10\)/);
});

test("[등록] 기존 학부모 계정을 고치지 않고, 문자·알림을 보내지 않고, 원시 SQL 만 쓴다", () => {
  assert.doesNotMatch(action, /UPDATE "User"/);
  assert.doesNotMatch(action, /from "@\/lib\/(notification|sms|solapi)/);
  assert.doesNotMatch(action, /sendParentSms|sendNotifications|notifyAdmins|sendTrackedSms/);
  assert.doesNotMatch(action, /prisma\.\w+\.(findMany|findUnique|create|update|upsert|delete)\(/, "PgBouncer — ORM 기본 메서드 금지");
  assert.doesNotMatch(action, /toISOString\(\)\.slice\(0, ?10\)/);
  assert.match(action, /todayKst\(\)/);
});

test("[등록] 미리보기도 저장과 같은 계정 판정(decideParentAccount)이고 아무것도 쓰지 않는다", () => {
  const body = fnBlock(action, "previewStudentRegistration");
  assert.match(body, /await requireAdmin\(\)/);
  assert.match(body, /decideParentAccount\(rows\)/);
  assert.match(body, /findDuplicateSuspects\(/);
  assert.doesNotMatch(body, /INSERT|UPDATE|DELETE|\$executeRawUnsafe|\$transaction/);
});

test("[엑셀] 신규 학생 분기도 같은 계정 연결 모듈 — 번호 없음·계정 여러 개는 그 행만 실패", () => {
  const body = fnBlock(admin, "bulkCreateStudents");
  const created = body.slice(body.indexOf("// ── 3. 신규 학생"), body.indexOf("// ── 7. 엑셀 클래스명"));
  assert.match(created, /validatePrimaryGuardian\(\{ relation: guardian1Label, name: guardian1Label, phone: student\.guardian1Phone \}\)/);
  assert.match(created, /if \(!guardian1\.ok\) throw new Error\(/, "바깥 catch 가 엑셀 실패 행으로 남긴다");
  assert.match(created, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(created, /linkParentAccountForNewStudent\(tx, guardian1\.value\)/);
  assert.match(created, /insertPrimaryGuardian\(tx, createdId, guardian1\.value\)/);
  assert.match(created, /insertGuardians\(createdId, student, tx\)/);
  assert.doesNotMatch(created, /INSERT INTO "User"/, "계정 생성은 공용 모듈만");
  assert.doesNotMatch(created, /parent_\$\{Date\.now\(\)\}/);
  assert.match(body, /reason: e instanceof Error \? e\.message/);
});

// ── 화면 ──────────────────────────────────────────────────────────────────

test("[화면] 등록 창: 3단계·학원 색 토큰·서버와 같은 1단계 검증·반 나중 배정·정원 재확인", () => {
  assert.match(modal, /const STEP_LABELS = \["학생·보호자", "수업·셔틀", "확인"\]/);
  assert.match(modal, /validateRegisterStep1\(/);
  assert.match(modal, /반은 나중에 배정/);
  assert.match(modal, /void submit\(true\)/, "정원 경고 → «그래도 등록»은 force");
  assert.match(modal, /allowDuplicate: duplicateAck/);
  assert.match(modal, /previewRegularTuition\(/);
  assert.match(modal, /<AdminModal /);
  assert.doesNotMatch(modal, /#[0-9a-fA-F]{3,6}\b|bg-(red|blue|green|gray|emerald|orange)-\d/, "하드코딩 색 금지");
  assert.doesNotMatch(modal, /lucide-react/);
  assert.doesNotMatch(modal, /text-\[1[01]px\]/, "글자 12px 이상");
  assert.doesNotMatch(modal, /toISOString\(\)\.slice/);
});

test("[화면] 체험 ⚡ «원생 등록»은 체험을 마쳤고 원생·신청서가 없을 때만", () => {
  assert.match(trialClient, /\(lead\.status === "ATTENDED" \|\| lead\.status === "CONVERTED"\) && !lead\.convertedStudentId && !lead\.enrollApplicationReceivedAt/);
  assert.match(trialClient, /key: "register-student", label: "원생 등록"[^}]*onSelect: \(\) => setShowConvertModal\(lead\)/);
});
