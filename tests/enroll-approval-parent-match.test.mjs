import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 실제 사고(2026-08~09, 4가족): 신청 승인이 학부모를 전화번호 '글자 그대로' 찾는데
// 신청서는 '010-1234-5678', 가입 계정은 '01012345678' 로 저장된다. 그래서 번호가
// 바뀌지 않아도 기존 학부모를 못 찾고 계정·학생을 새로 만들었고,
// **학부모가 로그인하는 계정에는 자녀가 0명**으로 남았다(앱에서 아무것도 안 보임).
// 2026-09-18 실측: 학부모 계정 314개 중 284개(90%)가 숫자만 형식.

const { parentPhoneDigits, isUsablePhoneKey } = await loadTsModule("src/lib/enrollment/parentIdentity.ts");
const admin = await readFile("src/app/actions/admin.ts", "utf8");
const approvalParent = await readFile("src/lib/enrollment/approval-parent.ts", "utf8");

test("전화번호는 숫자만 남겨서 비교한다", () => {
  assert.equal(parentPhoneDigits("010-1234-5678"), "01012345678");
  assert.equal(parentPhoneDigits("01012345678"), "01012345678");
  assert.equal(parentPhoneDigits(" 010 1234 5678 "), "01012345678");
  assert.equal(parentPhoneDigits("+82 10-1234-5678"), "821012345678");
  assert.equal(parentPhoneDigits(null), "");
  assert.equal(parentPhoneDigits(undefined), "");
  // 두 형식이 같은 사람으로 판정돼야 한다 — 이게 사고의 핵심이었다.
  assert.equal(parentPhoneDigits("010-1234-5678"), parentPhoneDigits("01012345678"));
});

test("빈 번호·자리채움 번호는 사람을 찾는 열쇠로 쓰지 않는다", () => {
  // 번호가 비어 있는 학부모 계정이 20개 있다. 숫자만 남기면 전부 ''가 되어
  // 서로 같은 사람으로 묶이고, 남의 자녀가 붙는다.
  assert.equal(isUsablePhoneKey(""), false);
  assert.equal(isUsablePhoneKey("0101234"), false, "너무 짧은 번호");
  assert.equal(isUsablePhoneKey("00000000000"), false, "시트 임포트의 자리채움 번호");
  assert.equal(isUsablePhoneKey("11111111111"), false);
  assert.equal(isUsablePhoneKey("821012345678"), false, "국가번호 포함 12자리는 열쇠로 쓰지 않는다");
  assert.equal(isUsablePhoneKey("01012345678"), true);
  assert.equal(isUsablePhoneKey("0312345678"), true, "지역번호 10자리");
});

test("학부모를 찾는 모든 경로가 글자 그대로 비교하지 않는다", async () => {
  // 되돌아가면 4가족 사고가 그대로 재현된다.
  // 승인·엑셀 일괄등록·시트 임포트 세 곳이 같은 결함을 갖고 있었다(2026-09-28 전수 확인).
  const files = ["src/app/actions/admin.ts", "src/app/api/admin/import-students/route.ts"];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /WHERE phone = \$\d+ AND role = 'PARENT'/,
      `${file} — 글자 그대로 비교로 되돌아갔습니다`,
    );
  }
  const digitsCompare = /regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\) = \$1/g;
  assert.ok(digitsCompare.test(admin), "엑셀 숫자 비교 유지");
  assert.match(approvalParent, /regexp_replace\(COALESCE\(phone/);
  assert.match(approvalParent, /isUsablePhoneKey\(digits\)/);
});

test("명시 연결을 먼저 지키고 직원·복수 후보는 직접 선택한다", () => {
  assert.match(approvalParent, /app\.parentUserId \?\? app\.parentuserid/);
  assert.match(approvalParent, /linked && selectedId && linked !== selectedId/);
  assert.match(approvalParent, /const wanted = selectedId \|\| linked/);
  assert.match(approvalParent, /throw new ParentSelectionRequired/);
  assert.doesNotMatch(approvalParent, /LIMIT 1/);
});

test("새로 만드는 계정은 숫자만 형식으로 저장한다", () => {
  // 가입 경로와 형식을 맞춰야 다음 조회가 또 어긋나지 않는다.
  assert.match(admin, /parent_\$\{parentPhoneDigitsValue\}@stiz\.local/);
  assert.match(admin, /parentPhoneDigitsValue \|\| parentPhone,/);
});

test("학생 중복 생성을 막는 기존 방어는 그대로 남아 있다", () => {
  assert.match(admin, /STUDENT_AMBIGUOUS/, "동명 형제는 자동 선택하지 않는다");
  assert.match(admin, /fallback\.length === 1/, "단일 학생은 재사용한다");
});
