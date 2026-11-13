// 2026-11-14 사진·인스타 점검 — 게시가 «게시 처리 중»에 멈추던 결함의 상태 전이를 못박는다.
//
// 결함: 게시 예약이 먼저 status 를 PUBLISHING 으로 바꿔, 그 뒤 단계가 «다음 시도 시각»을 비운 채로 뒀다.
//       «시도 잡기»는 그 값이 있어야만 성공해서 인스타 호출 없이 «건너뜀»이 성공으로 돌아왔다.
// 고침: 원장이 인스타 게시를 누른 경로에서만 대기열을 켠다(ARM). 5분 크론은 켜진 초안만 집는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ARM_INSTAGRAM_QUEUE_SQL,
  CLAIM_INSTAGRAM_ATTEMPT_SQL,
  CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL,
  FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL,
  HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL,
  MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL,
  MARK_GALLERY_PUBLISHING_SQL,
  PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL,
  QUEUED_INSTAGRAM_DRAFTS_SQL,
  armInstagramQueue,
  attemptStateAfterException,
  attemptStateWhenProviderCallStarts,
  claimInstagramAttempt,
  failDraftBeforeProviderCall,
  isInstagramApprovalPending,
  isQueuedForCron,
  markGalleryPublishing,
  shouldHaltCronRepublish,
} from "../src/lib/socialPublishQueueRules.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const drafts = read("../src/lib/socialDrafts.ts");
const publishing = read("../src/lib/socialPostPublishing.ts");
const actions = read("../src/app/actions/social-posts.ts");
const consent = read("../src/lib/studentMediaConsent.ts");
const cron = read("../src/app/api/cron/social-posts/route.ts");

const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);
const MINUTE = 60 * 1000;

// 게시 예약 직후의 초안: 예약이 status 를 PUBLISHING 으로 바꾸고, 새 초안은 «다음 시도 시각»이 비어 있다.
const afterReservation = () => ({ status: "PUBLISHING", nextRetryAt: null, attempts: 0 });

test("결함 재현: 대기열을 켜지 않으면 «시도 잡기»가 실패해 인스타를 호출하지 못한다", () => {
  // 게시 예약이 PUBLISHING 으로 바꾼다는 전제 — 이 줄이 바뀌면 아래 재현이 의미를 잃는다.
  assert.match(consent, /UPDATE "SocialPostDraft" SET status='PUBLISHING', "publicationSubjectsJSON"=\$2/);
  // 갤러리 단계는 이미 PUBLISHING 이면 «다음 시도 시각»을 그대로(비어 있는 채로) 둔다.
  // 2026-11-14 검수 필수 1: 다른 상태에서 들어와도 켜지 않는다(ELSE NULL) — 옛 ELSE NOW() 는 원장 승인 없이 켜는 두 번째 길이었다.
  assert.match(MARK_GALLERY_PUBLISHING_SQL, /"instagramNextRetryAt" = CASE WHEN status = 'PUBLISHING' THEN "instagramNextRetryAt" ELSE NULL END/);
  assert.equal(markGalleryPublishing(afterReservation()).nextRetryAt, null);

  assert.equal(claimInstagramAttempt(afterReservation(), NOW), null, "켜지 않으면 잡지 못한다 = 예전에 멈추던 지점");
});

test("원장이 누르면: 대기열 켜기 → 시도 잡기 성공 → 인스타 호출로 진행", () => {
  const armed = armInstagramQueue(afterReservation(), NOW);
  assert.deepEqual(armed, { status: "PUBLISHING", nextRetryAt: NOW, attempts: 0 });

  const claimed = claimInstagramAttempt(armed, NOW);
  assert.ok(claimed, "켠 직후에는 잡을 수 있다");
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.nextRetryAt, NOW + 5 * MINUTE, "잡으면 5분 뒤로 밀린다");
});

test("중복 발행 방지: 한 번 잡힌 초안은 5분 안에 다시 잡히지 않고, 다시 켜도 바뀌지 않는다", () => {
  const claimed = claimInstagramAttempt(armInstagramQueue(afterReservation(), NOW), NOW);

  assert.equal(claimInstagramAttempt(claimed, NOW + 1000), null, "버튼을 두 번 눌러도 두 번째는 잡지 못한다");
  assert.equal(claimInstagramAttempt(claimed, NOW + 4 * MINUTE), null);
  assert.equal(isQueuedForCron(claimed, NOW + 4 * MINUTE), false, "크론도 5분 안에는 집지 않는다");

  // 진행 중인 초안을 원장이 다시 눌러도 «켜기»는 아무것도 바꾸지 않는다(시각을 앞당기지 않는다).
  assert.equal(armInstagramQueue(claimed, NOW + 1000), claimed);
});

