import test from "node:test";
import assert from "node:assert/strict";
import { shouldCollapseHeader } from "../src/lib/navigation/headerFit.ts";

const base = { available: 1100, brand: 250, navigation: 430, actions: 270, gap: 12 };

test("고정 PC 폭보다 좁아도 실제 메뉴가 들어가면 펼친다", () => {
  assert.equal(shouldCollapseHeader(base, true), false);
  assert.equal(shouldCollapseHeader({ ...base, available: 1000 }, true), false);
});

test("같은 헤더 폭에서도 계정 버튼이 넓어져 공간이 부족하면 접는다", () => {
  assert.equal(shouldCollapseHeader(base, false), false);
  assert.equal(shouldCollapseHeader({ ...base, actions: 460 }, false), true);
});

test("큰 글씨도 정해진 화면 폭이 아니라 실제 메뉴 너비로 판정한다", () => {
  assert.equal(shouldCollapseHeader({ ...base, navigation: 600 }, false), true);
  assert.equal(shouldCollapseHeader({ ...base, available: 1200, navigation: 600 }, true), false);
});

test("경계의 작은 오차에서는 현재 모드를 유지하고 충분해지면 다시 펼친다", () => {
  const required = 250 + 430 + 270 + 24 + 4;
  assert.equal(shouldCollapseHeader({ ...base, available: required }, false), false);
  assert.equal(shouldCollapseHeader({ ...base, available: required - 1 }, false), true);
  assert.equal(shouldCollapseHeader({ ...base, available: required + 3 }, true), true);
  assert.equal(shouldCollapseHeader({ ...base, available: required + 4 }, true), false);
});

test("측정 전이나 잘못된 크기에서는 겹친 메뉴를 노출하지 않는다", () => {
  for (const sizes of [{ ...base, available: 0 }, { ...base, navigation: 0 }, { ...base, gap: -1 }, { ...base, actions: NaN }]) {
    assert.equal(shouldCollapseHeader(sizes, false), true);
  }
});
