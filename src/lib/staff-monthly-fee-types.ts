export type StaffMonthlyFeeSummary = {
  rosterId: string;
  studentId: string | null;
  amount: number | null;
  status: 'UNPAID' | 'PAID' | 'PENDING_CONFIRMATION' | 'UNISSUED' | 'REVIEW' | 'UNKNOWN';
  statusLabel: string;
  sourceLabel: string;
  note: string | null;
  paymentIds: string[];
  period: 'MONTHLY' | 'SEASONAL';
};

export type StaffSessionMonthlyFees = { month: string; items: StaffMonthlyFeeSummary[] };
