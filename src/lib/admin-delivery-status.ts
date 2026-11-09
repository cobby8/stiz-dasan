// @ts-expect-error Node 의 타입 제거 테스트(tests/admin-delivery-status)에서도 같은 파일을 읽어서 확장자를 붙인다.
import { TONE_BADGE_CLASS } from "./ui/statusTones.ts";

export type OperationalDeliveryRow = {
  id: string;
  eventType: string;
  stableEventKey?: string | null;
  recipientUserId?: string | null;
  channel: string;
  status: string;
  errorMessage?: string | null;
  partialRetry?: boolean;
};

/** SENT는 채널에 따라 기록 생성 또는 전송 접수다. 사람의 확인을 뜻하지 않는다. */
export function operationalDeliveryView(row: OperationalDeliveryRow) {
  // 색 = 공용 지도(statusTones): 접수 정상 · 재시도 중 정보 · 일부 실패·건너뜀·확인 필요 주의 · 실패 위험
  if (row.status === "SENT") return { label: row.channel === "IN_APP" ? "사이트 알림 등록 완료" : "푸시 전송 접수", className: TONE_BADGE_CLASS.success };
  if (row.status === "PENDING") return { label: row.partialRetry ? "일부 기기 실패 · 재시도 중" : "자동 재시도 중", className: TONE_BADGE_CLASS.info };
  if (row.status === "PARTIAL") return { label: "일부 기기 실패", className: TONE_BADGE_CLASS.warning };
  if (row.status === "SKIPPED") return { label: "푸시 미등록·전송 건너뜀", className: TONE_BADGE_CLASS.warning };
  if (row.status === "FAILED") return { label: "알림 처리 실패", className: TONE_BADGE_CLASS.danger };
  return { label: "결과 확인 필요", className: TONE_BADGE_CLASS.warning };
}

/** 이름·시각이 같아도 다른 요청이다. 안정된 사건·수신자 키가 있을 때만 묶는다. */
export function groupOperationalDeliveries<T extends OperationalDeliveryRow>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.stableEventKey && row.recipientUserId
      ? JSON.stringify([row.stableEventKey, row.recipientUserId]) : JSON.stringify([row.id]);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}