test("원장이 누르지 않은 초안(부원장이 갤러리만 올림)은 크론이 집지 않는다", () => {
  const galleryOnly = afterReservation();
  assert.equal(isQueuedForCron(galleryOnly, NOW + 60 * MINUTE), false, "시간이 지나도 꺼진 대기열은 집지 않는다");
  assert.equal(claimInstagramAttempt(galleryOnly, NOW + 60 * MINUTE), null);
  assert.equal(isInstagramApprovalPending({ status: "PUBLISHING", instagramNextRetryAt: null }), true);
});

test("재시도 예약된 초안은 시각이 되면 크론이 집어 다시 잡는다", () => {
  const retryAt = NOW + MINUTE;
  const scheduled = { status: "PUBLISHING", nextRetryAt: retryAt, attempts: 1 };
  assert.equal(isQueuedForCron(scheduled, NOW), false, "아직 시각 전");
  assert.equal(isQueuedForCron(scheduled, retryAt), true);
  assert.equal(claimInstagramAttempt(scheduled, retryAt).attempts, 2);
});

test("다른 상태(검토 대기·실패·게시 완료·반려)는 켜지지도 잡히지도 않는다", () => {
  for (const status of ["READY", "FAILED", "PUBLISHED", "REJECTED", "DRAFT"]) {
    const state = { status, nextRetryAt: null, attempts: 0 };
    assert.equal(armInstagramQueue(state, NOW), state, `${status} 는 켜지 않는다`);
    assert.equal(claimInstagramAttempt({ ...state, nextRetryAt: NOW }, NOW), null, `${status} 는 잡지 않는다`);
    assert.equal(isQueuedForCron({ ...state, nextRetryAt: NOW }, NOW), false);
    assert.equal(isInstagramApprovalPending({ status, instagramNextRetryAt: null }), false);
  }
  // 진행 중(시각이 있음)은 «원장 확인 대기»가 아니다 — 화면이 버튼을 잠근다.
  assert.equal(isInstagramApprovalPending({ status: "PUBLISHING", instagramNextRetryAt: "2026-11-14T03:05:00.000Z" }), false);
});

