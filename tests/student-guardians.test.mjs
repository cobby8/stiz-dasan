import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 학생 상세 「보호자」 카드(보호자 여러 명 등록) — 2026-10-03 원장 지시
// 「보호자 번호를 여러 개 등록할 수 있도록 해서 둘 다 등록해줘(정하준: 엄마·할머니)」
// 순수 로직은 실제로 실행하고, 서버 액션의 안전장치(관리자 가드·IDOR)는 소스로 못박는다.

const logic = await loadTsModule("src/lib/guardians/guardianLogic.ts");
const actions = await readFile("src/app/actions/guardians.ts", "utf8");
const panel = await readFile("src/app/admin/students/[id]/GuardianPanel.tsx", "utf8");
const detail = await readFile("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");

test("전화번호는 숫자만으로 정규화한다(+82 국제번호 포함)", () => {
  assert.equal(logic.normalizeGuardianPhone("010-1234-5678"), "01012345678");
  assert.equal(logic.normalizeGuardianPhone(" 010 1234 5678 "), "01012345678");
  assert.equal(logic.normalizeGuardianPhone("+82 10-1234-5678"), "01012345678");
  assert.equal(logic.normalizeGuardianPhone("+82 010-1234-5678"), "01012345678");
  assert.equal(logic.normalizeGuardianPhone(null), "");
});

test("자리채움·짧은·이상한 번호는 거부한다", () => {
  assert.equal(logic.isValidGuardianPhone("01012345678"), true);
  assert.equal(logic.isValidGuardianPhone("0212345678"), true);
  assert.equal(logic.isValidGuardianPhone("00000000000"), false);
  assert.equal(logic.isValidGuardianPhone("0101234"), false);
  assert.equal(logic.isValidGuardianPhone("11012345678"), false);
  assert.equal(logic.isValidGuardianPhone("010123456789"), false);
});

test("표시 형식은 하이픈을 붙인다", () => {
  assert.equal(logic.formatGuardianPhone("01012345678"), "010-1234-5678");
  assert.equal(logic.formatGuardianPhone("010-1234-5678"), "010-1234-5678");
  assert.equal(logic.formatGuardianPhone("0311234567"), "031-123-4567");
  assert.equal(logic.formatGuardianPhone("021234567"), "02-123-4567");
  assert.equal(logic.formatGuardianPhone("0212345678"), "02-1234-5678");
  assert.equal(logic.formatGuardianPhone(null), "");
});

test("입력 검증: 관계·전화 필수, 이름은 비우면 관계로 채운다", () => {
  const ok = logic.validateGuardianInput({ relation: " 조모 ", name: "", phone: "010-3217-0000" }, []);
  assert.deepEqual(ok, { ok: true, value: { relation: "조모", name: "조모", phone: "01032170000" } });

  const named = logic.validateGuardianInput({ relation: "모", name: "김엄마", phone: "01011112222" }, []);
  assert.equal(named.ok && named.value.name, "김엄마");

  assert.equal(logic.validateGuardianInput({ relation: "", name: "", phone: "01011112222" }, []).ok, false);
  assert.equal(logic.validateGuardianInput({ relation: "모", name: "", phone: "" }, []).ok, false);
  assert.equal(logic.validateGuardianInput({ relation: "모", name: "", phone: "abc" }, []).ok, false);
  assert.equal(logic.validateGuardianInput({ relation: "가".repeat(21), name: "", phone: "01011112222" }, []).ok, false);
  assert.equal(logic.validateGuardianInput({ relation: "모", name: "가".repeat(41), phone: "01011112222" }, []).ok, false);
  assert.equal(logic.validateGuardianInput(null, []).ok, false);
});

test("같은 학생 안 중복 번호는 형식이 달라도 막고, 자기 자신 수정은 허용한다", () => {
  const existing = [{ id: "g1", phone: "010-1111-2222" }, { id: "g2", phone: null }];
  const dup = logic.validateGuardianInput({ relation: "조모", name: "", phone: "01011112222" }, existing);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /이미 등록된/);
  const self = logic.validateGuardianInput({ relation: "모", name: "", phone: "01011112222" }, existing, "g1");
  assert.equal(self.ok, true);
});

test("주 보호자 계산: 첫 보호자는 자동, 이후는 체크했을 때만", () => {
  assert.equal(logic.shouldBePrimaryOnAdd(0, false), true);
  assert.equal(logic.shouldBePrimaryOnAdd(1, false), false);
  assert.equal(logic.shouldBePrimaryOnAdd(1, true), true);
  assert.equal(logic.canAddGuardian(logic.MAX_GUARDIANS_PER_STUDENT - 1), true);
  assert.equal(logic.canAddGuardian(logic.MAX_GUARDIANS_PER_STUDENT), false);
});

