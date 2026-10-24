import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/lib/uniform-partner.ts", import.meta.url), "utf8");
const transformed = source
  .replace(/import crypto from "node:crypto";/, 'const crypto = require("node:crypto");')
  .replace(/export /g, "");
const js = ts.transpileModule(transformed, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleBox = { exports: {} };
new Function("require", "module", "exports", `${js}; module.exports = {
  canonicalJson,
  normalizeUniformOrderInput,
  buildStizUniformOrderPayload,
  signStizPartnerPayload
};`)(require, moduleBox, moduleBox.exports);

const {
  canonicalJson,
  normalizeUniformOrderInput,
  buildStizUniformOrderPayload,
  signStizPartnerPayload,
} = moduleBox.exports;

test("STIZ 본사 서명용 JSON은 객체 키를 재귀 정렬한다", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] }),
    '{"a":{"a":1,"b":2},"list":[{"x":1,"y":2}],"z":1}',
  );
});

test("유니폼 신청은 형제자매를 한 주문 payload의 items로 묶는다", () => {
  const normalized = normalizeUniformOrderInput({
    parentName: "김보호",
    parentPhone: "01012345678",
    agreedPrivacy: true,
    students: [
      { studentName: "김첫째", design: "DYG 블랙&화이트", initials: "FIRST", backNumber: "7", topSize: "M", bottomSize: "M" },
      { studentName: "김둘째", design: "카툰 블랙&화이트", initials: "SECOND", topSize: "S" },
    ],
  });
  const payload = buildStizUniformOrderPayload({
    partnerRequestId: "dasan-uniform-test",
    parentName: normalized.parentName,
    parentPhone: normalized.parentPhone,
    memo: normalized.memo,
    students: normalized.students,
  });

  assert.equal(payload.customer.phone, "010-1234-5678");
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].quantity, 2);
  assert.equal(payload.items[0].options["디자인"], "DYG 블랙&화이트");
  assert.equal(payload.items[0].options["이니셜"], "FIRST");
  assert.equal(payload.items[1].options["디자인"], "카툰 블랙&화이트");
  assert.equal(payload.items[1].options["이니셜"], "SECOND");
  assert.equal(payload.items[1].quantity, 1);
  assert.equal("productId" in payload, false);
  assert.equal("orderNumber" in payload, false);
});

test("HMAC 서명은 timestamp.partner.canonicalJson 순서로 만든다", () => {
  const payload = buildStizUniformOrderPayload({
    partnerRequestId: "dasan-uniform-test",
    parentName: "김보호",
    parentPhone: "010-1234-5678",
    memo: null,
    students: [{
      studentName: "김학생",
      design: "DYG 블랙&화이트",
      initials: "STIZ",
      backNumber: null,
      topSize: "M",
      bottomSize: "M",
      quantity: 2,
    }],
  });
  const secret = "a".repeat(64);
  const timestamp = 1788150000;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.dasan.${canonicalJson(payload)}`, "utf8")
    .digest("hex");

  assert.equal(signStizPartnerPayload({ secret, timestamp, payload }), expected);
});
