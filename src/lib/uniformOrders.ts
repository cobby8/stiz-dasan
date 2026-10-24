// 유니폼 신청 화면은 DB 를 읽는다. 구글 시트 직접 읽기(readUniformOrderSheet)는 호출처가 없어 2026-10-06 삭제했다(Phase 2 시트 종료).
// 아래 파서는 과거 시트 자료를 옮길 때 쓰던 것으로, 테스트가 분류 규칙을 고정하고 있어 남겨 둔다.

export const UNIFORM_SPREADSHEET_ID = "1g0mv8yjiX1b7kU9Hxbu2snoMBqrql4ECwRywMe5hFk0";
export const UNIFORM_SHEET_NAME = "설문지 응답 시트1";

export type UniformOrderStatus =
  | "NEW"
  | "PAYMENT_REVIEW"
  | "ORDERED"
  | "ARRIVED"
  | "LEGACY_REVIEW";

export type UniformOrderRow = {
  rowNumber: number;
  submittedAt: string;
  branch: string;
  design: string;
  studentName: string;
  initials: string;
  backNumber: string;
  topSize: string;
  bottomSize: string;
  depositor: string;
  orderAcceptedAt: string;
  paidAt: string;
  paidAmount: string;
  academyArrivedAt: string;
  status: UniformOrderStatus;
  issues: string[];
};

function cell(row: unknown[], index: number) {
  return String(row[index] ?? "").trim();
}

function submittedYear(value: string) {
  const match = value.match(/(20\d{2})/);
  return match ? Number(match[1]) : null;
}

export function parseUniformOrderRows(values: unknown[][]): UniformOrderRow[] {
  return values.slice(1).map((row, index) => {
    const submittedAt = cell(row, 0);
    const branch = cell(row, 1);
    const orderAcceptedAt = cell(row, 10);
    const paidAt = cell(row, 11);
    const paidAmount = cell(row, 12);
    const academyArrivedAt = cell(row, 14);
    const issues: string[] = [];

    if (!branch) issues.push("지점 미입력");
    if (!cell(row, 3)) issues.push("학생명 미입력");
    if (!cell(row, 6) || !cell(row, 7)) issues.push("사이즈 미입력");
    if (!paidAt && !paidAmount) issues.push("입금 확인 필요");

    let status: UniformOrderStatus;
    if (academyArrivedAt) status = "ARRIVED";
    else if (orderAcceptedAt) status = "ORDERED";
    else if ((submittedYear(submittedAt) ?? 0) < 2026) status = "LEGACY_REVIEW";
    else if (!paidAt && !paidAmount) status = "PAYMENT_REVIEW";
    else status = "NEW";

    return {
      rowNumber: index + 2,
      submittedAt,
      branch,
      design: cell(row, 2),
      studentName: cell(row, 3),
      initials: cell(row, 4),
      backNumber: cell(row, 5),
      topSize: cell(row, 6),
      bottomSize: cell(row, 7),
      depositor: cell(row, 9),
      orderAcceptedAt,
      paidAt,
      paidAmount,
      academyArrivedAt,
      status,
      issues,
    };
  });
}
