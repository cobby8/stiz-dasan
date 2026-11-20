import UnifiedDriverRunPage, { isValidRunDate } from "@/components/shuttle/UnifiedDriverRunPage";

export const dynamic = "force-dynamic";

/**
 * 기사님 전용 통합 URL: /driver/[token]
 * 방학특강 토큰이든 정규 토큰이든 같은 통합 운행 화면을 연다.
 * 기사님께는 링크 하나만 공유하면 그날 운행이 전부 시각순으로 보인다.
 */
export default async function DriverUnifiedPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ date?: string; start?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  // date 쿼리는 클라 입력이므로 서버에서 형식·달력 유효성을 확인한 뒤에만 쓴다.
  const searchDate = sp?.date && isValidRunDate(sp.date) ? sp.date : null;
  // 설치된 기사님 앱의 영역이 /driver/ 다. 이 주소에서만 링크를 기기에 기억시켜,
  // 다음부터는 홈 화면 아이콘만 눌러도 그날 운행이 열리게 한다.
  // start=1 = 앱의 셔틀 명단에서 «운행 시작»을 눌러 온 길(/staff/run/open) — 오늘 운행표에서만 위치 공유 시작을 바로 요청한다.
  const autoStart = !searchDate && sp?.start === "1";
  return <UnifiedDriverRunPage token={token} searchDate={searchDate} rememberToken autoStart={autoStart} />;
}
