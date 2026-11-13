/**
 * 랠리즈 확인 은퇴 스위치 (2026-11-14 원장 결정 — 랠리즈 은퇴 1단계).
 *
 * 원장: 「이제 랠리즈는 사용하지 않을 거라 랠리즈 반영 확인 같은 부분은 필요 없어.」
 * 그래서 운영 원장의 확인 칸 3개(SHEET·RALLYZ·WEBSITE) 중 RALLYZ 도 시트처럼 처음부터
 * "건너뜀(SKIPPED)"으로 만들고, 완료 판정에서도 RALLYZ 는 SUCCEEDED 또는 SKIPPED 면 통과시킨다.
 * (시트 은퇴: sheetRetirement.ts — 같은 모양이다.)
 *
 * 되돌리기: 환경변수 STIZ_RALLYZ_SYNC_RETIRED 를 "0" 으로 두면 옛 방식(랠리즈 칸 PENDING → 사람이 확인)으로 돌아간다.
 * «랠리즈 반영 확인» 서버 액션은 되돌림용으로 지우지 않고 남겨 둔다(삭제는 3단계).
 *
 * ⚠️ 이 파일은 다른 모듈을 import 하지 않는다 — 테스트(node --test)가 직접 불러 실행한다.
 */

/** 은퇴로 건너뛴 RALLYZ 시도에 남기는 표식(externalReference). sheetRetirement.initialSyncAttempt 가 같은 글자를 쓴다(테스트가 대조). */
export const RALLYZ_RETIRED_REFERENCE = "RALLYZ_RETIRED";

/** 은퇴 상태에서 «랠리즈 반영 확인»이 불렸을 때 돌려주는 안내 문구 */
export const RALLYZ_RETIRED_MESSAGE = "랠리즈 반영 확인은 더 이상 필요 없습니다.";

/**
 * 랠리즈 확인이 은퇴 상태인가?
 * 기본값 = 은퇴(true). 값이 정확히 "0" 일 때만 옛 방식(false). 앞뒤 공백·줄바꿈은 무시한다.
 * env 는 서버 코드에서 process.env 를 넘긴다(이 파일은 화면 번들에도 들어갈 수 있어 직접 읽지 않는다).
 */
export function isRallyzSyncRetired(env: Record<string, string | undefined>): boolean {
  return env.STIZ_RALLYZ_SYNC_RETIRED?.trim() !== "0";
}

/** RALLYZ 칸이 "끝난" 상태인가 — 실제 확인(SUCCEEDED) 또는 은퇴로 건너뜀(SKIPPED). */
export function isRallyzTargetDone(status: string | null | undefined): boolean {
  return status === "SUCCEEDED" || status === "SKIPPED";
}

/**
 * 바깥 장부(SHEET·RALLYZ) 칸이 "끝난" 상태인가 — 두 칸 모두 SUCCEEDED 또는 SKIPPED.
 * WEBSITE 는 여기서 다루지 않는다(사이트 반영은 실제 일이라 SKIPPED 를 끝으로 보지 않는다).
 */
export function isExternalTargetDone(status: string | null | undefined): boolean {
  return status === "SUCCEEDED" || status === "SKIPPED";
}

/**
 * «바깥 장부(시트·랠리즈) 확인이 아직 남은 칸» SQL 조건(alias = OperationsSyncAttempt 별칭).
 * 확인 필요 탭·건수, 신청함의 syncPending, 홈페이지 반영 전 선행 조건이 모두 이 조각 하나를 쓴다
 * — 한 곳만 고치면 «완료»와 «확인 필요»가 화면마다 어긋나기 때문이다.
 * 위 isExternalTargetDone 과 반드시 같은 규칙이어야 한다(tests/rallyz-retirement.test.mjs 가 실행해 대조).
 */
export function externalSyncPendingSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("invalid alias");
  return `(${alias}.target IN ('SHEET','RALLYZ') AND ${alias}.status NOT IN ('SUCCEEDED','SKIPPED'))`;
}

/**
 * 홈페이지(WEBSITE)가 이미 반영된 원장을 새로 만들 때의 명령 상태.
 * 시트·랠리즈 칸이 둘 다 처음부터 건너뜀이면 남은 확인이 없으므로 처음부터 SYNCED(끝)로 만든다.
 * 하나라도 PENDING 이면 옛 방식대로 PENDING(사람이 확인).
 */
export function websiteDoneLedgerStatus(externalStatuses: Array<string | null | undefined>): "SYNCED" | "PENDING" {
  return externalStatuses.length > 0 && externalStatuses.every(isExternalTargetDone) ? "SYNCED" : "PENDING";
}
