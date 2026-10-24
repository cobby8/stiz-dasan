import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sms = fs.readFileSync("src/lib/sms.ts", "utf8");

test("Solapi bulk sender uses the detailed send-many API with safe correlation fields", () => {
  assert.match(sms, /messages\/v4\/send-many\/detail/);
  assert.match(sms, /showMessageList:\s*true/);
  assert.match(sms, /allowDuplicates:\s*false/);
  assert.match(sms, /customFields:\s*\{\s*deliveryId: delivery\.deliveryId\s*\}/);
  assert.match(sms, /deliveries\.length > 500/);
});

test("bulk response distinguishes accepted, explicit failures, and omitted uncertain deliveries", () => {
  assert.match(sms, /json\?\.messageList/);
  assert.match(sms, /json\?\.failedMessageList/);
  assert.match(sms, /status:\s*"ACCEPTED"/);
  assert.match(sms, /status:\s*"FAILED"/);
  assert.match(sms, /status:\s*"UNCERTAIN"/);
  assert.match(sms, /response omitted this delivery/);
  assert.match(sms, /response\.status >= 400 && response\.status < 500[\s\S]*?"FAILED"[\s\S]*?"UNCERTAIN"/);
  assert.match(sms, /solapiGroupId\(json\)/);
  assert.match(sms, /json\?\.groupInfo/);
});

test("timeouts remain uncertain and Bizppurio keeps the sequential fallback", () => {
  assert.match(sms, /AbortError[\s\S]*?deliveries\.map[\s\S]*?status:\s*"UNCERTAIN"/);
  assert.match(sms, /for \(const delivery of deliveries\)[\s\S]*?sendSmsDetailed\(delivery\.to, body, options\)/);
});

test("Solapi group result lookup paginates and exposes final provider status", () => {
  assert.match(sms, /export async function getSolapiBatchResults/);
  assert.match(sms, /messages\/v4\/list/);
  assert.match(sms, /url\.searchParams\.set\("groupId", groupId\)/);
  assert.match(sms, /url\.searchParams\.set\("startKey", startKey\)/);
  assert.match(sms, /statusCode === "4000"[\s\S]*?"SUCCESS"/);
  assert.match(sms, /"PENDING"/);
  assert.match(sms, /solapiMessageEntries\(json\?\.messageList\)/);
  assert.match(sms, /Object\.entries\(value as JsonObject\)/);
});
