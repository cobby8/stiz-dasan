import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 체험·수강 신청 알림 문자에 넣는 연락처 저장용 이름(`2610 이성빈 목7 초6`).
// 원장님이 이 한 줄을 그대로 복사해 학부모 번호를 저장한다(2026-10-23 요청).

const { slotKeysToShortLabel, kstYymm, buildContactSaveName } =
  await loadTsModule("src/lib/contactSaveName.ts");

const at = (iso) => new Date(iso).getTime();

test("수업 키를 요일+교시로 줄인다", () => {
  assert.equal(slotKeysToShortLabel("Thu-7"), "목7");
  assert.equal(slotKeysToShortLabel("Tue-6,Thu-6"), "화6목6");
  // 입력 순서와 무관하게 요일 순서로 붙인다
  assert.equal(slotKeysToShortLabel("Thu-6, Tue-6"), "화6목6");
  assert.equal(slotKeysToShortLabel(["Sat-3", "Mon-10"]), "월10토3");
  // 같은 반 중복·모르는 형식은 버린다
  assert.equal(slotKeysToShortLabel("Thu-7,Thu-7,abc"), "목7");
  assert.equal(slotKeysToShortLabel(""), "");
  assert.equal(slotKeysToShortLabel(null), "");
});

test("yymm 은 한국 시간 기준 신청한 달이다 (서버 UTC 함정)", () => {
  assert.equal(kstYymm(at("2026-10-23T03:00:00Z")), "2610");
  // KST 11/1 00:30 = UTC 10/31 15:30 — UTC 로 계산하면 2610 이 나온다
  assert.equal(kstYymm(at("2026-10-31T15:30:00Z")), "2611");
  // 연말 경계: KST 2027-01-01 08:59 = UTC 2026-12-31 23:59
  assert.equal(kstYymm(at("2026-12-31T23:59:00Z")), "2701");
  // KST 12/31 23:59 는 아직 12월
  assert.equal(kstYymm(at("2026-12-31T14:59:00Z")), "2612");
});

test("저장용 이름 한 줄을 만든다", () => {
  const nowMs = at("2026-10-23T03:00:00Z");
  assert.equal(
    buildContactSaveName({ childName: "이성빈", childGrade: "초6", slotKeys: "Thu-7", nowMs }),
    "2610 이성빈 목7 초6",
  );
  assert.equal(
    buildContactSaveName({ childName: "홍길동", childGrade: "초4", slotKeys: "Thu-6,Tue-6", nowMs }),
    "2610 홍길동 화6목6 초4",
  );
  // 반·학년이 없으면 그 칸만 빠진다(공백 두 칸이 생기지 않는다)
  assert.equal(buildContactSaveName({ childName: " 김하늘 ", nowMs }), "2610 김하늘");
  assert.equal(buildContactSaveName({ childName: "김하늘", childGrade: "중1", nowMs }), "2610 김하늘 중1");
});

test("체험·수강 신청 알림이 저장용 이름을 문자 변수로 넘긴다", async () => {
  const source = await readFile("src/app/actions/public.ts", "utf8");
  const matches = source.match(/contactSaveName: buildContactSaveName\(/g) ?? [];
  assert.equal(matches.length, 2);
});