test("SQL 이 순수 함수와 같은 조건을 쓴다", () => {
  // 켜기: PUBLISHING 이고 꺼져 있을 때만, 시도 횟수는 0 으로
  assert.match(ARM_INSTAGRAM_QUEUE_SQL, /"instagramNextRetryAt" = NOW\(\)/);
  assert.match(ARM_INSTAGRAM_QUEUE_SQL, /"instagramPublishAttempts" = 0/);
  assert.match(ARM_INSTAGRAM_QUEUE_SQL, /status = 'PUBLISHING'\s+AND "instagramNextRetryAt" IS NULL/);

  // 잡기: 켜져 있고 시각이 됐을 때만, 5분 뒤로 민다 — 조건을 느슨하게 풀지 않았다
  assert.match(CLAIM_INSTAGRAM_ATTEMPT_SQL, /status = 'PUBLISHING'\s+AND "instagramNextRetryAt" IS NOT NULL\s+AND "instagramNextRetryAt" <= NOW\(\)/);
  assert.match(CLAIM_INSTAGRAM_ATTEMPT_SQL, /"instagramNextRetryAt" = NOW\(\) \+ INTERVAL '5 minutes'/);
  assert.doesNotMatch(CLAIM_INSTAGRAM_ATTEMPT_SQL, /COALESCE\("instagramNextRetryAt"/);

  // 크론 목록: 켜진 것만(예전의 COALESCE(다음 시도 시각, 수정 시각)은 꺼진 초안도 집었다)
  assert.match(QUEUED_INSTAGRAM_DRAFTS_SQL, /status = 'PUBLISHING'\s+AND "instagramNextRetryAt" IS NOT NULL\s+AND "instagramNextRetryAt" <= NOW\(\)/);
  assert.doesNotMatch(QUEUED_INSTAGRAM_DRAFTS_SQL, /COALESCE/);

  // 결과 불명확: 대기열을 끄고 «재시도 필요»로
  assert.match(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, /status='FAILED', "instagramNextRetryAt"=NULL/);
});

test("연결: 초안 모듈은 규칙 SQL 을 쓰고, 대기열은 원장 경로에서만 켠다", () => {
  assert.match(drafts, /\$queryRawUnsafe<any\[\]>\(ARM_INSTAGRAM_QUEUE_SQL, id\)/);
  assert.match(drafts, /\$queryRawUnsafe<any\[\]>\(CLAIM_INSTAGRAM_ATTEMPT_SQL, id\)/);
  assert.match(drafts, /\$queryRawUnsafe<any\[\]>\(QUEUED_INSTAGRAM_DRAFTS_SQL, limit\)/);

  // 켜기는 «원장이 눌렀다»는 표시가 있을 때만, 그리고 «시도 잡기»보다 먼저
  assert.match(
    publishing,
    /if \(options\.queueMode && options\.ownerApproved\) \{\s*await armSocialPostDraftInstagramQueue\(id\);\s*\}[\s\S]{0,200}markSocialPostDraftPublishAttempt\(id\)/,
  );
  assert.equal(publishing.match(/armSocialPostDraftInstagramQueue\(/g).length, 1, "켜는 곳은 한 군데뿐");

  // 그 표시는 원장 확인(requireOwner)을 통과한 액션만 준다
  assert.match(
    actions,
    /export async function publishSocialPostDraftToInstagram\(id: string\) \{[\s\S]*?await requireOwner\(\);[\s\S]*?publishSocialDraftToInstagramNow\(id, \{ queueMode: true, ownerApproved: true \}\)/,
  );
  assert.equal(actions.match(/ownerApproved: true/g).length, 1);

  // 5분 크론과 갤러리 단계는 그 표시를 주지 않는다
  assert.match(publishing, /publishSocialDraftToInstagramNow\(draft\.id, \{ queueMode: true \}\)/);
  assert.doesNotMatch(cron, /ownerApproved/);
  const galleryAction = actions.slice(
    actions.indexOf("export async function publishSocialPostDraftToGallery"),
    actions.indexOf("export async function publishSocialPostDraftToInstagram"),
  );
  assert.doesNotMatch(galleryAction, /ownerApproved|armSocialPostDraftInstagramQueue/);
});

test("중복 발행 방지 장치는 그대로다: 시도 기록·불명확 시 자동 재발행 중단·동의 재확인", () => {
  assert.match(publishing, /withSocialDraftPublicationReservation\(id, "INSTAGRAM"/);
  assert.match(MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL, /SET state='AMBIGUOUS'/);
  assert.match(publishing, /자동 재발행을 중단/);
  assert.match(publishing, /await assertSocialDraftMediaConsent\(currentDraft, "INSTAGRAM"\);/);
  // 원장 버튼 경로에서도 결과가 불명확하면 대기열을 끈다(예전에는 크론 경로만 멈췄다)
  assert.match(publishing, /\$executeRawUnsafe\(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, id\);\s*throw error;/);
  // 인스타를 호출하지 않고 끝난 시도(아직 «예약됨»)만 일반 실패로 닫는다 — 호출을 시작한 시도는 건드리지 않는다
  assert.match(CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL, /SET state='FAILED'[\s\S]*WHERE id=\$1 AND state='PUBLISHING'/);
  assert.match(publishing, /async function closeAttemptWithoutProviderCall\(attemptId: string, reason: string\) \{\s*await prisma\.\$queryRawUnsafe\(CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL, attemptId, reason\);/);
  assert.equal(publishing.match(/await closeAttemptWithoutProviderCall\(/g).length, 3);
  const firstProviderCall = publishing.indexOf("await publishGalleryPostToInstagram(");
  assert.ok(publishing.lastIndexOf("await closeAttemptWithoutProviderCall(") < firstProviderCall, "건너뜀 정리는 인스타 호출보다 앞에서만");
});

test("건너뛴 것을 «게시 완료»로 알리지 않는다", () => {
  assert.match(publishing, /return \{ ok: skippedDraft\.status === "PUBLISHED", draft: skippedDraft, skipped: true as const \};/);
  const gallery = read("../src/app/admin/gallery/GalleryAdminClient.tsx");
  const quickPost = read("../src/app/staff/quick-post/QuickPostClient.tsx");
  for (const [name, source] of [["관리자 갤러리", gallery], ["빠른 업로드", quickPost]]) {
    assert.match(source, /result\.draft\.status === "PUBLISHED"\) \{\s*set(Draft)?Message\("홈페이지 갤러리와 인스타그램 게시가 완료됐습니다\."\)/, `${name}: 완료 문구는 실제 PUBLISHED 일 때만`);
    assert.match(source, /isInstagramApprovalPending\(draft\)/, `${name}: 원장 확인 대기 초안은 잠그지 않는다`);
  }
});

// ── 2026-11-14 검수 필수 1·2, 권장 1·2 ─────────────────────────────────────────

test("① 게시가 끝난 초안에 갤러리 단계가 늦게 다시 불려도 상태·대기열이 그대로다", () => {
  // 원장의 인스타 게시가 끝난 뒤(PUBLISHED) 다른 관리자의 갤러리 단계가 도착한 경우
  const published = { status: "PUBLISHED", nextRetryAt: NOW + 5 * MINUTE, attempts: 1 };
  assert.equal(markGalleryPublishing(published), published, "PUBLISHED 를 PUBLISHING 으로 되돌리지 않는다");
  assert.equal(isQueuedForCron(markGalleryPublishing(published), NOW + 60 * MINUTE), false, "크론이 다시 집지 않는다");

  const rejected = { status: "REJECTED", nextRetryAt: null, attempts: 0 };
  assert.equal(markGalleryPublishing(rejected), rejected, "반려된 초안도 되살리지 않는다");

  // 인스타 게시가 진행 중(시도를 잡은 상태)일 때 갤러리 단계가 불려도 잡힌 시각·횟수를 건드리지 않는다
  const inFlight = { status: "PUBLISHING", nextRetryAt: NOW + 5 * MINUTE, attempts: 1 };
  assert.equal(markGalleryPublishing(inFlight), inFlight);

  // 검토 대기·실패에서 들어오면 «게시 처리 중»이 되지만 대기열은 꺼진 채다 → 크론이 집지 않는다
  for (const status of ["READY", "FAILED"]) {
    const next = markGalleryPublishing({ status, nextRetryAt: null, attempts: 3 });
    assert.deepEqual(next, { status: "PUBLISHING", nextRetryAt: null, attempts: 0 });
    assert.equal(isQueuedForCron(next, NOW + 60 * MINUTE), false);
  }

  // SQL: 상태 조건이 있고, 대기열을 켜는 NOW() 가 없다
  assert.match(MARK_GALLERY_PUBLISHING_SQL, /WHERE id = \$2\s+AND status IN \('READY', 'FAILED', 'PUBLISHING'\)/);
  assert.doesNotMatch(MARK_GALLERY_PUBLISHING_SQL, /"instagramNextRetryAt" = [^,]*NOW\(\)/);
  // 연결: 바뀐 행이 없으면 지금 초안을 다시 읽어 돌려준다(없는 행을 변환하다 죽지 않는다)
  const fn = drafts.slice(drafts.indexOf("export async function markSocialPostDraftPublishing("), drafts.indexOf("export async function armSocialPostDraftInstagramQueue"));
  assert.match(fn, /\$queryRawUnsafe<any\[\]>\(MARK_GALLERY_PUBLISHING_SQL, data\.galleryPostId, id\);\s*if \(rows\[0\]\) return mapDraft\(rows\[0\]\);[\s\S]*?const current = await getSocialPostDraftById\(id\);[\s\S]*?return current;/);
  assert.doesNotMatch(fn, /return mapDraft\(rows\[0\]\);\s*\}\s*$/);
  // 대기열에 NOW() 를 넣어 켜는 SQL 은 초안 모듈에 남아 있지 않다(켜는 곳은 ARM 한 곳)
  assert.doesNotMatch(drafts, /"instagramNextRetryAt" = CASE[^\n]*ELSE NOW\(\)/);
  assert.equal([ARM_INSTAGRAM_QUEUE_SQL, MARK_GALLERY_PUBLISHING_SQL, QUEUED_INSTAGRAM_DRAFTS_SQL, FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL]
    .filter((sql) => /"instagramNextRetryAt" = NOW\(\)\s*,/.test(sql)).length, 1);
});

test("② 이전 시도가 결과 불명확·게시됨인 초안은 크론이 인스타를 부르지 않고 멈춘다", () => {
  // 서버 함수가 인스타 호출 도중 시간 초과로 죽은 경우: 시도는 AMBIGUOUS 로 남고 초안은 «5분 뒤 재시도»로 남는다
  assert.equal(shouldHaltCronRepublish(["AMBIGUOUS"]), true);
  // 인스타에는 올라갔는데 초안 기록이 실패한 경우
  assert.equal(shouldHaltCronRepublish(["FAILED", "PUBLISHED"]), true);
  // 정상 실패 뒤의 재시도·첫 시도는 그대로 진행
  assert.equal(shouldHaltCronRepublish(["FAILED", "FAILED"]), false);
  assert.equal(shouldHaltCronRepublish([]), false);
  // 아직 인스타를 부르지 않은 예약(PUBLISHING)은 멈출 이유가 아니다
  assert.equal(shouldHaltCronRepublish(["PUBLISHING"]), false);

  // SQL: 이 초안의 «다른» 인스타 시도만 본다(갤러리 시도의 PUBLISHED 와 섞이지 않는다)
  assert.match(PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL, /"draftId" = \$1 AND channel = 'INSTAGRAM' AND id <> \$2\s+AND state IN \('AMBIGUOUS', 'PUBLISHED'\)/);

  // 멈춘 초안은 대기열이 꺼져 크론이 다시 집지 않는다
  assert.match(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, /status='FAILED', "instagramNextRetryAt"=NULL/);

  // 연결: 크론 경로(원장이 방금 누른 것이 아님)에서, «시도 잡기»와 인스타 호출보다 앞에서 확인한다
  const guardAt = publishing.indexOf("if (options.queueMode && !options.ownerApproved) {");
  assert.ok(guardAt > 0);
  const guard = publishing.slice(guardAt, publishing.indexOf("if (options.queueMode && options.ownerApproved) {"));
  assert.match(guard, /PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL, id, attemptId,\s*\);\s*if \(prior\[0\]\) \{[\s\S]*?\$executeRawUnsafe\(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, id\);[\s\S]*?return \{\s*ok: false as const,/);
  assert.doesNotMatch(guard, /publishGalleryPostToInstagram|markSocialPostDraftPublishAttempt/);
  assert.ok(guardAt < publishing.indexOf("await markSocialPostDraftPublishAttempt(id)"));
  assert.ok(guardAt < publishing.indexOf("await publishGalleryPostToInstagram("));
});

test("③ 인스타를 부르기 전의 실패는 «결과 불명확»이 아니라 일반 실패다", () => {
  // 시도 한 건의 흐름: 예약(PUBLISHING) → [인스타 호출 직전] AMBIGUOUS → 결과 기록
  const reserved = "PUBLISHING";
  assert.equal(attemptStateAfterException(reserved), "FAILED", "동의 철회·사진 0장·사본 실패 = 일반 실패");
  const calling = attemptStateWhenProviderCallStarts();
  assert.equal(calling, "AMBIGUOUS");
  assert.equal(attemptStateAfterException(calling), "AMBIGUOUS", "호출을 시작한 뒤의 예외는 결과를 모른다");
  // 그래서 호출 전 실패는 크론의 재발행 중단 조건에 걸리지 않고, 호출 뒤 예외는 걸린다
  assert.equal(shouldHaltCronRepublish([attemptStateAfterException(reserved)]), false);
  assert.equal(shouldHaltCronRepublish([attemptStateAfterException(calling)]), true);

  // 초안: 호출 전 실패는 «재시도 필요»로, 단 다른 처리가 시도를 잡고 있는 동안에는 건드리지 않는다
  assert.deepEqual(failDraftBeforeProviderCall({ status: "PUBLISHING", nextRetryAt: null, attempts: 0 }, NOW), { status: "FAILED", nextRetryAt: null, attempts: 0 });
  assert.deepEqual(failDraftBeforeProviderCall({ status: "PUBLISHING", nextRetryAt: NOW - MINUTE, attempts: 1 }, NOW), { status: "FAILED", nextRetryAt: null, attempts: 1 });
  const leased = { status: "PUBLISHING", nextRetryAt: NOW + 4 * MINUTE, attempts: 1 };
  assert.equal(failDraftBeforeProviderCall(leased, NOW), leased, "진행 중인 처리의 대기열을 끄면 사람이 다시 눌러 두 번 올라간다");
  const published = { status: "PUBLISHED", nextRetryAt: null, attempts: 1 };
  assert.equal(failDraftBeforeProviderCall(published, NOW), published);
  assert.match(FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL, /status = 'PUBLISHING'\s+AND \("instagramNextRetryAt" IS NULL OR "instagramNextRetryAt" <= NOW\(\)\)/);

  // 연결: AMBIGUOUS 표시는 인스타 호출 바로 앞 한 곳뿐이다(예약 직후에 하던 옛 줄은 없다)
  assert.equal(publishing.match(/MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL, attemptId/g).length, 1);
  assert.match(publishing, /\$executeRawUnsafe\(MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL, attemptId\);\s*const result = await publishGalleryPostToInstagram\(/);
  assert.doesNotMatch(publishing, /SET state='AMBIGUOUS'/);
  const wrapper = publishing.slice(publishing.indexOf("export async function publishSocialDraftToInstagramNow("), publishing.indexOf("async function closeAttemptWithoutProviderCall"));
  // 예외 처리: 먼저 «호출 전이었나»를 보고, 그랬으면 일반 실패로 끝낸다. «직접 확인» 일(MANUAL_REQUIRED)은 만들지 않는다
  assert.match(wrapper, /CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL, attemptId, message,\s*\);\s*if \(closedBeforeCall\[0\]\) \{\s*await prisma\.\$executeRawUnsafe\(FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL, id, message\);\s*throw error;\s*\}/);
  assert.ok(wrapper.indexOf("if (closedBeforeCall[0])") < wrapper.indexOf("MANUAL_REQUIRED"));
  assert.ok(wrapper.indexOf("if (closedBeforeCall[0])") < wrapper.indexOf("HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL"));
  // 호출 뒤 예외의 처리(직접 확인 일 + 대기열 끄기)는 그대로
  assert.match(wrapper, /'MANUAL_REQUIRED'[\s\S]*\$executeRawUnsafe\(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, id\);\s*throw error;/);
});

test("크론: 호출 전 실패를 끝없이 다시 돌리지 않는다 · 실행 시간은 «시도 잡기» 5분보다 짧다", () => {
  const queue = publishing.slice(publishing.indexOf("export async function processSocialPostPublishQueue"));
  // 불명확 확인 → 호출 전 실패 정리 → (우리가 잡은 시도가 있을 때만) 재시도 예약 순서
  const ambiguousAt = queue.indexOf("state='AMBIGUOUS' LIMIT 1");
  const failAt = queue.indexOf("FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL, draft.id");
  const retryAt = queue.indexOf("markSocialPostDraftRetryScheduled(draft.id");
  assert.ok(ambiguousAt > 0 && ambiguousAt < failAt && failAt < retryAt);
  assert.match(queue, /if \(latest && latest\.status !== "PUBLISHING"\) \{\s*results\.push\(\{ id: draft\.id, ok: false, status: latest\.status, retryScheduled: false, error: message \}\);\s*continue;/);

  const seconds = Number(cron.match(/export const maxDuration = (\d+);/)?.[1]);
  assert.ok(seconds > 0 && seconds < 5 * 60, "실행 시간 제한이 시도 유효 시간(5분)보다 짧아야 한다");
  assert.match(CLAIM_INSTAGRAM_ATTEMPT_SQL, /INTERVAL '5 minutes'/);
});

test("운영 봇: 원장을 기다리는 초안(대기열 꺼짐)은 «오래 대기 중» 경고에 넣지 않는다", () => {
  const bot = read("../src/lib/siteOpsBot.ts");
  assert.match(bot, /WHERE status = 'PUBLISHING'[\s\S]{0,400}AND "instagramNextRetryAt" IS NOT NULL\s+AND "instagramNextRetryAt" < NOW\(\) - INTERVAL '2 hours'/);
  assert.doesNotMatch(bot, /COALESCE\("instagramNextRetryAt", "updatedAt"\) < NOW\(\) - INTERVAL '2 hours'/);
});
