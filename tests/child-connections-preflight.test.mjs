import assert from "node:assert/strict";
import test from "node:test";
import { CHILD_CONNECTION_COLUMNS, CHILD_CONNECTION_INDEXES, findChildConnectionIssues, main } from "../scripts/child-connections-db-preflight.mjs";

function ready() {
  return {
    columns: Object.entries(CHILD_CONNECTION_COLUMNS).flatMap(([table_name, cols]) => cols.map(column_name => ({ table_name, column_name }))),
    indexes: CHILD_CONNECTION_INDEXES.map(index_name => ({ index_name })),
    security: Object.keys(CHILD_CONNECTION_COLUMNS).map(table_name => ({ table_name, rls_enabled: true, rls_forced: true })),
    privileges: [],
  };
}
const configured = { CHILD_CONNECTIONS_ENABLED: "true", CHILD_CONNECTIONS_SECRET: "fixture-secret", PORTONE_V2_API_SECRET: "fixture-provider", NEXT_PUBLIC_PORTONE_STORE_ID: "fixture-store", NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY: "fixture-channel" };

test("자녀 연결 비활성화 시 DB에 접속하지 않는다", async () => {
  let calls = 0;
  assert.equal(await main({}, async () => { calls++; throw new Error("접속 금지"); }, { log() {}, error() {} }), 0);
  assert.equal(calls, 0);
});

test("필수 구조·강제 보안·직접 접근 차단이 모두 준비됐을 때만 통과한다", () => {
  assert.deepEqual(findChildConnectionIssues(ready()), []);
  for (const missing of ["columns", "indexes", "security"]) {
    const state = ready(); state[missing] = [];
    assert.ok(findChildConnectionIssues(state).length, missing);
  }
  const state = ready(); state.security[0].rls_forced = false;
  assert.ok(findChildConnectionIssues(state).some(issue => issue.includes("접근 차단")));
  for (const grantee of ["PUBLIC", "anon", "authenticated"]) {
    const exposed = ready(); exposed.privileges.push({ grantee });
    assert.ok(findChildConnectionIssues(exposed).some(issue => issue.includes("직접 접근")));
  }
});

test("조회 실패나 불완전 구조는 활성 배포를 막고 연결 주소 원문은 출력하지 않는다", async () => {
  const messages = []; const output = { log: value => messages.push(value), error: value => messages.push(value) };
  assert.equal(await main({ ...configured, DIRECT_URL: "private-test-url" }, async () => { throw new Error("private-test-url"); }, output), 1);
  assert.ok(!messages.join(" ").includes("private-test-url"));
  assert.equal(await main(configured, async () => ["누락"], output), 1);
  assert.equal(await main(configured, async () => [], output), 0);
});

test("기능 활성화 때 인증 설정이 빠져 있으면 DB 검사 전 차단한다", async () => {
  for (const key of ["CHILD_CONNECTIONS_SECRET", "PORTONE_V2_API_SECRET", "NEXT_PUBLIC_PORTONE_STORE_ID", "NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY"]) {
    const env = { ...configured }; delete env[key];
    let queried = false;
    assert.equal(await main(env, async () => { queried = true; return []; }, { log() {}, error() {} }), 1);
    assert.equal(queried, false, key);
  }
});
