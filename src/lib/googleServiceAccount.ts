type GoogleServiceAccount = { client_email: string; private_key: string } & Record<string, unknown>;

/** 환경변수 전체가 한 줄의 `\n` 문자로 저장된 경우에도 비밀값을 로그에 남기지 않고 해석한다. */
export function parseGoogleServiceAccount(raw: string): GoogleServiceAccount {
  let normalized = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!inString && char === "\\" && raw[index + 1] === "n") {
      normalized += "\n";
      index += 1;
      continue;
    }
    normalized += char;
    if (inString && escaped) {
      escaped = false;
    } else if (inString && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    }
  }
  const parsed = JSON.parse(normalized) as Partial<GoogleServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) throw new Error("서비스 계정 필수 항목이 없습니다.");
  return parsed as GoogleServiceAccount;
}
