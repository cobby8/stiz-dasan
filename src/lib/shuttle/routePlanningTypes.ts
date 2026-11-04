/** 순수 계산·서버·화면이 공유하는 계약. 전화번호와 인증 정보는 포함하지 않는다. */
export type PlanDirection = "PICKUP" | "DROPOFF";
export type PlanPoint = { id: string; label: string; lat: number; lng: number };
export type PlanRider = { studentId: string; name: string; grade?: string | null; rosterRowId?: string | null; isNew?: boolean };
export type PlanStop = PlanPoint & {
  students: PlanRider[];
  etaMin: number | null;
  manualMin?: number | null;
  dwellMin?: number;
  recommended?: boolean;
  locked?: boolean;
};
export type PlanLeg = { fromId: string; toId: string; minutes: number; verified: boolean; provider: "TMAP" | "ESTIMATE" | "SYNTHETIC" };
export type PlanRun = {
  id: string; dayOfWeek: string; direction: PlanDirection;
  vehicleId: string; vehicleName: string; driverUserId: string; capacity: number;
  start: PlanPoint; end: PlanPoint;
  /** 등원: 학원 도착 마감 시각. 하원: 학원 출발 시각. */
  anchorMin: number; classStartMin: number; classEndMin: number;
  cleanupMin?: number; nextRunDepartMin?: number | null;
  stops: PlanStop[]; legs: PlanLeg[];
  departMin?: number | null; arriveMin?: number | null;
};
export type PlanIssue = { code: string; message: string; runId?: string; stopId?: string };
export type PlanTimeEntry = { studentId: string; dayOfWeek: string; direction: PlanDirection; timeMin: number; locationKey: string; locationLabel: string };
export type PlanDeliveredSnapshot = { studentId: string; delivered: boolean; entries: PlanTimeEntry[]; source?: "DELIVERED" | "ADMIN_CONFIRMED"; confirmed?: boolean };
export type PlanImpactLeg = { dayOfWeek: string; direction: PlanDirection; beforeMin: number | null; afterMin: number; deltaMin: number | null; beforeLocation: string | null; afterLocation: string };
export type PlanImpact = { studentId: string; studentName: string; legs: PlanImpactLeg[]; notify: boolean; baselineRequired?: boolean; reasons: Array<"FIRST_NOTICE" | "TIME_5_MIN" | "LOCATION_CHANGED" | "SERVICE_CHANGED" | "BASELINE_REQUIRED"> };
export type PlanNoticePreview = { studentId: string; studentName: string; recipientLabel: string; message: string; reasons: PlanImpact["reasons"] };
export type RoutePlanDraft = {
  id: string; applicationId: string; reviewId: string; studentId: string;
  serviceMonth: string; effectiveFrom: string; revision: number; baseFingerprint: string;
  status: "DRAFT" | "SUBMITTED" | "CONFIRMED" | "STALE";
  runs: PlanRun[]; impacts: PlanImpact[]; notices: PlanNoticePreview[]; issues: PlanIssue[];
  noticeDelivery?: { enabled: boolean; items: Array<{studentId:string;status:string}> };
  canConfirm: boolean; updatedAt?: string; previewHash?: string;
};
