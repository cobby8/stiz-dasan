/** 학원 정책: 만 19세 이상은 자신의 등록 이름·생년월일·학생 연락처로만 연결한다. */
export const SELF_CONNECTION_AGE = 19;
export function identityName(value: unknown) { return String(value ?? "").normalize("NFC").replace(/\s+/g, "").toLowerCase(); }
export function identityPhone(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
export function validBirth(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // 오늘 날짜를 계산하는 용도가 아니라, 입력된 생일의 달력 유효성만 확인한다.
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(value.slice(0,4))
    && date.getUTCMonth()+1 === Number(value.slice(5,7)) && date.getUTCDate() === Number(value.slice(8,10));
}
export function canConnectSelf(birth: string, today: string) {
  if (!validBirth(birth) || !validBirth(today) || birth > today) return false;
  let age = Number(today.slice(0, 4)) - Number(birth.slice(0, 4));
  if (today.slice(5) < birth.slice(5)) age--;
  return age >= SELF_CONNECTION_AGE;
}
export const CHILD_LINK_UNAVAILABLE = "입력한 정보로 연결 요청을 접수할 수 없습니다. 이름과 연락처를 확인해 주세요.";
