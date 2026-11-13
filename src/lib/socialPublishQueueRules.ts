/**
 * 인스타그램 게시 대기열의 «상태 전이 규칙» — DB·서버 모듈을 부르지 않는 순수 파일.
 *
 * 2026-11-14 사진·인스타 점검에서 찾은 결함:
 *   게시 예약(withSocialDraftPublicationReservation)이 먼저 status 를 PUBLISHING 으로 바꾸기 때문에,
 *   그 뒤의 markSocialPostDraftPublishing 은 «이미 PUBLISHING» 분기를 타서 "instagramNextRetryAt"(다음 시도 시각)을
 *   비운 채로 둔다. 그런데 «시도 잡기»는 그 값이 있어야만 성공해서, 인스타 호출 없이 «건너뜀»이 성공으로
 *   돌아오고 초안은 PUBLISHING(게시 처리 중)에 영원히 남았다. 5분 크론도 같은 조건이라 풀지 못했다.
 *
 * 고친 방식(값의 뜻을 하나로 못박는다):
 *   "instagramNextRetryAt" 이 NULL  = 인스타 대기열이 «꺼져 있음»(원장이 아직 인스타 게시를 누르지 않았다)
 *   "instagramNextRetryAt" 이 있음  = 대기열이 «켜져 있음»(그 시각 이후에 시도해도 된다)
 *
 *   - 대기열을 켜는 것은 «원장이 인스타 게시를 누른 경로»뿐이다(ARM).
 *     갤러리 단계에서 켜면, 부원장이 갤러리만 올린 초안을 5분 크론이 원장 승인 없이 인스타에 올리게 된다.
 *   - 크론은 켜진 초안만 집는다(QUEUED).
 *   - «시도 잡기»(CLAIM)는 그대로다 — 한 번 잡으면 5분 뒤로 밀려 동시에 두 번 발행되지 않는다.
 *
 * SQL 문자열과 아래 순수 함수는 같은 규칙의 두 표현이다. 한쪽만 고치면 tests/social-publish-queue.test.mjs 가 깨진다.
 */

/** 원장이 인스타 게시를 눌렀을 때만 실행 — 꺼져 있던 대기열을 켜고, 새 승인이므로 시도 횟수를 0 으로 되돌린다. */
export const ARM_INSTAGRAM_QUEUE_SQL = `UPDATE "SocialPostDraft"
     SET "instagramNextRetryAt" = NOW(),
         "instagramPublishAttempts" = 0,
         "instagramLastAttemptAt" = NULL,
         "updatedAt" = NOW()
     WHERE id = $1
       AND status = 'PUBLISHING'
       AND "instagramNextRetryAt" IS NULL
     RETURNING *`;

/** 인스타 호출 직전에 «이번 시도는 내가 한다»를 잡는다. 잡지 못하면(다른 처리가 진행 중·대기열 꺼짐) 호출하지 않는다. */
export const CLAIM_INSTAGRAM_ATTEMPT_SQL = `UPDATE "SocialPostDraft"
     SET "instagramPublishAttempts" = COALESCE("instagramPublishAttempts", 0) + 1,
         "instagramLastAttemptAt" = NOW(),
         "instagramNextRetryAt" = NOW() + INTERVAL '5 minutes',
         "updatedAt" = NOW()
     WHERE id = $1
       AND status = 'PUBLISHING'
       AND "instagramNextRetryAt" IS NOT NULL
       AND "instagramNextRetryAt" <= NOW()
     RETURNING *`;

/** 5분 크론이 집을 초안 — 대기열이 켜져 있고 시각이 된 것만. 꺼진(원장 미승인) 초안은 집지 않는다. */
export const QUEUED_INSTAGRAM_DRAFTS_SQL = `SELECT * FROM "SocialPostDraft"
     WHERE status = 'PUBLISHING'
       AND "instagramNextRetryAt" IS NOT NULL
       AND "instagramNextRetryAt" <= NOW()
     ORDER BY "instagramNextRetryAt" ASC, "createdAt" ASC
     LIMIT $1`;

/** 결과가 불명확한(호출 도중 예외) 초안은 자동 재발행을 멈춘다 — 대기열을 끄고 «재시도 필요»로 둔다. */
export const HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL = `UPDATE "SocialPostDraft" SET status='FAILED', "instagramNextRetryAt"=NULL,
            "instagramPublishError"='Instagram 게시 결과 확인 필요', "updatedAt"=NOW() WHERE id=$1 AND status='PUBLISHING'`;

