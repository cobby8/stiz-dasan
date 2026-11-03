/** 화면에서 공유하는 형태만 둔다. 인증·해시·DB 코드는 서버 파일에 둔다. */
export type ShuttleReviewProposal = { dayOfWeek: string; direction: "PICKUP" | "DROPOFF"; time: string };
export type ShuttleReview = {
  id: string; driverUserId: string; driverName: string;
  status: "PENDING" | "PROPOSED" | "NEEDS_CONFIRMATION" | "STALE";
  note: string | null; proposals: ShuttleReviewProposal[];
  requestedAt: string; reviewedAt: string | null;
};
export type ShuttleIntakeItem = {
  applicationId: string; studentId: string; studentName: string; grade: string | null;
  requestedStartOn: string | null; requestedTime: string | null;
  classes: { id: string; name: string; dayOfWeek: string; startTime: string; endTime: string }[];
  locations: { kind: string; name: string; address: string; latitude: number; longitude: number }[];
  fingerprint: string;
  progress: { status: string; label: string; detail: string; rosterHref: string; dispatchHref: string };
  review: ShuttleReview | null;
};
export type ShuttleIntakeDashboard = { serviceMonth: string; items: ShuttleIntakeItem[]; drivers?: { id: string; name: string }[]; page: number; hasMore: boolean };
export type ShuttleIntakeDriver = { id: string; name: string };
