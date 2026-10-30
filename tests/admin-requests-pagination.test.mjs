import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const adminReadPayloads = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const requestsRoute = readFileSync(new URL("../src/app/api/admin/requests/route.ts", import.meta.url), "utf8");
const requestsClient = readFileSync(new URL("../src/app/admin/requests/RequestsAdminClient.tsx", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

test("admin requests first payload is limited and paginated", () => {
  assert.match(adminReadPayloads, /const ADMIN_REQUESTS_PAGE_SIZE = 30/);
  assert.match(adminReadPayloads, /getAllRequests\(\{ statusFilter, limit, offset \}\)/);
  assert.match(adminReadPayloads, /getAdminRequestStatusCounts/);
  assert.match(adminReadPayloads, /buildListPagination/);
});

test("parent request query supports status, limit, and offset", () => {
  assert.match(queries, /statusFilter = typeof options === "string"/);
  assert.match(queries, /Math\.min\(Math\.floor\(options\.limit\), 100\)/);
  assert.match(queries, /OFFSET \$\{statusFilter \? "\$3" : "\$2"\}/);
});

test("admin requests api accepts status and next-page params", () => {
  assert.match(requestsRoute, /searchParams\.get\("status"\)/);
  assert.match(requestsRoute, /searchParams\.get\("limit"\)/);
  assert.match(requestsRoute, /searchParams\.get\("offset"\)/);
  assert.match(requestsRoute, /REQUEST_STATUSES\.has\(status\)/);
});

test("admin requests client loads filtered pages and appends more results", () => {
  // 목록 개편 6단계: 필터 탭 → 상태 칩(같은 filter 값을 바꾸고 그 상태 첫 페이지를 서버에서 다시 읽는다)
  assert.match(requestsClient, /function applyStatusFilter\(value: string\)[\s\S]*?setFilter\(value\);[\s\S]*?loadRequests\(\{ status: value, offset: 0 \}\)/);
  assert.match(requestsClient, /<StatusCountChips[\s\S]*?selected=\{filter\}[\s\S]*?onSelect=\{applyStatusFilter\}/);
  assert.match(requestsClient, /append: true/);
  assert.match(requestsClient, /offset: pagination\.nextOffset/);
  assert.match(requestsClient, /더 보기/);
});