/**
 * 갤러리 단계가 초안을 «게시 처리 중»으로 표시한다(2026-11-14 검수 필수 1).
 * - 게시할 수 있는 상태(READY·FAILED·PUBLISHING)일 때만 바꾼다. 예전에는 조건이 없어, 원장의 인스타 게시가
 *   끝난(PUBLISHED) 뒤 다른 관리자의 갤러리 단계가 늦게 도착하면 PUBLISHED 를 PUBLISHING 으로 되돌렸다.
 * - 대기열을 켜지 않는다(ELSE NULL). 예전의 ELSE NOW() 는 원장 승인 없이 대기열을 켜는 두 번째 길이었다.
 *   대기열을 켜는 곳은 ARM_INSTAGRAM_QUEUE_SQL 한 곳뿐이다.
 */
export const MARK_GALLERY_PUBLISHING_SQL = `UPDATE "SocialPostDraft"
     SET status = 'PUBLISHING',
         "galleryPostId" = $1,
         "instagramPublishError" = NULL,
         "instagramPublishAttempts" = CASE WHEN status = 'PUBLISHING' THEN "instagramPublishAttempts" ELSE 0 END,
         "instagramLastAttemptAt" = CASE WHEN status = 'PUBLISHING' THEN "instagramLastAttemptAt" ELSE NULL END,
         "instagramNextRetryAt" = CASE WHEN status = 'PUBLISHING' THEN "instagramNextRetryAt" ELSE NULL END,
         "updatedAt" = NOW()
     WHERE id = $2
       AND status IN ('READY', 'FAILED', 'PUBLISHING')
     RETURNING *`;

/**
 * 인스타를 부르기 «직전»에만 시도를 «결과 불명확(AMBIGUOUS)»으로 표시한다(검수 권장 1).
 * 이 표시가 남아 있다 = 인스타를 불렀는데 결과를 기록하지 못했다(서버 함수가 시간 초과로 죽은 경우 포함).
 * 예전에는 호출 훨씬 전에 표시해, 동의 철회·사진 0장 같은 «호출 전 실패»도 «결과 확인 필요»가 됐다.
 */
export const MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL =
  `UPDATE "SocialPublishAttempt" SET state='AMBIGUOUS', "updatedAt"=NOW() WHERE id=$1`;

/** 인스타를 부르지 않고 끝난 시도를 일반 실패로 닫는다. 이미 호출을 시작한(AMBIGUOUS)·끝난 시도는 건드리지 않는다. */
export const CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL =
  `UPDATE "SocialPublishAttempt" SET state='FAILED', "lastError"=$2, "updatedAt"=NOW() WHERE id=$1 AND state='PUBLISHING' RETURNING id`;

/**
 * 호출 전 실패한 초안을 일반 실패(재시도 필요)로 둔다 — 사유를 그대로 남긴다.
 * 다른 처리가 시도를 잡고 있는 동안(다음 시도 시각이 아직 미래)에는 건드리지 않는다:
 * 그 처리가 인스타를 부르는 중일 수 있고, 여기서 대기열을 끄면 사람이 다시 눌러 두 번 올라간다.
 */
export const FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL = `UPDATE "SocialPostDraft"
     SET status = 'FAILED', "instagramNextRetryAt" = NULL, "instagramPublishError" = $2, "updatedAt" = NOW()
     WHERE id = $1
       AND status = 'PUBLISHING'
       AND ("instagramNextRetryAt" IS NULL OR "instagramNextRetryAt" <= NOW())`;

/**
 * 5분 크론이 인스타를 부르기 전에 확인한다(검수 필수 2): 이 초안의 «다른» 인스타 시도 가운데
 * 결과 불명확(AMBIGUOUS)이거나 이미 게시됨(PUBLISHED)인 것이 있는가.
 * 있으면 인스타에 이미 올라갔을 수 있으므로 자동으로 다시 올리지 않고 사람이 확인하게 멈춘다.
 */
export const PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL = `SELECT id, state FROM "SocialPublishAttempt"
     WHERE "draftId" = $1 AND channel = 'INSTAGRAM' AND id <> $2
       AND state IN ('AMBIGUOUS', 'PUBLISHED')
     LIMIT 1`;

// ── 위 SQL 과 같은 규칙의 순수 함수(실행형 테스트용) ───────────────────────────

