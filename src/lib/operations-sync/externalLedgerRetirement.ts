/**
 * 바깥 장부(구글 시트·랠리즈) 은퇴 규칙 — 한 곳에 모은 순수 모듈.
 *
 * - 구글 시트 원장: 2026-10-06 원장 결정으로 종료(Phase 2 시트 종료).
 * - 랠리즈: 2026-11-14 원장 결정 「이제 랠리즈는 사용하지 않을 거라 랠리즈 반영 확인 같은 부분은 필요 없어」.
 * - 2026-11-18 결정표(rallyz-switch·sheet-switch «완전히 지운다»): 되돌리기용 환경변수 스위치
 *   (STIZ_SHEET_SYNC_RETIRED·STIZ_RALLYZ_SYNC_RETIRED)와 옛 시트 쓰기·랠리즈 확인 코드를 지웠다.
 *   이제 확인 칸 3개(SHEET·RALLYZ·WEBSITE) 중 SHEET·RALLYZ 는 언제나 처음부터 «건너뜀(SKIPPED)»이다.
 *
 * 과거에 PENDING/FAILED 로 남은 SHEET·RALLYZ 행이 있을 수 있으므로(운영 확인 시 0건) 완료 판정·확인 필요 SQL 은 그대로 둔다.
 *
 * ⚠️ 이 파일은 다른 모듈을 import 하지 않는다 — 테스트(node --test)가 직접 불러 실행한다.
 */

/** 은퇴로 건너뛴 SHEET 시도에 남기는 표식(externalReference). 사람이 고친 MANUAL:<id> 와 구분된다. */
export const SHEET_RETIRED_REFERENCE = "SHEET_RETIRED";

/** 은퇴로 건너뛴 RALLYZ 시도에 남기는 표식(externalReference). */
export const RALLYZ_RETIRED_REFERENCE = "RALLYZ_RETIRED";

/**
 * 바깥 장부(SHEET·RALLYZ) 칸이 "끝난" 상태인가 — 실제 반영 성공(SUCCEEDED) 또는 은퇴로 건너뜀(SKIPPED).
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
 * 새 동기화 시도(OperationsSyncAttempt)를 만들 때의 처음 상태.
 * - SHEET → SKIPPED + SHEET_RETIRED 표식. verifiedAt 은 NULL(실제로 확인한 적이 없으므로 — 판정은 SKIPPED 만 본다).
 * - RALLYZ → SKIPPED + RALLYZ_RETIRED 표식.
 * - 그 외(WEBSITE) → PENDING (WEBSITE 를 이미 끝낸 경우는 호출하는 쪽이 따로 SUCCEEDED 로 넣는다).
 */
export function initialSyncAttempt(target: string): { status: "PENDING" | "SKIPPED"; externalReference: string | null } {
  if (target === "SHEET") return { status: "SKIPPED", externalReference: SHEET_RETIRED_REFERENCE };
  if (target === "RALLYZ") return { status: "SKIPPED", externalReference: RALLYZ_RETIRED_REFERENCE };
  return { status: "PENDING", externalReference: null };
}

/**
 * 홈페이지(WEBSITE)가 이미 반영된 원장을 새로 만들 때의 명령 상태.
 * 시트·랠리즈 칸이 둘 다 끝난 상태(건너뜀 포함)면 남은 확인이 없으므로 처음부터 SYNCED(끝)로 만든다.
 * 하나라도 PENDING 이면 PENDING(사람이 확인).
 */
export function websiteDoneLedgerStatus(externalStatuses: Array<string | null | undefined>): "SYNCED" | "PENDING" {
  return externalStatuses.length > 0 && externalStatuses.every(isExternalTargetDone) ? "SYNCED" : "PENDING";
}
