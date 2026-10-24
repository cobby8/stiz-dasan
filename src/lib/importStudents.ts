/**
 * 구글 스프레드시트 수강생 CSV 데이터 파싱 및 변환 유틸리티
 *
 * 스프레드시트에서 복사한 CSV(탭 구분)를 파싱하여
 * 학부모(User), 학생(Student), 수강(Enrollment), 결제(Payment) 데이터로 변환한다.
 *
 * 핵심 로직:
 * 1. CSV 파싱 → 빈 행 제거
 * 2. 이름+학부모전화번호로 그룹핑 → 같은 학생의 행 모으기
 * 3. 각 그룹에서 대표 행(최신 월) 선택 → 같은 월 행 전체를 청구 계산에 사용
 * 4. 2호점 데이터 우선 (1호점 폐점)
 * 5. 결제방법에서 상태/결제수단 분리
 * 6. 수업선택에서 교시 추출 → slotKey 변환
 *
 * ⚠️ 청구 금액 주의 (2026-07-26 수정)
 * 시트는 "한 학생이 수업 1개당 1행"이라 주3회 학생은 3행이다.
 * 예전에는 대표 행 1건의 수강료만 청구해 주2회 이상 학생이 크게 과소 청구됐다.
 * 금액 계산 규칙은 전부 `studentBilling.ts`에 모아 두었고 회귀 테스트로 방어한다.
 */

import {
  cleanSheetString,
  findSheetValue,
  normalizePhoneDigits,
} from "@/lib/studentSheetMatching";
import {
  studentGroupKey,
  summarizeStudentBilling,
  type BillingPaymentMethod,
  type BillingRow,
} from "@/lib/studentBilling";

// ──────────────────────────────────────────────
// 타입 정의
// ──────────────────────────────────────────────

/** CSV 원본 한 행의 데이터 (47개 컬럼 중 주요 컬럼만 추출) */
export interface RawCsvRow {
  rowNumber: number;         // CSV 원본 행 번호 (디버깅용)
  branch: string;            // 지점 (1호점/2호점)
  name: string;              // 학생 이름
  gender: string | null;     // 학생 성별
  birthDate: string | null;  // 생년월일 ("2016. 8. 22" 형태)
  phone: string | null;      // 학생 전화번호
  parentName: string | null; // 학부모 이름
  parentPhone: string | null;// 학부모 전화번호
  school: string | null;     // 학교명
  grade: string | null;      // 학년
  address: string | null;    // 주소
  enrollDate: string | null; // 등록일
  paymentMethod: string | null; // 결제방법 (랠리즈/카드/휴원/퇴원 등 혼합)
  amount: number | null;     // `결제액` 칸 (실제 납부액. 대부분 비어 있음)
  tuitionAmount: number | null;   // `수강료` 칸 — 청구의 기준 금액
  shuttleFee: number | null;      // `셔틀비` 칸 — 월 단위 값이라 첫 행에만 적힌다
  shuttleFeeCategory: string | null; // `셔틀비 구분` — 무료셔틀 등 명시적 운영 구분
  carryOverAmount: number | null; // `이월` 금액 칸 — 채워져 있으면 차감
  referralSource: string | null; // 가입경로
  uniformStatus: string | null;  // 유니폼 상태
  classSelections: string[];  // 수업선택 컬럼들 (요일별 교시)
  year: number | null;       // 연도
  month: number | null;      // 월
}

/** 변환된 학생 데이터 (DB 삽입 준비 완료) */
export interface TransformedStudent {
  // 학부모 정보
  parentName: string;
  parentPhone: string;

  // 학생 정보
  name: string;
  birthDate: Date | null;
  gender: string | null;
  phone: string | null;
  school: string | null;
  grade: string | null;
  address: string | null;
  enrollDate: Date | null;
  referralSource: string | null;
  uniformStatus: string | null;

  // 수강 상태
  status: "ACTIVE" | "PAUSED" | "WITHDRAWN";

  // 결제 정보
  paymentMethod: BillingPaymentMethod | null;
  /** 최종 청구액 = 수강료 합계 + 셔틀비 - 이월 (0 미만 없음) */
  amount: number | null;
  /** 청구 내역 분해 — 관리자 미리보기와 사후 검증용 */
  tuitionTotal: number;
  shuttleFeeTotal: number;
  carryOverTotal: number;
  /** 납부 완료 행과 미납 행이 섞여 있어 운영자 확인이 필요한 학생 */
  needsPaymentReview: boolean;
  year: number | null;
  month: number | null;

  // 수업 슬롯 키 목록 (예: ["Mon-4", "Wed-3"]) — 같은 월 행 전체의 합집합
  slotKeys: string[];
  /** Payment.classId에 넣을 대표 반 slotKey (수강료가 가장 큰 행 기준) */
  billingSlotKey: string | null;

  // 원본 행 번호 (대표 행. 디버깅용)
  rowNumber: number;
  /** 청구 계산에 실제로 들어간 원본 행 번호 전체 */
  billingRowNumbers: number[];
  branch: string;
}

export interface StudentRegistrationSheetRow {
  rowNumber: number;
  raw: Record<string, string>;
  rowHash: string;
  studentKey: string | null;
  branch: string | null;
  applicationAt: Date | null;
  paymentDate: Date | null;
  registrationMonth: string | null;
  studentName: string;
  studentGender: string | null;
  grade: string | null;
  uniformStatus: string | null;
  paymentMethod: string | null;
  paymentAmount: number | null;
  tuitionAmount: number | null;
  shuttleFee: number | null;
  carryOverAmount: number | null;
  shuttleNeeded: boolean;
  shuttlePickup: string | null;
  shuttlePreferredTime: string | null;
  shuttleDropoff: string | null;
  selectedSlotKeys: string[];
  birthDate: Date | null;
  parentName: string | null;
  studentPhone: string | null;
  parentPhone: string | null;
  address: string | null;
  school: string | null;
  basketballExp: string | null;
  hopeNote: string | null;
  referralSource: string | null;
  agreedPrivacy: boolean;
  agreedTerms: boolean;
  agreementJSON: Record<string, string | boolean>;
  enrollmentPeriod: string | null;
  status: "ACTIVE" | "PAUSED" | "WITHDRAWN";
}

