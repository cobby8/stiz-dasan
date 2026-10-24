import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/app/admin/sms/SmsClient.tsx", "utf8");

test("수동 문자 UI는 대량 발송 접수에 requestId를 전달한다", () => {
    assert.match(source, /requestIdRef = useRef<string \| null>/);
    assert.match(source, /crypto\.randomUUID\(\)/);
    assert.match(source, /enqueueManualSmsBatch\(targetRecipients, message\.trim\(\), \{ requestId \}\)/);
});

test("불확실·처리 중 발송은 재발송에서 제외한다", () => {
    assert.match(source, /발송 여부를 확인할 수 없는/);
    assert.match(source, /처리 중인 문자는 재발송할 수 없습니다/);
    assert.doesNotMatch(source, /retryRecipients/);
});

test("공급자 접수와 최종 발송 완료를 구분한다", () => {
    assert.match(source, /providerStatus\?: string \| null/);
    assert.match(source, /Solapi 접수/);
    assert.match(source, /학부모 휴대폰의 최종 발송 성공과는 다릅니다/);
    assert.match(source, /item\.status === "SENT" \? "최종 성공"/);
});

test("대량 발송 중 입력을 잠그고 페이지 이탈을 경고한다", () => {
    assert.match(source, /beforeunload/);
    assert.match(source, /disabled=\{batchIsActive\}/);
    assert.match(source, /화면을 닫지 마세요/);
});

test("자동 발송은 가짜 기본값 대신 실패 차단 상태를 표시한다", () => {
    assert.doesNotMatch(source, /DEFAULT_RULES/);
    assert.match(source, /안전을 위해 설정을 임의로 표시하거나 발송하지 않습니다/);
    assert.match(source, /다시 불러오기/);
});
