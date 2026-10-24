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
  if (row.status === "SENT") return { label: row.channel === "IN_APP" ? "사이트 알림 등록 완료" : "푸시 전송 접수", className: "bg-green-100 text-green-700" };
  if (row.status === "PENDING") return { label: row.partialRetry ? "일부 기기 실패 · 재시도 중" : "자동 재시도 중", className: "bg-blue-100 text-blue-700" };
  if (row.status === "PARTIAL") return { label: "일부 기기 실패", className: "bg-amber-100 text-amber-800" };
  if (row.status === "SKIPPED") return { label: "푸시 미등록·전송 건너뜀", className: "bg-amber-100 text-amber-800" };
  if (row.status === "FAILED") return { label: "알림 처리 실패", className: "bg-red-100 text-red-700" };
  return { label: "결과 확인 필요", className: "bg-amber-100 text-amber-800" };
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