export interface StudentRegistrationSheetParseResult {
  headers: string[];
  rows: StudentRegistrationSheetRow[];
  summary: {
    totalRows: number;
    uniqueStudentKeys: number;
    missingStudentKeyRows: number;
    activeCount: number;
    pausedCount: number;
    withdrawnCount: number;
  };
  errors: { rowNumber: number; reason: string }[];
}

export interface StudentShuttleSheetRow {
  rowNumber: number;
  sheetName: string;
  raw: Record<string, string>;
  rowHash: string;
  studentKey: string | null;
  monthLabel: string;
  studentName: string | null;
  studentPhone: string | null;
  parentPhone: string | null;
  dayLabel: string | null;
  classTime: string | null;
  arrivalTime: string | null;
  destination: string | null;
  note: string | null;
  memo: string | null;
}

export interface StudentChangeSheetRow {
  rowNumber: number;
  sheetName: string;
  raw: Record<string, string>;
  rowHash: string;
  occurredAt: Date | null;
  changeSummary: string | null;
  registrationReflected: boolean;
  rallyzReflected: boolean;
  vehicleReflected: boolean;
  alarmStatus: string | null;
  note: string | null;
}

export interface StudentTeamRosterSheetRow {
  rowNumber: number;
  sheetName: string;
  raw: Record<string, string>;
  rowHash: string;
  studentKey: string | null;
  studentName: string;
  birthDate: Date | null;
  jerseyNumber: string | null;
  phone: string | null;
  grade: string | null;
  branch: string | null;
  eventColumnsJSON: Record<string, string>;
}

export interface StudentAuxiliarySheetsParseResult {
  shuttleRows: StudentShuttleSheetRow[];
  changeRows: StudentChangeSheetRow[];
  teamRows: StudentTeamRosterSheetRow[];
  summary: {
    shuttleRows: number;
    changeRows: number;
    teamRows: number;
    totalRows: number;
  };
  errors: { sheetName: string; rowNumber: number; reason: string }[];
}

/** 이관 미리보기 결과 */
export interface ImportPreviewResult {
  students: TransformedStudent[];
  summary: {
    totalRows: number;       // CSV 전체 행 수
    uniqueStudents: number;  // 중복 제거 후 학생 수
    activeCount: number;     // 재원 중
    pausedCount: number;     // 휴원
    withdrawnCount: number;  // 퇴원
    branch1Count: number;    // 1호점
    branch2Count: number;    // 2호점
  };
  errors: { rowNumber: number; reason: string }[];
}

// ──────────────────────────────────────────────
// 요일 매핑: 스프레드시트 컬럼 헤더 → slotKey 접두사
// ──────────────────────────────────────────────

// 스프레드시트의 수업선택 컬럼은 "[월요일]", "[화요일]" 등의 헤더를 가진다
// 각 셀에는 "4교시" 같은 값이 들어있다
// 이를 "Mon-4" 같은 slotKey로 변환한다
const DAY_MAP: Record<string, string> = {
  "월요일": "Mon",
  "화요일": "Tue",
  "수요일": "Wed",
  "목요일": "Thu",
  "금요일": "Fri",
  "토요일": "Sat",
  "일요일": "Sun",
};

// ──────────────────────────────────────────────
// CSV 파싱 함수
// ──────────────────────────────────────────────

/**
 * CSV 텍스트를 2차원 배열로 파싱
 * - 탭 구분자(\t) 또는 쉼표(,) 자동 감지
 * - 큰따옴표 안의 구분자는 무시
 */
function parseCsvText(csvText: string): string[][] {
  if (!csvText.trim()) return [];

  const firstLine = csvText.split(/\r?\n/, 1)[0] || "";
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter = tabCount >= commaCount ? "\t" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let current = "";
  let inQuotes = false;

  const pushCell = () => {
    row.push(current.trim());
    current = "";
  };

  const pushRow = () => {
    if (row.some((cell) => cell.trim())) rows.push(row);
    row = [];
  };

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      pushCell();
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      pushCell();
      pushRow();
      if (ch === "\r" && next === "\n") i++;
      continue;
    }

    current += ch;
  }

  pushCell();
  pushRow();
  return rows;
}

/**
 * 스프레드시트 날짜 문자열을 Date 객체로 변환
 * 지원 형식: "2016. 8. 22", "2016.8.22", "2016-08-22", "2016/08/22"
 */