test("정렬은 주 보호자 먼저, 그다음 등록순(다른 화면의 대표 번호 선택과 같은 순서)", () => {
  const list = [
    { id: "b", isPrimary: false, createdAt: "2026-10-02T00:00:00Z" },
    { id: "c", isPrimary: true, createdAt: "2026-10-03T00:00:00Z" },
    { id: "a", isPrimary: false, createdAt: "2026-10-01T00:00:00Z" },
  ];
  assert.deepEqual(logic.sortGuardians(list).map((g) => g.id), ["c", "a", "b"]);
});

test("주 보호자를 지우면 가장 먼저 등록된 사람이 이어받는다", () => {
  const list = [
    { id: "p", isPrimary: true, createdAt: "2026-01-01T00:00:00Z" },
    { id: "late", isPrimary: false, createdAt: "2026-10-03T00:00:00Z" },
    { id: "early", isPrimary: false, createdAt: "2026-05-01T00:00:00Z" },
  ];
  assert.equal(logic.nextPrimaryAfterDelete(list, "p"), "early");
  assert.equal(logic.nextPrimaryAfterDelete(list, "late"), null, "주 보호자가 아니면 바꿀 것 없음");
  assert.equal(logic.nextPrimaryAfterDelete([list[0]], "p"), null, "마지막 1명 삭제");
  assert.equal(logic.nextPrimaryAfterDelete(list, "없는id"), null);
  // 기존 데이터에 주 보호자가 둘이었던 경우 — 남은 쪽이 이미 주 보호자면 손대지 않는다
  const twoPrimaries = [{ ...list[0] }, { id: "p2", isPrimary: true, createdAt: "2026-02-01T00:00:00Z" }];
  assert.equal(logic.nextPrimaryAfterDelete(twoPrimaries, "p"), null);
});

test("마지막 보호자 삭제 확인창에는 경고가 붙는다", () => {
  const last = logic.deleteConfirmMessage({ relation: "모", name: "모" }, 1);
  assert.match(last, /마지막 보호자/);
  const normal = logic.deleteConfirmMessage({ relation: "조모", name: "김할머니" }, 2);
  assert.doesNotMatch(normal, /마지막/);
  assert.match(normal, /조모 김할머니/);
});

test("서버 액션: 모든 export 함수가 첫 줄에서 requireAdmin 을 부른다", () => {
  assert.match(actions, /^"use server";/);
  const fns = [...actions.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*\n\s*([^\n]+)/g)];
  assert.ok(fns.length >= 5, "목록·추가·수정·삭제·주 보호자 지정 5개");
  for (const [, name, firstLine] of fns) {
    assert.match(firstLine, /await requireAdmin\(\);/, `${name} 첫 줄에 관리자 가드가 없다`);
  }
});

test("서버 액션: 수정·삭제·주 보호자 지정은 보호자 id 와 학생 id 를 함께 건다(IDOR 방지)", () => {
  assert.match(actions, /UPDATE "Guardian" SET relation = \$1, name = \$2, phone = \$3, "updatedAt" = NOW\(\)\s+WHERE id = \$4 AND "studentId" = \$5/);
  assert.match(actions, /DELETE FROM "Guardian" WHERE id = \$1 AND "studentId" = \$2/);
  assert.match(actions, /SELECT id FROM "Guardian" WHERE id = \$1 AND "studentId" = \$2/);
  // 주 보호자 지정은 같은 학생 범위 안에서 한 문장으로 "이 사람만 true"
  assert.match(actions, /SET "isPrimary" = \(id = \$1\)[\s\S]*WHERE "studentId" = \$2/);
  // ORM 기본 메서드 금지(PgBouncer)
  assert.doesNotMatch(actions, /prisma\.guardian\.|tx\.guardian\./);
});

test("주 보호자 지정이 로그인 계정(User) 전화를 바꾸지 않는다", () => {
  assert.doesNotMatch(actions, /UPDATE "User"/);
  assert.doesNotMatch(actions, /"parentId"/);
});

test("학생 상세에 보호자 카드가 붙어 있고, 계정 전화는 읽기 전용으로 보인다", () => {
  assert.match(detail, /import GuardianPanel from "\.\/GuardianPanel";/);
  assert.match(detail, /<GuardianPanel studentId=\{student\.id\} accountPhone=\{student\.parent\.phone \?\? null\} \/>/);
  assert.match(panel, /로그인 계정 전화/);
  assert.match(panel, /href=\{`tel:/);
  assert.match(panel, /window\.confirm\(deleteConfirmMessage\(/);
});
