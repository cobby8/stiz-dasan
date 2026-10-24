import { google } from "googleapis";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { parseGoogleServiceAccount } from "./googleServiceAccount.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { toKstYmd } from "./datetime/kst.ts";

const DEFAULT_SPREADSHEET_ID = "12xfQWT6OYa0hH2Ajei7E48CF2aUh6vZ8WWeFeocZrzY";
const REGISTRATION_SHEET = "등록";
const CHANGE_LOG_SHEET = "변동내역메모";

type SheetIdentity = {
  commandId: string;
  studentName: string;
  birthDate: Date;
  parentPhone: string | null;
  targetMonth: string;
  kind: "PAUSE" | "WITHDRAW";
  className: string;
  classDayOfWeek: string;
  classSlotKey: string | null;
};

function digits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return `${year}년 ${month}월`;
}

function birthKey(value: unknown) {
  const parts = String(value ?? "").match(/\d+/g) || [];
  if (parts.length < 3) return "";
  return `${parts[0]}-${String(Number(parts[1])).padStart(2, "0")}-${String(Number(parts[2])).padStart(2, "0")}`;
}

const SHEET_DAY_COLUMN: Record<string, number> = {
  MONDAY: 17, MON: 17, "월": 17, "월요일": 17,
  TUESDAY: 18, TUE: 18, "화": 18, "화요일": 18,
  WEDNESDAY: 19, WED: 19, "수": 19, "수요일": 19,
  THURSDAY: 20, THU: 20, "목": 20, "목요일": 20,
  FRIDAY: 21, FRI: 21, "금": 21, "금요일": 21,
  SATURDAY: 22, SAT: 22, "토": 22, "토요일": 22,
  SUNDAY: 23, SUN: 23, "일": 23, "일요일": 23,
};

function classMatches(row: unknown[], input: Pick<SheetIdentity, "className" | "classDayOfWeek" | "classSlotKey">) {
  const column = SHEET_DAY_COLUMN[String(input.classDayOfWeek).trim().toUpperCase()];
  if (column === undefined) return false;
  const cell = String(row[column] || "").replace(/\s+/g, "");
  const period = `${input.className} ${input.classSlotKey || ""}`.match(/(\d{1,2})(?:\s*교시|$)/)?.[1];
  return Boolean(cell) && (!period || cell.includes(`${period}교시`) || cell === period);
}

export function assertSheetRowHasOnlySelectedClass(row: unknown[], classDayOfWeek: string) {
  const targetDayColumn = SHEET_DAY_COLUMN[String(classDayOfWeek).trim().toUpperCase()];
  if (targetDayColumn === undefined) throw new Error("선택한 수업의 요일을 시트 열과 연결할 수 없습니다.");
  const hasOtherClass = Array.from({ length: 7 }, (_, offset) => 17 + offset)
    .some((column) => column !== targetDayColumn && String(row[column] || "").trim());
  if (hasOtherClass) {
    throw new Error("SHEET_SHARED_STATUS_CONFLICT:선택한 수업 행에 다른 요일 수업도 있어 공통 상태를 자동 변경할 수 없습니다. 시트에서 수업별 행을 분리하거나 직접 확인해 주세요.");
  }
}

export function findSheetEnrollmentRows(rows: unknown[][], input: Pick<SheetIdentity, "studentName" | "birthDate" | "parentPhone" | "targetMonth"> & Partial<Pick<SheetIdentity, "className" | "classDayOfWeek" | "classSlotKey">>) {
  const expectedBirth = toKstYmd(input.birthDate);
  const expectedPhone = digits(input.parentPhone);
  const expectedMonth = monthLabel(input.targetMonth);
  const matches: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (String(row[3] || "").trim() !== input.studentName || String(row[7] || "").trim() !== expectedMonth) continue;
    const birthMatches = birthKey(row[24]) === expectedBirth;
    const phoneMatches = expectedPhone.length >= 8 && digits(row[27]).endsWith(expectedPhone.slice(-8));
    const hasClassScope = Boolean(input.className && input.classDayOfWeek);
    if ((birthMatches || phoneMatches) && (!hasClassScope || classMatches(row, input as SheetIdentity))) matches.push(index + 1);
  }
  return matches;
}

function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY가 없어 구글 시트 자동 반영을 사용할 수 없습니다.");
  const credentials = parseGoogleServiceAccount(raw);
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function applySheetEnrollmentStatus(input: SheetIdentity) {
  const sheets = sheetsClient();
  const spreadsheetId = process.env.STIZ_STUDENT_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID;
  const [registration, logs] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${REGISTRATION_SHEET}'!A1:AL3000` }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `'${CHANGE_LOG_SHEET}'!A1:G2000` }),
  ]);
  const rows = registration.data.values || [];
  const expectedMonth = monthLabel(input.targetMonth);
  const targetValue = input.kind === "PAUSE" ? "휴원" : "퇴원";
  const matches = findSheetEnrollmentRows(rows, input);
  if (matches.length === 0) throw new Error("등록 시트에서 이름·적용 월·생년월일/전화가 일치하는 행을 찾지 못했습니다.");
  if (matches.length !== 1) throw new Error("등록 시트에서 대상 수업 행이 여러 건입니다. 자동 반영하지 않고 확인이 필요합니다.");
  assertSheetRowHasOnlySelectedClass(rows[matches[0] - 1] || [], input.classDayOfWeek);

  const requests = matches
    .filter((rowNumber) => String(rows[rowNumber - 1]?.[8] || "").trim() !== targetValue)
    .map((rowNumber) => ({ range: `'${REGISTRATION_SHEET}'!I${rowNumber}`, values: [[targetValue]] }));
  if (requests.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "USER_ENTERED", data: requests },
    });
  }

  const marker = `STIZ_SYNC:${input.commandId}`;
  const alreadyLogged = (logs.data.values || []).some((row) => String(row[6] || "").includes(marker));
  if (!alreadyLogged) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${CHANGE_LOG_SHEET}'!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }), `${input.studentName} ${expectedMonth} ${targetValue}`, "반영", "미반영", "해당없음", "", marker]] },
    });
  }

  const verify = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: matches.map((rowNumber) => `'${REGISTRATION_SHEET}'!I${rowNumber}`),
  });
  const verified = (verify.data.valueRanges || []).every((range) => String(range.values?.[0]?.[0] || "").trim() === targetValue);
  if (!verified) throw new Error("시트 저장 후 재조회 값이 일치하지 않습니다.");
  return { spreadsheetId, rows: matches, value: targetValue };
}
