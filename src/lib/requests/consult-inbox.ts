/**
 * 신청함 «상담» 탭 어댑터 자리 (2026-11-10 원장 결정 k1 — 상담은 신설 기능)
 *
 * 왜 따로 파일인가: 상담 표·접수 화면은 다른 작업(상담 브랜치)이 만든다. 신청함은 이 파일의 두 함수만 부른다 —
 * 상담 작업의 같은 경로·같은 이름 파일이 합쳐질 때 이 스텁을 대신한다(시그니처를 그쪽 계약과 똑같이 맞춰 둔다).
 *
 * 지금은 임시 스텁이다(빈 목록·0건). 계약:
 * - listConsultInboxRows({ bucket, from?, to?, limitPerKind? }) → kind "CONSULT" 인 InboxRow 목록(칸 하나씩)
 * - countConsultAction() → 처리 필요(NEW) 건수. 상담 행은 getInboxRows/getInboxCounts 의 UNION 에 없어서
 *   신청함이 탭 배지·메뉴 숫자에 따로 더한다.
 * - 조회는 $queryRawUnsafe 만(PgBouncer 트랜잭션 모드 — CLAUDE.md).
 */
import type { InboxBucket } from "@/lib/requests/catalog";
import type { InboxRow } from "@/lib/requests/admin-inbox";

export type ConsultInboxRow = Omit<InboxRow, "kind"> & { kind: "CONSULT" };

export type ConsultInboxQuery = {
  bucket: InboxBucket;
  /** 신청일(KST «YYYY-MM-DD») 범위 */
  from?: string | null;
  to?: string | null;
  limitPerKind?: number;
};

/** 상담 탭 목록. 지금은 상담 표가 없어 빈 목록 */
export async function listConsultInboxRows(_query: ConsultInboxQuery): Promise<ConsultInboxRow[]> {
  return [];
}

/** 상담 탭 배지·메뉴 숫자에 더할 «처리 필요»(NEW) 건수. 지금은 0 */
export async function countConsultAction(): Promise<number> {
  return 0;
}
