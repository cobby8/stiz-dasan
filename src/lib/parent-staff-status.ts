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
  /** 기사님 휴대폰 알림이 실제로 나갔나(기사 행 중 PUSH 가 SENT·PARTIAL) — 학부모 화면 «기사님께 알렸어요» 판정용(2026-11-15) */
  driverPushDelivered?: boolean;
  /** 기사님 알림함(사이트 알림)에는 들어갔나(기사 행 중 IN_APP 이 SENT) */
  driverInApp?: boolean;
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
    // 읽기 전용 파생값 — 전달 동작은 그대로다. 기사 행만 따로 본다(선생님이 받은 것을 «기사님께 알렸다»고 하지 않게)
    driverPushDelivered: rows.some((row) => row.role === "DRIVER" && row.channel === "PUSH" && (row.status === "SENT" || row.status === "PARTIAL")),
    driverInApp: rows.some((row) => row.role === "DRIVER" && row.channel === "IN_APP" && row.status === "SENT"),
  };
}

/**
 * 학부모 화면(셔틀 변경)에 보일 알림 결과 한 줄(2026-11-15 리뷰 반영 — 기사님께 실제로 갔는지를 본다).
 *  DRIVER       기사님 휴대폰 알림이 나감            → «기사님께 알렸어요»
 *  DRIVER_INBOX 기사님 알림함에만(휴대폰 알림 꺼짐·실패) → «기사님 알림함에 남겼어요. 급하면 학원에 전화해 주세요» + 전화 버튼
 *  ACADEMY      기사님은 못 받고 선생님 등만 받음      → «학원에 알렸어요»
 *  FAILED       아무에게도 못 감                    → «알림을 못 보냈어요. 학원에 전화해 주세요» + 전화 버튼
 *  null         결과를 아직 모름(요약 없음·보내는 중)   → 줄을 그리지 않는다
 */
export type ParentDeliveryView = { kind: "DRIVER" | "DRIVER_INBOX" | "ACADEMY" | "FAILED"; text: string; call: boolean };

export function parentDeliveryView(summary: DeliveryStatusSummary | null | undefined): ParentDeliveryView | null {
  if (!summary) return null;
  if (summary.driverPushDelivered) return { kind: "DRIVER", text: "기사님께 알렸어요", call: false };
  if (summary.driverInApp) return { kind: "DRIVER_INBOX", text: "기사님 알림함에 남겼어요. 급하면 학원에 전화해 주세요", call: true };
  // 여기부터는 기사님이 못 받은 경우 — 다른 사람(선생님)에게라도 닿았는지 본다
  const reached = summary.inAppCount > 0 || summary.pushAcceptedCount > 0 || summary.pushPartialCount > 0;
  if (reached) return { kind: "ACADEMY", text: "학원에 알렸어요", call: false };
  // 아직 보내는 중이면 «실패»라고 하지 않는다
  if (summary.recipientCount > 0 && summary.pendingCount > 0) return null;
  return { kind: "FAILED", text: "알림을 못 보냈어요. 학원에 전화해 주세요", call: true };
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