function parseSpreadsheetDate(raw: string | null): Date | null {
  if (!raw || raw.trim() === "") return null;

  const cleaned = raw.trim();

  // "2016. 8. 22" 형태 (스프레드시트 기본 형식)
  const spaceMatch = cleaned.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (spaceMatch) {
    const [, y, m, d] = spaceMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  // "2016.8.22" 또는 "2016-08-22" 또는 "2016/08/22"
  const normalMatch = cleaned.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (normalMatch) {
    const [, y, m, d] = normalMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  // ISO 형태 시도
  const date = new Date(cleaned);
  return isNaN(date.getTime()) ? null : date;
}

function parseLooseDate(raw: string | null): Date | null {
  if (!raw || !raw.trim()) return null;
  const direct = parseSpreadsheetDate(raw);
  if (direct) return direct;

  const cleaned = raw.trim();
  const koreanDateTime = cleaned.match(
    /^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\s+(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i
  );
  if (koreanDateTime) {
    const [, y, m, d, meridiem, hh = "0", mm = "0", ss = "0"] = koreanDateTime;
    let hour = Number(hh);
    const marker = (meridiem || "").toUpperCase();
    if ((marker === "오후" || marker === "PM") && hour < 12) hour += 12;
    if ((marker === "오전" || marker === "AM") && hour === 12) hour = 0;
    return new Date(Number(y), Number(m) - 1, Number(d), hour, Number(mm), Number(ss));
  }

  const parsed = new Date(cleaned);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function parseYearMonth(raw: string | null): { year: number | null; month: number | null } {
  if (!raw || !raw.trim()) return { year: null, month: null };
  const match = raw.trim().match(/(?:(\d{4})\s*년?)?\s*(\d{1,2})\s*월/);
  if (!match) return { year: null, month: null };
  return {
    year: match[1] ? Number(match[1]) : null,
    month: Number(match[2]),
  };
}

/**
 * 결제방법 문자열에서 수강 상태를 분리
 * - "휴원" → PAUSED
 * - "퇴원" → WITHDRAWN
 * - 나머지 (랠리즈, 카드결제, 현금영수증, 미결제, 추가수강 등) → ACTIVE
 */
function extractStatus(paymentMethod: string | null): "ACTIVE" | "PAUSED" | "WITHDRAWN" {
  if (!paymentMethod) return "ACTIVE";
  const trimmed = paymentMethod.trim();
  if (trimmed.includes("휴원")) return "PAUSED";
  if (trimmed.includes("퇴원")) return "WITHDRAWN";
  return "ACTIVE";
}

// 결제방법 → 결제수단(RALLYZ/CARD/CASH/UNPAID) 변환은
// 금액 계산과 같은 규칙으로 묶어 두기 위해 `studentBilling.ts`의
// `classifyPaymentMethod`로 옮겼다. (여러 행의 대표값 선정까지 함께 처리한다)

/**
 * 수업선택 셀에서 교시를 추출하여 slotKey 배열로 변환
 * - 입력: 요일별 컬럼 헤더와 셀 값의 쌍
 * - "4교시" → 숫자 4 추출
 * - 요일 + 교시번호 = "Mon-4" 형태의 slotKey
 */
function extractSlotKeys(
  dayHeaders: string[],
  dayValues: string[]
): string[] {
  const keys: string[] = [];

  for (let i = 0; i < dayHeaders.length; i++) {
    const header = dayHeaders[i] || "";
    const value = dayValues[i] || "";

    if (!value.trim()) continue;

    // 헤더에서 요일 추출: "[월요일]" → "월요일"
    const dayMatch = header.match(/\[?([월화수목금토일]요일)\]?/);
    if (!dayMatch) continue;

    const dayPrefix = DAY_MAP[dayMatch[1]];
    if (!dayPrefix) continue;

    // 셀 값에서 교시 번호 추출: "4교시" → 4
    const periodMatch = value.match(/(\d+)\s*교시/);
    if (periodMatch) {
      keys.push(`${dayPrefix}-${periodMatch[1]}`);
    }
  }

  return keys;
}

/**
 * 금액 문자열을 숫자로 변환
 * "150,000" → 150000, "150000" → 150000
 */
function parseAmount(raw: string | null): number | null {
  if (!raw || raw.trim() === "") return null;
  const cleaned = raw.replace(/[,\s원]/g, "");
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * 금액 컬럼 하나를 안전하게 읽는다.
 * 컬럼 자동 감지에 실패해 인덱스가 -1이면 null을 돌려준다.
 * (예전처럼 `row[-1]`을 읽어 undefined가 흘러가면 금액이 조용히 0이 된다)
 */
function readAmountColumn(row: string[], index: number): number | null {
  if (index === -1) return null;
  return parseAmount(row[index] ?? null);
}

/**
 * 생년월일을 학생 묶음 키로 쓸 수 있는 `YYYY-MM-DD` 문자열로 바꾼다.
 * `parseSpreadsheetDate`가 로컬 자정으로 만든 Date라 UTC 변환 없이 그대로 읽는다.
 */
function toBirthKey(date: Date | null): string | null {
  if (!date || isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalizePhone(raw: string | null): string {
  return normalizePhoneDigits(raw);
}

function cleanString(raw: string | null | undefined): string | null {
  return cleanSheetString(raw);
}

function findHeaderValue(record: Record<string, string>, ...labels: string[]) {
  return findSheetValue(record, ...labels);
}

function toAgreementBool(raw: string | null | undefined): boolean {
  const value = (raw || "").trim();
  if (!value) return false;
  return /(동의|확인|예|yes|true|y)/i.test(value) && !/(미동의|거부|아니오|false|n)/i.test(value);
}

function toShuttleNeeded(raw: string | null | undefined): boolean {
  const value = (raw || "").trim();
  if (!value) return false;
  if (/(미탑승|안함|없음|아니오|no|false)/i.test(value)) return false;
  return /(탑승|이용|희망|예|yes|true)/i.test(value);
}

function stableHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}

function normalizeHeaderKey(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function detectHeaderRow(rows: string[][], expectedLabels: string[]): number {
  const normalizedLabels = expectedLabels.map(normalizeHeaderKey);
  for (let i = 0; i < rows.length; i++) {
    const normalizedRow = rows[i].map(normalizeHeaderKey);
    const matchCount = normalizedLabels.filter((label) =>
      normalizedRow.some((header) => header.includes(label))
    ).length;
    if (matchCount >= Math.min(2, normalizedLabels.length)) {
      return i;
    }
  }
  return 0;
}

function buildSheetRecord(headers: string[], row: string[]): Record<string, string> {
  return headers.reduce<Record<string, string>>((acc, header, index) => {
    acc[header] = row[index] || "";
    return acc;
  }, {});
}

function toSheetBool(raw: string | null | undefined): boolean {
  const value = (raw || "").trim();
  if (!value) return false;
  if (/(미완료|미반영|아니오|false|no|x|×)/i.test(value)) return false;
  return /(완료|반영|확인|예|true|yes|y|o|v|✓|✔|✅)/i.test(value);
}

function extractMonthLabel(sheetName: string): string {
  const match = sheetName.match(/(\d{1,2})\s*월/);
  return match ? `${match[1]}월` : sheetName;
}

// ──────────────────────────────────────────────
// 메인 변환 함수
// ──────────────────────────────────────────────

/**
 * CSV 텍스트를 파싱하여 이관용 데이터로 변환
 *
 * 처리 흐름:
 * 1. CSV 텍스트 → 2차원 배열
 * 2. 헤더 행에서 컬럼 인덱스 매핑
 * 3. 각 데이터 행을 RawCsvRow로 변환
 * 4. 이름+학부모전화번호로 그룹핑 (같은 학생 중복 제거)
 * 5. 각 그룹에서 대표 행 선택 (2호점 우선, 최신 월 우선)
 * 6. TransformedStudent 배열 반환
 *
 * @param csvText - 스프레드시트에서 복사하거나 다운로드한 CSV 텍스트
 * @param columnMapping - 컬럼 이름 → 인덱스 매핑 (자동 감지 실패 시 수동 지정)
 */
export function parseAndTransformCsv(csvText: string): ImportPreviewResult {
  const rows = parseCsvText(csvText);
  if (rows.length < 2) {
    return {
      students: [],
      summary: {
        totalRows: 0,
        uniqueStudents: 0,
        activeCount: 0,
        pausedCount: 0,
        withdrawnCount: 0,
        branch1Count: 0,
        branch2Count: 0,
      },
      errors: [{ rowNumber: 0, reason: "데이터가 없거나 헤더만 있습니다." }],
    };
  }

  // 1단계: 헤더에서 컬럼 인덱스 자동 감지
  const headers = rows[0];
  const colIndex = detectColumnIndices(headers);
  const errors: { rowNumber: number; reason: string }[] = [];

  // 필수 컬럼 확인
  if (colIndex.name === -1) {
    return {
      students: [],
      summary: {
        totalRows: rows.length - 1,
        uniqueStudents: 0,
        activeCount: 0,
        pausedCount: 0,
        withdrawnCount: 0,
        branch1Count: 0,
        branch2Count: 0,
      },
      errors: [{ rowNumber: 1, reason: "이름 컬럼을 찾을 수 없습니다. 헤더를 확인해주세요." }],
    };
  }

  // 청구 기준은 `수강료` 칸이다. 그 칸이 없는 옛 형식 CSV라면
  // `결제액` 칸을 대신 쓴다(돈이 통째로 0이 되는 것보다 낫다).
  const tuitionColumn =
    colIndex.tuitionAmount !== -1 ? colIndex.tuitionAmount : colIndex.paymentAmount;
  if (colIndex.tuitionAmount === -1 && colIndex.paymentAmount !== -1) {
    errors.push({
      rowNumber: 1,
      reason: "`수강료` 컬럼이 없어 `결제액` 컬럼을 청구 기준으로 사용했습니다. 금액을 꼭 확인해주세요.",
    });
  }
  if (tuitionColumn === -1) {
    errors.push({
      rowNumber: 1,
      reason: "`수강료`/`결제액` 컬럼을 찾지 못해 청구 금액이 0으로 계산됩니다. 헤더를 확인해주세요.",
    });
  }

  // 2단계: 데이터 행을 RawCsvRow로 변환
  const rawRows: RawCsvRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1; // 엑셀 기준 행번호

    try {
      const name = (row[colIndex.name] || "").trim();
      if (!name) continue; // 이름 없는 행은 건너뛰기

      rawRows.push({
        rowNumber,
        branch: (row[colIndex.branch] || "").trim(),
        name,
        gender: colIndex.gender !== -1 ? row[colIndex.gender] || null : null,
        birthDate: row[colIndex.birthDate] || null,
        phone: row[colIndex.phone] || null,
        parentName: row[colIndex.parentName] || null,
        parentPhone: row[colIndex.parentPhone] || null,
        school: row[colIndex.school] || null,
        grade: row[colIndex.grade] || null,
        address: row[colIndex.address] || null,
        enrollDate: row[colIndex.enrollDate] || null,
        paymentMethod: row[colIndex.paymentMethod] || null,
        amount: readAmountColumn(row, colIndex.paymentAmount),
        tuitionAmount: readAmountColumn(row, tuitionColumn),
        shuttleFee: readAmountColumn(row, colIndex.shuttleFee),
        shuttleFeeCategory: colIndex.shuttleFeeCategory !== -1
          ? row[colIndex.shuttleFeeCategory] || null
          : null,
        carryOverAmount: readAmountColumn(row, colIndex.carryOverAmount),
        referralSource: row[colIndex.referralSource] || null,
        uniformStatus: row[colIndex.uniformStatus] || null,
        classSelections: colIndex.dayColumns.map((idx) => row[idx] || ""),
        year: colIndex.year !== -1
          ? Number(row[colIndex.year]) || null
          : parseYearMonth(colIndex.registrationMonth !== -1 ? row[colIndex.registrationMonth] || null : null).year,
        month: colIndex.month !== -1
          ? Number(row[colIndex.month]) || null
          : parseYearMonth(colIndex.registrationMonth !== -1 ? row[colIndex.registrationMonth] || null : null).month,
      });
    } catch (err) {
      errors.push({
        rowNumber,
        reason: err instanceof Error ? err.message : "행 파싱 실패",
      });
    }
  }

  // 3단계: 같은 학생의 행 모으기
  // 같은 학생이 월별로도, 수업별로도 여러 행에 등장한다.
  // 학부모 전화번호는 행마다 부/모가 갈려 적히는 경우가 있어 기준으로 쓸 수 없다.
  // (전화번호로 묶으면 한 학생이 둘로 쪼개져 수강료가 반토막 난다)
  const groupKey = (r: RawCsvRow) =>
    studentGroupKey({
      name: r.name,
      birthDateISO: toBirthKey(parseSpreadsheetDate(r.birthDate)),
      parentPhone: r.parentPhone,
    });

  const groups = new Map<string, RawCsvRow[]>();
  for (const raw of rawRows) {
    const key = groupKey(raw);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(raw);
  }

  // 4단계: 각 그룹에서 대표 행 선택 + 같은 달 행 전체로 청구액 계산
  // 우선순위: (1) 2호점 > 1호점 (1호점 폐점), (2) 최신 월
  const students: TransformedStudent[] = [];
  const dayHeaders = colIndex.dayColumns.map((idx) => headers[idx] || "");

  for (const [, group] of groups) {
    // 2호점 행이 있으면 2호점만 남기기
    const branch2 = group.filter((r) => r.branch.includes("2"));
    const candidates = branch2.length > 0 ? branch2 : group;

    // 최신 월 기준 정렬 (연도*12+월 내림차순)
    candidates.sort((a, b) => {
      const scoreA = (a.year || 0) * 12 + (a.month || 0);
      const scoreB = (b.year || 0) * 12 + (b.month || 0);
      return scoreB - scoreA;
    });

    const best = candidates[0];

    // ⚠️ 여기가 핵심 — 청구는 "대표 행 1건"이 아니라 "같은 달 행 전체"로 계산한다.
    // 시트에 여러 달이 섞여 들어올 수 있으므로 반드시 같은 연/월 행만 모은다.
    // (달을 안 나누면 7월치와 8월치가 한 청구서에 합쳐지는 대형 사고가 난다)
    const monthRows = candidates.filter(
      (r) => r.year === best.year && r.month === best.month
    );

    if (monthRows.length < candidates.length) {
      // 다른 달 행이 섞여 있어 제외했다는 사실을 운영자가 알 수 있게 남긴다.
      console.warn(
        `[import-students] ${best.name}: 등록 행 ${candidates.length}건 중 ` +
          `${best.year}년 ${best.month}월 ${monthRows.length}건만 청구에 반영했습니다.`
      );
    }

    // 수업선택 → slotKey. 청구 계산에도 일8 대표팀 셔틀비 면제 판정이 필요하다.
    const slotKeysByRow = new Map<number, string[]>();
    for (const r of monthRows) {
      slotKeysByRow.set(r.rowNumber, extractSlotKeys(dayHeaders, r.classSelections));
    }

    // 청구 금액 계산 (수강료 합계 + 셔틀비 - 이월, 0 미만 없음)
    const billing = summarizeStudentBilling(
      monthRows.map<BillingRow>((r) => ({
        rowNumber: r.rowNumber,
        paymentMethodRaw: r.paymentMethod,
        tuitionAmount: r.tuitionAmount,
        shuttleFee: r.shuttleFee,
        isFreeShuttle: (r.shuttleFeeCategory || "").includes("무료셔틀"),
        carryOverAmount: r.carryOverAmount,
        slotKeys: slotKeysByRow.get(r.rowNumber) ?? [],
      }))
    );

    if (billing.mixedPaymentMethods) {
      console.warn(
        `[import-students] ${best.name}: 납부 완료 행과 미납 행이 섞여 있어 미납으로 청구했습니다. 수동 확인 필요.`
      );
    }

    // 주3회 학생은 행마다 요일이 다르므로 전 행의 슬롯을 합집합한다.
    const slotKeys = [...new Set(monthRows.flatMap((r) => slotKeysByRow.get(r.rowNumber) ?? []))];

    // 대표 반: 수강료가 가장 큰 행(= 주력 수업), 동률이면 원본 행 번호가 빠른 쪽.
    // Payment는 학생당 월 1건이라 classId도 1개만 넣을 수 있다.
    const billingRow = [...monthRows]
      .filter((r) => billing.countedRowNumbers.includes(r.rowNumber))
      .sort(
        (a, b) =>
          (b.tuitionAmount ?? 0) - (a.tuitionAmount ?? 0) || a.rowNumber - b.rowNumber
      )[0];
    const billingSlotKey =
      (billingRow ? slotKeysByRow.get(billingRow.rowNumber)?.[0] : null) ??
      slotKeys[0] ??
      null;

    // 상태는 대표 행 기준 (기존 동작 유지)
    const status = extractStatus(best.paymentMethod);

    // 학부모 이름/전화번호 기본값 처리
    const parentName = (best.parentName || "").trim() || best.name + " 보호자";
    const parentPhone = (best.parentPhone || "").replace(/[^0-9]/g, "");

    students.push({
      parentName,
      parentPhone: parentPhone || "00000000000",
      name: best.name,
      birthDate: parseSpreadsheetDate(best.birthDate),
      gender: best.gender?.trim() || null,
      phone: best.phone?.trim() || null,
      school: best.school?.trim() || null,
      grade: best.grade?.trim() || null,
      address: best.address?.trim() || null,
      enrollDate: parseSpreadsheetDate(best.enrollDate),
      referralSource: best.referralSource?.trim() || null,
      uniformStatus: best.uniformStatus?.trim() || null,
      status,
      paymentMethod: billing.paymentMethod,
      amount: billing.billableAmount,
      tuitionTotal: billing.tuitionTotal,
      shuttleFeeTotal: billing.shuttleFeeTotal,
      carryOverTotal: billing.carryOverTotal,
      needsPaymentReview: billing.mixedPaymentMethods,
      year: best.year,
      month: best.month,
      slotKeys,
      billingSlotKey,
      rowNumber: best.rowNumber,
      billingRowNumbers: billing.countedRowNumbers,
      branch: best.branch,
    });
  }

  // 요약 통계
  const summary = {
    totalRows: rawRows.length,
    uniqueStudents: students.length,
    activeCount: students.filter((s) => s.status === "ACTIVE").length,
    pausedCount: students.filter((s) => s.status === "PAUSED").length,
    withdrawnCount: students.filter((s) => s.status === "WITHDRAWN").length,
    branch1Count: students.filter((s) => s.branch.includes("1")).length,
    branch2Count: students.filter((s) => s.branch.includes("2")).length,
  };

  return { students, summary, errors };
}

// ──────────────────────────────────────────────
// 컬럼 인덱스 자동 감지
// ──────────────────────────────────────────────

interface ColumnIndices {
  branch: number;
  name: number;
  gender: number;
  birthDate: number;
  phone: number;
  parentName: number;
  parentPhone: number;
  school: number;
  grade: number;
  address: number;
  enrollDate: number;
  paymentMethod: number;
  /** `수강료` 칸 — 청구 기준 금액 */
  tuitionAmount: number;
  /** `결제액` 칸 — 실제 납부액 (참고용) */
  paymentAmount: number;
  /** `셔틀비` 칸 */
  shuttleFee: number;
  /** `셔틀비 구분` 칸 */
  shuttleFeeCategory: number;
  /** `이월` 금액 칸 */
  carryOverAmount: number;
  referralSource: number;
  uniformStatus: number;
  registrationMonth: number;
  year: number;
  month: number;
  dayColumns: number[]; // 요일별 수업선택 컬럼 인덱스들
}

/**
 * 헤더 행에서 각 컬럼의 인덱스를 자동 감지
 *
 * 스프레드시트의 컬럼 이름이 약간씩 다를 수 있으므로
 * 키워드 기반으로 유연하게 매칭한다.
 */
function detectColumnIndices(headers: string[]): ColumnIndices {
  const result: ColumnIndices = {
    branch: -1,
    name: -1,
    gender: -1,
    birthDate: -1,
    phone: -1,
    parentName: -1,
    parentPhone: -1,
    school: -1,
    grade: -1,
    address: -1,
    enrollDate: -1,
    paymentMethod: -1,
    tuitionAmount: -1,
    paymentAmount: -1,
    shuttleFee: -1,
    shuttleFeeCategory: -1,
    carryOverAmount: -1,
    referralSource: -1,
    uniformStatus: -1,
    registrationMonth: -1,
    year: -1,
    month: -1,
    dayColumns: [],
  };

  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || "").trim();
    const lower = h.toLowerCase();

    // 지점
    if (h.includes("지점") || h.includes("호점") || lower.includes("branch")) {
      result.branch = i;
    }
    // 성별
    else if (h.includes("성별") || lower.includes("gender")) {
      result.gender = i;
    }
    // 이름 (학생 이름) — "이름" 포함하되 "부모"/"보호자"/"학부모" 미포함
    else if (
      (h.includes("이름") || h.includes("성명") || lower === "name") &&
      !h.includes("부모") &&
      !h.includes("보호자") &&
      !h.includes("학부모")
    ) {
      if (result.name === -1) result.name = i; // 첫 번째 매칭만
    }
    // 생년월일
    else if (h.includes("생년월일") || h.includes("생일") || lower.includes("birth")) {
      result.birthDate = i;
    }
    // 학생 전화번호 — "전화" 포함하되 "부모"/"보호자" 미포함
    else if (
      (h.includes("전화") || h.includes("연락처") || h.includes("휴대폰")) &&
      !h.includes("부모") &&
      !h.includes("보호자") &&
      !h.includes("학부모")
    ) {
      if (result.phone === -1) result.phone = i;
    }
    // 학부모 이름
    else if (
      (h.includes("부모") || h.includes("보호자") || h.includes("학부모")) &&
      (h.includes("이름") || h.includes("성명"))
    ) {
      result.parentName = i;
    }
    // 학부모 전화번호
    else if (
      (h.includes("부모") || h.includes("보호자") || h.includes("학부모")) &&
      (h.includes("전화") || h.includes("연락처") || h.includes("번호"))
    ) {
      result.parentPhone = i;
    }
    // 학교
    else if (h.includes("학교") || lower.includes("school")) {
      result.school = i;
    }
    // 학년
    else if (h.includes("학년") || lower.includes("grade")) {
      result.grade = i;
    }
    // 주소
    else if (h.includes("주소") || lower.includes("address")) {
      result.address = i;
    }
    // 등록일/입회일
    else if (h.includes("등록일") || h.includes("입회일") || h.includes("가입일")) {
      result.enrollDate = i;
    }
    // 결제방법 (금액 칸인 "납부액"은 여기서 잡지 않는다)
    else if (
      h.includes("결제방법") ||
      h.includes("결제수단") ||
      (h.includes("납부") && !h.includes("액") && !h.includes("금액"))
    ) {
      result.paymentMethod = i;
    }
    // ── 금액 칸들 ──
    // 예전에는 결제액/금액/수강료를 전부 하나의 `amount`에 넣어서,
    // 헤더 순서에 따라 마지막에 매칭된 칸이 앞의 칸을 덮어썼다.
    // 청구 기준은 언제나 `수강료`이므로 칸마다 인덱스를 따로 잡고,
    // 각각 처음 매칭된 컬럼만 채택한다(뒤 컬럼이 덮어쓰지 못하게).
    else if (h.includes("수강료")) {
      if (result.tuitionAmount === -1) result.tuitionAmount = i;
    }
    else if (h.includes("셔틀비") && h.includes("구분")) {
      if (result.shuttleFeeCategory === -1) result.shuttleFeeCategory = i;
    }
    else if (h.includes("셔틀비")) {
      if (result.shuttleFee === -1) result.shuttleFee = i;
    }
    else if (h.includes("이월")) {
      if (result.carryOverAmount === -1) result.carryOverAmount = i;
    }
    else if (h.includes("결제액") || h.includes("납부액") || h.includes("금액")) {
      if (result.paymentAmount === -1) result.paymentAmount = i;
    }
    // 가입경로
    else if (h.includes("가입경로") || h.includes("유입경로") || h.includes("알게된")) {
      result.referralSource = i;
    }
    // 유니폼
    else if (h.includes("유니폼") || h.includes("복장")) {
      result.uniformStatus = i;
    }
    // 수강신청 월
    else if (h.includes("수강신청") && h.includes("월")) {
      result.registrationMonth = i;
    }
    // 연도
    else if (h === "연도" || h === "년도" || lower === "year") {
      result.year = i;
    }
    // 월
    else if (h === "월" || lower === "month") {
      result.month = i;
    }
    // 수업선택 요일 컬럼: "[월요일]", "[화요일]" 등
    else if (/\[?[월화수목금토일]요일\]?/.test(h)) {
      result.dayColumns.push(i);
    }
  }

  return result;
}

export function parseRegistrationSheetCsv(csvText: string): StudentRegistrationSheetParseResult {
  const rows = parseCsvText(csvText);
  if (rows.length < 2) {
    return {
      headers: rows[0] ?? [],
      rows: [],
      summary: {
        totalRows: 0,
        uniqueStudentKeys: 0,
        missingStudentKeyRows: 0,
        activeCount: 0,
        pausedCount: 0,
        withdrawnCount: 0,
      },
      errors: [{ rowNumber: 0, reason: "데이터가 없거나 헤더만 있습니다." }],
    };
  }

  const headers = rows[0].map((header, index) => header.trim() || `__col_${index + 1}`);
  const errors: { rowNumber: number; reason: string }[] = [];
  const parsedRows: StudentRegistrationSheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = i + 1;

    try {
      const raw = headers.reduce<Record<string, string>>((acc, header, index) => {
        acc[header] = row[index] || "";
        return acc;
      }, {});
      const studentNameRaw = findHeaderValue(raw, "수강생 이름", "이름", "성명").trim();
      const studentName = studentNameRaw || "(이름 없음)";
      if (!studentNameRaw) {
        errors.push({
          rowNumber,
          reason: "수강생 이름이 비어 있어 원본 행만 저장됩니다.",
        });
      }

      const parentPhone = normalizePhone(findHeaderValue(raw, "학부모 전화번호(숫자만)", "학부모 전화번호", "보호자 전화번호"));
      const studentPhone = normalizePhone(findHeaderValue(raw, "수강생 전화번호(숫자만)", "수강생 전화번호", "학생 전화번호"));
      const parentName = cleanString(findHeaderValue(raw, "학부모 이름", "보호자 이름"));
      const paymentMethod = cleanString(findHeaderValue(raw, "결제방법", "결제수단"));
      const enrollmentPeriod = cleanString(findHeaderValue(raw, "재원기간"));
      const selectedSlotKeys = extractSlotKeys(
        headers.filter((header) => /\[?[월화수목금토일]요일\]?/.test(header)),
        headers.filter((header) => /\[?[월화수목금토일]요일\]?/.test(header)).map((header) => raw[header] || "")
      );
      const privacyRaw = findHeaderValue(raw, "개인정보수집 동의", "개인정보 수집 동의");
      const termsRaw = findHeaderValue(raw, "이용약관");
      const noticeRaw = findHeaderValue(raw, "수강신청확정 안내");
      const cautionRaw = findHeaderValue(raw, "주의사항 확인 및 동의");
      const statusText = [paymentMethod, enrollmentPeriod].filter(Boolean).join(" ");
      const rowHash = stableHash(JSON.stringify(raw));

      parsedRows.push({
        rowNumber,
        raw,
        rowHash,
        studentKey: studentNameRaw && parentPhone ? `${studentNameRaw}__${parentPhone}` : null,
        branch: cleanString(findHeaderValue(raw, "지점을 선택해주세요", "지점")),
        applicationAt: parseLooseDate(findHeaderValue(raw, "타임스탬프")),
        paymentDate: parseLooseDate(findHeaderValue(raw, "결제일")),
        registrationMonth: cleanString(findHeaderValue(raw, "수강신청 월")),
        studentName,
        studentGender: cleanString(findHeaderValue(raw, "수강생 성별", "성별")),
        grade: cleanString(findHeaderValue(raw, "학년", " 학년")),
        uniformStatus: cleanString(findHeaderValue(raw, "유니폼")),
        paymentMethod,
        paymentAmount: parseAmount(findHeaderValue(raw, "결제액")),
        tuitionAmount: parseAmount(findHeaderValue(raw, "수강료")),
        shuttleFee: parseAmount(findHeaderValue(raw, "셔틀비")),
        carryOverAmount: parseAmount(findHeaderValue(raw, "이월")),
        shuttleNeeded: toShuttleNeeded(findHeaderValue(raw, "셔틀탑승 여부")),
        shuttlePickup: cleanString(findHeaderValue(raw, "탑승 장소")),
        shuttlePreferredTime: cleanString(findHeaderValue(raw, "탑승 희망 시간")),
        shuttleDropoff: cleanString(findHeaderValue(raw, "하차 장소")),
        selectedSlotKeys,
        birthDate: parseSpreadsheetDate(findHeaderValue(raw, "수강생 생년월일", "생년월일")),
        parentName,
        studentPhone: studentPhone || null,
        parentPhone: parentPhone || null,
        address: cleanString(findHeaderValue(raw, "주소")),
        school: cleanString(findHeaderValue(raw, "학교명", "학교")),
        basketballExp: cleanString(findHeaderValue(raw, "농구경험")),
        hopeNote: cleanString(findHeaderValue(raw, "바라는 점")),
        referralSource: cleanString(findHeaderValue(raw, "가입경로")),
        agreedPrivacy: toAgreementBool(privacyRaw),
        agreedTerms: toAgreementBool(termsRaw),
        agreementJSON: {
          privacy: privacyRaw,
          confirmationNotice: noticeRaw,
          terms: termsRaw,
          caution: cautionRaw,
          privacyAgreed: toAgreementBool(privacyRaw),
          termsAgreed: toAgreementBool(termsRaw),
          cautionAgreed: toAgreementBool(cautionRaw),
        },
        enrollmentPeriod,
        status: extractStatus(statusText),
      });
    } catch (err) {
      errors.push({
        rowNumber,
        reason: err instanceof Error ? err.message : "등록 행 파싱 실패",
      });
    }
  }

  const studentKeys = new Set(parsedRows.map((row) => row.studentKey).filter(Boolean));
  return {
    headers,
    rows: parsedRows,
    summary: {
      totalRows: parsedRows.length,
      uniqueStudentKeys: studentKeys.size,
      missingStudentKeyRows: parsedRows.filter((row) => !row.studentKey).length,
      activeCount: parsedRows.filter((row) => row.status === "ACTIVE").length,
      pausedCount: parsedRows.filter((row) => row.status === "PAUSED").length,
      withdrawnCount: parsedRows.filter((row) => row.status === "WITHDRAWN").length,
    },
    errors,
  };
}

export function parseShuttleSheetCsv(
  csvText: string,
  sheetName: string
): { rows: StudentShuttleSheetRow[]; errors: { sheetName: string; rowNumber: number; reason: string }[] } {
  const rows = parseCsvText(csvText);
  const errors: { sheetName: string; rowNumber: number; reason: string }[] = [];
  const parsedRows: StudentShuttleSheetRow[] = [];
  if (rows.length < 2) return { rows: parsedRows, errors };

  const headerIndex = detectHeaderRow(rows, ["수강생 이름", "요일", "수업시간", "목적지"]);
  const headers = rows[headerIndex].map((header, index) => header.trim() || `__col_${index + 1}`);
  const monthLabel = extractMonthLabel(sheetName);

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = i + 1;

    try {
      const raw = buildSheetRecord(headers, row);
      const studentName = cleanString(findHeaderValue(raw, "수강생 이름", "이름"));
      const studentPhone = normalizePhone(findHeaderValue(raw, "수강생 전화번호", "학생 전화번호"));
      const parentPhone = normalizePhone(findHeaderValue(raw, "학부모 전화번호", "보호자 전화번호"));
      const studentKey =
        studentName && (parentPhone || studentPhone)
          ? `${studentName}__${parentPhone || studentPhone}`
          : null;

      parsedRows.push({
        rowNumber,
        sheetName,
        raw,
        rowHash: stableHash(JSON.stringify(raw)),
        studentKey,
        monthLabel,
        studentName,
        studentPhone: studentPhone || null,
        parentPhone: parentPhone || null,
        dayLabel: cleanString(findHeaderValue(raw, "요일")),
        classTime: cleanString(findHeaderValue(raw, "수업시간")),
        arrivalTime: cleanString(findHeaderValue(raw, "도착시간")),
        destination: cleanString(findHeaderValue(raw, "목적지")),
        note: cleanString(findHeaderValue(raw, "비고")),
        memo: cleanString(findHeaderValue(raw, "메모")),
      });
    } catch (err) {
      errors.push({
        sheetName,
        rowNumber,
        reason: err instanceof Error ? err.message : "차량 행 파싱 실패",
      });
    }
  }

  return { rows: parsedRows, errors };
}

export function parseChangeSheetCsv(
  csvText: string,
  sheetName = "변동내역메모"
): { rows: StudentChangeSheetRow[]; errors: { sheetName: string; rowNumber: number; reason: string }[] } {
  const rows = parseCsvText(csvText);
  const errors: { sheetName: string; rowNumber: number; reason: string }[] = [];
  const parsedRows: StudentChangeSheetRow[] = [];
  if (rows.length < 2) return { rows: parsedRows, errors };

  const headerIndex = detectHeaderRow(rows, ["날짜", "변동내역", "등록시트 반영"]);
  const headers = rows[headerIndex].map((header, index) => header.trim() || `__col_${index + 1}`);

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = i + 1;

    try {
      const raw = buildSheetRecord(headers, row);
      parsedRows.push({
        rowNumber,
        sheetName,
        raw,
        rowHash: stableHash(JSON.stringify(raw)),
        occurredAt: parseLooseDate(findHeaderValue(raw, "날짜", "일자")),
        changeSummary: cleanString(findHeaderValue(raw, "변동내역", "내용")),
        registrationReflected: toSheetBool(findHeaderValue(raw, "등록시트 반영", "등록 반영")),
        rallyzReflected: toSheetBool(findHeaderValue(raw, "랠리즈 반영", "랠리즈")),
        vehicleReflected: toSheetBool(findHeaderValue(raw, "차량 반영", "차량")),
        alarmStatus: cleanString(findHeaderValue(raw, "알람", "알림")),
        note: cleanString(findHeaderValue(raw, "비고", "메모")),
      });
    } catch (err) {
      errors.push({
        sheetName,
        rowNumber,
        reason: err instanceof Error ? err.message : "변동내역 행 파싱 실패",
      });
    }
  }

  return { rows: parsedRows, errors };
}

export function parseTeamRosterSheetCsv(
  csvText: string,
  sheetName = "대표팀 명단"
): { rows: StudentTeamRosterSheetRow[]; errors: { sheetName: string; rowNumber: number; reason: string }[] } {
  const rows = parseCsvText(csvText);
  const errors: { sheetName: string; rowNumber: number; reason: string }[] = [];
  const parsedRows: StudentTeamRosterSheetRow[] = [];
  if (rows.length < 2) return { rows: parsedRows, errors };

  const headerIndex = detectHeaderRow(rows, ["이름", "생년월일", "백넘버"]);
  const headers = rows[headerIndex].map((header, index) => header.trim() || `__col_${index + 1}`);
  const baseHeaders = new Set(["이름", "생년월일", "백넘버", "연락처", "학년", "지점"]);

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = i + 1;

    try {
      const raw = buildSheetRecord(headers, row);
      const studentNameRaw = findHeaderValue(raw, "이름", "수강생 이름").trim();
      const studentName = studentNameRaw || "(이름 없음)";
      const phone = normalizePhone(findHeaderValue(raw, "연락처", "전화번호"));
      const eventColumnsJSON = headers.reduce<Record<string, string>>((acc, header) => {
        if (!baseHeaders.has(header) && raw[header]) acc[header] = raw[header];
        return acc;
      }, {});

      if (!studentNameRaw) {
        errors.push({
          sheetName,
          rowNumber,
          reason: "대표팀 명단 이름이 비어 있어 원본 행만 저장됩니다.",
        });
      }

      parsedRows.push({
        rowNumber,
        sheetName,
        raw,
        rowHash: stableHash(JSON.stringify(raw)),
        studentKey: studentNameRaw && phone ? `${studentNameRaw}__${phone}` : null,
        studentName,
        birthDate: parseSpreadsheetDate(findHeaderValue(raw, "생년월일", "생일")),
        jerseyNumber: cleanString(findHeaderValue(raw, "백넘버", "등번호")),
        phone: phone || null,
        grade: cleanString(findHeaderValue(raw, "학년")),
        branch: cleanString(findHeaderValue(raw, "지점")),
        eventColumnsJSON,
      });
    } catch (err) {
      errors.push({
        sheetName,
        rowNumber,
        reason: err instanceof Error ? err.message : "대표팀 명단 행 파싱 실패",
      });
    }
  }

  return { rows: parsedRows, errors };
}

