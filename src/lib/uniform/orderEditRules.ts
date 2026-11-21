// 유니폼 신청 수정 가능 여부 — 순수 규칙(화면·서버 같이 쓴다).
// ⚠️ 이 파일은 node 전용 모듈(node:crypto 등)을 import 하지 않는다 — 화면(브라우저 묶음)이 불러온다.
//    (2026-11-21 orderEdit.ts → uniform-partner.ts → node:crypto 를 화면이 불러 운영 빌드가 실패했다)

/** 본사로 아직 안 간 상태 — 이 상태의 신청만 고칠 수 있다(재전송 버튼이 보이는 상태와 같다) */
export const EDITABLE_SYNC_STATUSES = ["PENDING", "RETRY_WAIT", "NEEDS_REVIEW", "SETUP_REQUIRED"] as const;

export function canEditUniformOrder(order: { orderStatus: string; stizSyncStatus: string }): boolean {
  return order.orderStatus !== "CANCELED" && (EDITABLE_SYNC_STATUSES as readonly string[]).includes(order.stizSyncStatus);
}