export type QueueDraftState = {
  status: string;
  /** 다음 시도 시각(밀리초). null = 대기열 꺼짐. */
  nextRetryAt: number | null;
  attempts: number;
};

const CLAIM_LEASE_MS = 5 * 60 * 1000;

/** ARM_INSTAGRAM_QUEUE_SQL 과 같은 규칙. 바뀐 게 없으면(이미 켜짐·다른 상태) 같은 값을 돌려준다. */
export function armInstagramQueue(state: QueueDraftState, now: number): QueueDraftState {
  if (state.status !== "PUBLISHING" || state.nextRetryAt !== null) return state;
  return { ...state, nextRetryAt: now, attempts: 0 };
}

/** CLAIM_INSTAGRAM_ATTEMPT_SQL 과 같은 규칙. 잡지 못하면 null(= 인스타를 호출하면 안 된다). */
export function claimInstagramAttempt(state: QueueDraftState, now: number): QueueDraftState | null {
  if (state.status !== "PUBLISHING") return null;
  if (state.nextRetryAt === null || state.nextRetryAt > now) return null;
  return { ...state, attempts: state.attempts + 1, nextRetryAt: now + CLAIM_LEASE_MS };
}

/** MARK_GALLERY_PUBLISHING_SQL 과 같은 규칙. 게시할 수 없는 상태(게시 완료·반려 등)면 같은 값을 돌려준다. */
export function markGalleryPublishing(state: QueueDraftState): QueueDraftState {
  if (!["READY", "FAILED", "PUBLISHING"].includes(state.status)) return state;
  if (state.status === "PUBLISHING") return state;
  // 새로 «게시 처리 중»이 되는 초안은 대기열이 꺼진 채로 시작한다(켜는 것은 armInstagramQueue 뿐).
  return { status: "PUBLISHING", nextRetryAt: null, attempts: 0 };
}

/** FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL 과 같은 규칙. 다른 처리가 시도를 잡고 있으면 같은 값을 돌려준다. */
export function failDraftBeforeProviderCall(state: QueueDraftState, now: number): QueueDraftState {
  if (state.status !== "PUBLISHING") return state;
  if (state.nextRetryAt !== null && state.nextRetryAt > now) return state;
  return { ...state, status: "FAILED", nextRetryAt: null };
}

/** 발행 시도 한 건의 상태. PUBLISHING = 예약됨(아직 인스타를 부르지 않음). */
export type PublishAttemptState = "PUBLISHING" | "AMBIGUOUS" | "PUBLISHED" | "FAILED";

/** MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL — 인스타를 부르기 직전. */
export function attemptStateWhenProviderCallStarts(): PublishAttemptState {
  return "AMBIGUOUS";
}

/**
 * 처리 도중 예외가 났을 때 시도가 어떻게 남는가(CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL 과 같은 규칙).
 * 아직 인스타를 부르지 않았으면(PUBLISHING) 일반 실패, 불렀으면(AMBIGUOUS) 그대로 «결과 불명확».
 */
export function attemptStateAfterException(state: PublishAttemptState): PublishAttemptState {
  return state === "PUBLISHING" ? "FAILED" : state;
}

/**
 * PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL 과 같은 규칙 — 크론이 자동 재발행을 멈춰야 하는가.
 * @param priorAttemptStates 이 초안의 «다른» 인스타 시도들의 상태
 */
export function shouldHaltCronRepublish(priorAttemptStates: readonly string[]): boolean {
  return priorAttemptStates.some((state) => state === "AMBIGUOUS" || state === "PUBLISHED");
}

/** QUEUED_INSTAGRAM_DRAFTS_SQL 과 같은 규칙 — 크론이 이 초안을 집는가. */
export function isQueuedForCron(state: QueueDraftState, now: number): boolean {
  return state.status === "PUBLISHING" && state.nextRetryAt !== null && state.nextRetryAt <= now;
}

/**
 * 화면용: «홈페이지에는 올라갔고 인스타는 원장이 아직 누르지 않은» 초안인가.
 * 이 상태는 자동으로 풀리지 않으므로 화면이 «처리 중»으로 잠그지 않고 «인스타 게시» 버튼을 열어 둬야 한다.
 */
export function isInstagramApprovalPending(draft: {
  status: string;
  instagramNextRetryAt?: string | null;
}): boolean {
  return draft.status === "PUBLISHING" && !draft.instagramNextRetryAt;
}