export function parseStudentAuxiliarySheetsCsv(
  csvSheets: Record<string, string>
): StudentAuxiliarySheetsParseResult {
  const result: StudentAuxiliarySheetsParseResult = {
    shuttleRows: [],
    changeRows: [],
    teamRows: [],
    summary: { shuttleRows: 0, changeRows: 0, teamRows: 0, totalRows: 0 },
    errors: [],
  };

  for (const [sheetName, csvText] of Object.entries(csvSheets)) {
    if (!csvText?.trim()) continue;

    if (sheetName.includes("차량")) {
      const parsed = parseShuttleSheetCsv(csvText, sheetName);
      result.shuttleRows.push(...parsed.rows);
      result.errors.push(...parsed.errors);
      continue;
    }

    if (sheetName.includes("변동")) {
      const parsed = parseChangeSheetCsv(csvText, sheetName);
      result.changeRows.push(...parsed.rows);
      result.errors.push(...parsed.errors);
      continue;
    }

    if (sheetName.includes("대표팀")) {
      const parsed = parseTeamRosterSheetCsv(csvText, sheetName);
      result.teamRows.push(...parsed.rows);
      result.errors.push(...parsed.errors);
    }
  }

  result.summary = {
    shuttleRows: result.shuttleRows.length,
    changeRows: result.changeRows.length,
    teamRows: result.teamRows.length,
    totalRows: result.shuttleRows.length + result.changeRows.length + result.teamRows.length,
  };

  return result;
}
