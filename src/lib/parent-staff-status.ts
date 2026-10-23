/** 저장 결과와 알림 장부를 분리하는 화면용 요약. 읽음 여부는 추측하지 않는다. */
export type DeliveryStatusSummary = {
  recipientCount: number;
  inAppCount: number;
  pushAcceptedCount: number;
  pushPartialCount: number;
  pushFailedCount: number;
  noSubscriptionCount: number;
  skippedCount: number;
  pendingCount: number;
  unknownCount: number;
  driverLinked?: boolean;
};

export type DeliveryStatusRow = { recipientUserId: string; studentId?: string | null; channel: string; status: string; errorCode?: string | null; role?: string };

export function summarizeDeliveryStatus(rows: DeliveryStatusRow[]): DeliveryStatusSummary {
  const count = (channel: string, statuses: string[]) => rows.filter((row) => row.channel === channel && statuses.includes(row.status)).length;
  // 형제의 알림도 각각의 업무다. 같은 보호자라도 학생별 채널 누락을 숨기지 않는다.
  const key = (row: DeliveryStatusRow) => JSON.stringify([row.recipientUserId, row.studentId ?? null]);
  const recipientCount = new Set(rows.map(key)).size;
  return {
    recipientCount,
    inAppCount: count("IN_APP", ["SENT"]),
    // PARTIAL은 접수 성공과 일부 실패가 겹친다. 별도 항목으로 보여 중복 합산을 막는다.
    pushAcceptedCount: count("PUSH", ["SENT"]),
    pushPartialCount: rows.filter((row) => row.channel === "PUSH" && (row.status === "PARTIAL" || row.errorCode === "PARTIAL_DELIVERY_RETRY_SCHEDULED")).length,
    pushFailedCount: count("PUSH", ["FAILED"]),
    noSubscriptionCount: rows.filter((row) => row.channel === "PUSH" && row.errorCode === "NO_SUBSCRIPTION").length,
    skippedCount: count("PUSH", ["SKIPPED"]),
    pendingCount: count("PUSH", ["PENDING", "PROCESSING", "RETRYING"]),
    unknownCount: recipientCount - new Set(rows.filter((row) => row.channel === "PUSH").map(key)).size + rows.filter((row) => row.channel === "PUSH" && !["SENT", "PARTIAL", "FAILED", "SKIPPED", "PENDING", "PROCESSING", "RETRYING"].includes(row.status)).length,
    driverLinked: rows.some((row) => row.role === "DRIVER"),
  };
}

export function deliveryStatusText(summary: DeliveryStatusSummary | null | undefined): string {
  if (!summary) return "알림 결과 확인 필요 — 저장 결과와 별개입니다.";
  if (summary.recipientCount === 0) return "알림 기록 없음 — 담당자 연결과 전달 결과 확인이 필요합니다.";
  const skipped = summary.skippedCount;
  // 형제·자매가 같은 반에 있으면 한 부모에게 여러 학생별 장부가 생기므로 '명'이 아닌 '건'이다.
  return `사이트 알림 등록 ${summary.inAppCount}건 · 푸시 전송 접수 ${summary.pushAcceptedCount}건` +
    (summary.pushPartialCount ? ` · 푸시 일부 기기 실패 ${summary.pushPartialCount}건` : "") +
    (summary.pushFailedCount ? ` · 푸시 실패 ${summary.pushFailedCount}건` : "") +
    (summary.pendingCount ? ` · 푸시 처리 대기 ${summary.pendingCount}건` : "") +
    (summary.noSubscriptionCount ? ` · 푸시 구독 미등록 ${summary.noSubscriptionCount}건` : "") +
    (skipped > summary.noSubscriptionCount ? ` · 푸시 미설정·건너뜀 ${skipped - summary.noSubscriptionCount}건` : "") +
    (summary.unknownCount ? ` · 결과 확인 필요 ${summary.unknownCount}건` : "");
}

export function matchesShuttleChange(row: { studentId: string; serviceDate: string; direction: string; kind: string; location: string | null; note: string | null }, input: Record<string, unknown>) {
  return row.studentId === input.studentId && row.serviceDate === input.serviceDate && row.direction === input.direction && row.kind === input.kind &&
    (row.location ?? "") === (input.kind === "LOCATION" ? String(input.location ?? "").trim().slice(0, 200) : "") &&
    (row.note ?? "") === String(input.note ?? "").trim().slice(0, 300);
}
