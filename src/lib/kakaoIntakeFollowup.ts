export type KakaoFollowupCommand = {
  status: string;
  parentConfirmed: boolean;
  parentReconfirmationRequired: boolean;
  holdReason: string | null;
};

export function kakaoFollowupSummary(status: string, commands: KakaoFollowupCommand[]) {
  if (status === "PROCESSING") return "처리 중 · 장기 잔류 시 실제 반영 여부 수동 대조 필요 · 자동 재시도 금지";
  if (status === "REJECTED") return "접수 반려 기록 · 학부모 안내 미발송";
  if (status === "NEEDS_DETAILS") return "추가 확인 대기 · 상태만 저장됨 · 학부모 안내 미발송";
  if (status === "CONSULTATION") return "상담 후속 필요 · 상담 완료가 아닙니다";
  if (status === "CONSULTATION_CLOSED") return "상담 종결 기록 · 수강 반영·청구 완료가 아닙니다 · 이 처리로 학부모 안내를 발송하지 않았습니다";
  if (status === "FAILED") return "처리 실패 · 요청 내용과 처리 이력을 확인해 주세요";
  if (status !== "APPROVED") return null;
  if (!commands.length) return "운영 원장 연결 확인 필요 · 완료로 간주하지 마세요";
  if (commands.some(command => command.parentReconfirmationRequired || !command.parentConfirmed)) return "학부모 재확인 대기 · 외부 동기화 보류";
  if (commands.some(command => ["FAILED", "PARTIAL"].includes(command.status))) return "학부모 확인 완료 · 동기화 실패/부분 반영 확인 필요";
  if (commands.every(command => command.status === "SYNCED")) return "운영 동기화 완료 · 청구·알림 완료 여부는 별도 확인";
  return "학부모 확인 완료 · 운영 승인/외부 동기화 대기";
}

export function isKakaoFollowupOverdue(status: string, createdAt: string, now: number) {
  return ["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION", "APPROVED", "PROCESSING"].includes(status)
    && now - Date.parse(createdAt) >= 24 * 60 * 60 * 1000;
}
