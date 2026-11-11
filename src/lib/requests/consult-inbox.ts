/**
 * 신청함 «상담» 탭 연결부 (2026-11-10 상담 신청 신설 · 원장 승인 k1·m4)
 *
 * 신청함(탭 6개 재편)의 «상담» 자리에서 이 두 함수만 부르면 된다:
 *   - listConsultInboxRows(query) → 공통 행(InboxRow 모양, kind = "CONSULT") 배열
 *   - countConsultAction()       → «새 상담»(NEW) 건수 = 처리 필요 숫자
 *
 * 상태 → 칸 지도(catalog 에 CONSULT 를 넣을 때 그대로 옮길 값)는 src/lib/consult/consult-rules.ts 의 CONSULT_STATUS_MAP:
 *   NEW = 처리 필요 «새 상담» · CONTACTED = 진행 중 «연락함» · DONE = 완료 «상담 완료» · CANCELED = 완료 «취소»
 *
 * 목록 오류는 신청함의 상담 탭에서 처리한다. 메뉴 건수는 실패 시 0으로 표시한다.
 */
import { prisma } from "@/lib/prisma";
import { consultStatusesOf } from "@/lib/consult/consult-rules";
import {
  countNewConsultRequests,
  listConsultRequests,
  toConsultInboxRow,
  type ConsultInboxRow,
} from "@/lib/consult/consult-service";
import type { InboxQuery } from "@/lib/requests/admin-inbox";

export type { ConsultInboxRow } from "@/lib/consult/consult-service";

/** 신청함 «상담» 목록 — 처리 필요·진행 중은 오래된 것부터, 완료는 최신부터(다른 종류와 같은 정렬) */
export async function listConsultInboxRows(
  query: Pick<InboxQuery, "bucket" | "from" | "to" | "limitPerKind">,
): Promise<ConsultInboxRow[]> {
  const records = await listConsultRequests(prisma, {
    statuses: consultStatusesOf(query.bucket),
    from: query.from ?? null,
    to: query.to ?? null,
    limit: query.limitPerKind,
    newestFirst: query.bucket === "DONE",
  });
  return records.map(toConsultInboxRow);
}

/** «새 상담»(NEW) 건수 — 실패하면 0(메뉴 숫자만 비고 화면은 열린다) */
export async function countConsultAction(): Promise<number> {
  try {
    return await countNewConsultRequests(prisma);
  } catch (error) {
    console.error("[consult-inbox] 상담 건수 조회 실패:", error);
    return 0;
  }
}
