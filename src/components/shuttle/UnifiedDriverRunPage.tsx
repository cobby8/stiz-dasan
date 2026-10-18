import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import RememberDriverToken from "./RememberDriverToken";
import { loadUnifiedDriverRun } from "@/lib/shuttle/unifiedDriverRun";
import UnifiedDriverClient from "./UnifiedDriverClient";

/**
 * 기사님 통합 운행 화면(서버) — /shuttle/run/[token], /shuttle/regular/[token], /driver/[token] 셋이 공유한다.
 *
 * 기사님은 링크 하나만 열면 **그날 운행이 전부** 시각순으로 보인다(방학특강·정규 구분 없이 한 줄씩).
 * 토큰 종류(특강용/정규용)는 화면 내용에 영향을 주지 않는다 — 검증에만 쓴다.
 */

function todayKST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
// YYYY-MM-DD 형식+달력 유효성 검증. 클라가 보낸 date 쿼리는 신뢰하지 않고 서버에서 확인.
export function isValidRunDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00+09:00`);
  return !Number.isNaN(d.getTime()) &&
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) === s;
}
// KST 기준 n일 이동. 정오+09:00에서 UTC 날짜를 더해 날짜 밀림 없이 계산.
function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function DriverLightError({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="min-h-screen bg-white text-gray-900" style={{ colorScheme: "light" }}>
      <div className="mx-auto grid min-h-[80dvh] max-w-md place-items-center px-6 text-center">
        <div>
          <p className="text-5xl">🚌</p>
          <h1 className="mt-3 text-xl font-black text-gray-900">{title}</h1>
          <p className="mt-1 text-base text-gray-500">{sub}</p>
        </div>
      </div>
    </div>
  );
}

export default async function UnifiedDriverRunPage({ token, searchDate, rememberToken = false }: { token: string; searchDate?: string | null; rememberToken?: boolean }) {
  // 토큰 검증은 기존 함수 그대로(방학특강 resolveRunToken · 정규 isRegularRunToken).
  if (!(await isAnyDriverRunToken(token))) {
    return <DriverLightError title="유효하지 않은 링크입니다" sub="원장님께 새 링크를 요청해주세요." />;
  }

  const today = todayKST();
  // 기사 링크는 링크에 박힌 날짜와 무관하게 **항상 오늘**로 연다(기사님은 늘 당일 운행을 본다).
  const viewDate = searchDate && isValidRunDate(searchDate) ? searchDate : today;
  // 정규는 상시 요일 운행이라 달력일 ±1로 이동한다(명단 없는 날도 계속 넘길 수 있게).
  const prevDate = addDays(viewDate, -1);
  const nextDate = addDays(viewDate, 1);

  const { rows, boarding, boardingReliable, driverLabel } = await loadUnifiedDriverRun(viewDate);

  return (
    <div className="min-h-screen bg-white py-2" style={{ colorScheme: "light" }}>
      <UnifiedDriverClient
        key={viewDate}
        token={token}
        date={viewDate}
        rows={rows}
        initialBoarding={boarding}
        initialBoardingReliable={boardingReliable}
        prevDate={prevDate}
        nextDate={nextDate}
        today={today}
        driverLabel={driverLabel}
      />
      {/* 토큰 검증을 통과한 뒤에만 기억한다. 만료된 링크를 기억하면 홈 화면
          아이콘이 매번 "유효하지 않은 링크" 화면을 여는 꼴이 된다.
          설치된 앱의 영역(/driver/)에 있는 주소에서만 켠다. */}
      {rememberToken && <RememberDriverToken token={token} />}
    </div>
  );
}
