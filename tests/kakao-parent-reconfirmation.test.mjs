import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildKakaoReconfirmationPayload,
  kakaoReconfirmationPayloadHash,
  kakaoReconfirmationTokenHash,
} from "../src/lib/kakao-parent-reconfirmation.ts";

const base = {
  intakeId: "intake-1",
  requestId: "request-1",
  commandId: "command-1",
  studentId: "student-1",
  kind: "CLASS_CHANGE",
  afterJson: {
    effectiveDate: "2026-09-10",
    fromClassId: "class-a",
    toClassId: "class-b",
    shuttleIntent: null,
    details: "화요일 수업으로 변경",
  },
  fromClass: { id:"class-a", programName:"초등 5학년", className:"기초반", dayOfWeek:"목", startTime:"17:00", endTime:"18:20" },
  toClass: { id:"class-b", programName:"초등 5학년", className:"기초반", dayOfWeek:"화", startTime:"17:00", endTime:"18:20" },
};

test("재확인 payload는 안정 ID와 관리자가 확정한 필드만 고정한다", () => {
  assert.deepEqual(buildKakaoReconfirmationPayload(base), {
    intakeId: "intake-1", requestId: "request-1", commandId: "command-1", studentId: "student-1",
    kind: "CLASS_CHANGE", effectiveDate: "2026-09-10", fromClassId: "class-a", toClassId: "class-b",
    shuttleIntent: null, details: "화요일 수업으로 변경",
    fromClass: base.fromClass, toClass: base.toClass,
  });
  assert.equal(buildKakaoReconfirmationPayload({ ...base, studentId: null }), null);
});

test("재확인 대상이 바뀌면 payload 해시도 달라진다", () => {
  const first = buildKakaoReconfirmationPayload(base);
  const second = buildKakaoReconfirmationPayload({
    ...base,
    afterJson: { ...base.afterJson, toClassId: "class-c" },
    toClass: { ...base.toClass, id: "class-c" },
  });
  assert.ok(first && second);
  assert.notEqual(kakaoReconfirmationPayloadHash(first), kakaoReconfirmationPayloadHash(second));
  assert.equal(kakaoReconfirmationTokenHash("raw-token"), kakaoReconfirmationTokenHash("raw-token"));
  assert.notEqual(kakaoReconfirmationTokenHash("raw-token"), kakaoReconfirmationTokenHash("other-token"));
});

test("같은 이름 반도 프로그램·요일·시간 스냅샷 변경 시 기존 링크가 무효화된다", () => {
  const original = buildKakaoReconfirmationPayload(base);
  const changedTime = buildKakaoReconfirmationPayload({ ...base, toClass: { ...base.toClass, startTime:"18:30", endTime:"19:50" } });
  assert.ok(original && changedTime);
  assert.notEqual(kakaoReconfirmationPayloadHash(original), kakaoReconfirmationPayloadHash(changedTime));
});

test("카카오 다음 메시지는 필요한 경우에만 일회용 재확인 링크를 발급한다", async () => {
  const source = await readFile("src/lib/kakao-parent-chatbot.ts", "utf8");
  assert.match(source, /parentReconfirmationRequired/);
  assert.match(source, /ParentOperationsRequestLink/);
  assert.match(source, /'KAKAO_RECONFIRMATION'/);
  assert.match(source, /KAKAO_RECONFIRMATION_LINK_ISSUED/);
  assert.match(source, /"tokenHash"/);
  assert.doesNotMatch(source, /"rawToken"|"token"\s*[,)]/);
  assert.match(source, /반영이나 알림 발송이 실행되지는 않아요/);
});

test("확정은 전체 관계와 exact payload를 잠근 뒤 확인 플래그와 감사만 갱신한다", async () => {
  const source = await readFile("src/app/actions/kakao-parent-reconfirmation.ts", "utf8");
  assert.match(source, /FOR UPDATE OF l,r,c,i,k/);
  assert.match(source, /l\.purpose='KAKAO_RECONFIRMATION'/);
  assert.match(source, /fromProgramName/);
  assert.match(source, /toProgramName/);
  assert.match(source, /kakaoReconfirmationPayloadHash\(payload\) !== row\.payloadHash/);
  assert.match(source, /parentConfirmed/);
  assert.match(source, /parentReconfirmationRequired/);
  assert.match(source, /lastUsedAt/);
  assert.match(source, /KAKAO_PARENT_RECONFIRMED/);
  assert.match(source, /externalWrites: false/);
  assert.doesNotMatch(source, /operationsSyncWorker|sendPush|sendSms|Rallyz|GoogleSheet/);
});

test("재확인 전용 링크는 일반 자연어 요청 링크로 사용할 수 없다", async () => {
  const source = await readFile("src/app/actions/parent-operations-request.ts", "utf8");
  const guards = source.match(/purpose='GENERAL'/g) ?? [];
  assert.ok(guards.length >= 3, "제출·미리보기·관리자 활성 링크 목록을 모두 분리해야 한다");
});

test("카카오 접수 감사에는 인증 보호자 actor를 필수 기록한다", async () => {
  const source = await readFile("src/app/actions/kakao-parent-reconfirmation.ts", "utf8");
  assert.match(source, /KakaoParentIntakeAudit[^`]*"actorUserId"/s);
  assert.match(source, /row\.parentUserId/);
});

test("링크 purpose 컬럼과 migration이 일반·재확인 용도를 DB에서 분리한다", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const migration = await readFile("prisma/migrations/20260904100000_add_parent_operations_link_purpose/migration.sql", "utf8");
  const infrastructure = await readFile("src/lib/operationsSyncInfrastructure.ts", "utf8");
  assert.match(schema, /purpose\s+String\s+@default\("GENERAL"\)/);
  assert.match(migration, /"purpose" TEXT NOT NULL DEFAULT 'GENERAL'/);
  assert.match(migration, /CHECK \("purpose" IN \('GENERAL', 'KAKAO_RECONFIRMATION'\)\)/);
  assert.match(infrastructure, /"purpose"/);
  assert.match(infrastructure, /20260904100000_add_parent_operations_link_purpose/);
});
