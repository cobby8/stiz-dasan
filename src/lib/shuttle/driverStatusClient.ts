export type DriverBoardingStatus = "BOARDED" | "NOSHOW" | "SELF";
export type DriverBoardingResult = { status: DriverBoardingStatus | null; checkedAt: string | null };

/** HTML 오류 응답이나 잘못된 JSON을 조회 성공으로 받아들이지 않는다. */
export async function readBoardingResult(url: string, token: string, date: string, id: string, direction?: string, request: typeof fetch = fetch): Promise<DriverBoardingResult> {
  const response = await request(`${url}?${new URLSearchParams({ token, date })}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  const data = await response.json();
  if (!response.ok || data?.ok !== true) throw new Error("조회 실패");
  const boarding = direction ? data.boarding?.[direction] : data.boarding;
  const checkedAt = direction ? data.checkedAt?.[direction] : data.checkedAt;
  if (!boarding || typeof boarding !== "object" || Array.isArray(boarding)) throw new Error("조회 형식 오류");
  const status = boarding[id] ?? null;
  if (status !== null && status !== "BOARDED" && status !== "NOSHOW" && status !== "SELF") throw new Error("조회 형식 오류");
  return { status, checkedAt: typeof checkedAt?.[id] === "string" ? checkedAt[id] : null };
}

/** POST 결과가 불확실해도 다시 토글하지 않고, 목표값과 서버 최종값을 대조한다. */
export async function saveAndVerifyBoarding(url: string, body: Record<string, unknown>, read: () => Promise<DriverBoardingResult>, request: typeof fetch = fetch) {
  try {
    const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error("저장 응답 확인 필요");
  } catch {
    // 응답이 없어도 서버에서는 이미 저장됐을 수 있으므로 반드시 읽어서 확인한다.
  }
  const result = await read();
  return { ...result, matched: result.status === body.status };
}
