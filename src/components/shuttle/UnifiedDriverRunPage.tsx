import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import RememberDriverToken from "./RememberDriverToken";
import { loadUnifiedDriverRun } from "@/lib/shuttle/unifiedDriverRun";
import UnifiedDriverClient from "./UnifiedDriverClient";
import AcademyTheme from "@/components/academy/AcademyTheme";
import { DRIVER_LINK_DISABLED_MESSAGE, isDriverRunLinkEnabled } from "@/lib/shuttle/driverLinkAccess";

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
    <AcademyTheme role="driver" className="min-h-screen text-[var(--color-academy-ink)]">
      <div className="mx-auto grid min-h-[80dvh] max-w-md place-items-center px-6 text-center">
        <div>
          <p className="text-5xl">🚌</p>
          <h1 className="mt-3 text-xl font-black text-[var(--color-academy-ink)]">{title}</h1>
          <p className="mt-1 text-base text-[var(--color-academy-muted)]">{sub}</p>
        </div>
      </div>
    </AcademyTheme>
  );
}

// 원장이 운행 링크(문자 주소)를 끈 뒤 옛 주소로 들어온 기사님께 보이는 안내 — 로그인하면 계정 운행표(/staff/run)로 간다.
function DriverLinkDisabledNotice() {
  return (
    <AcademyTheme role="driver" className="min-h-screen text-[var(--color-academy-ink)]">
      <div className="mx-auto grid min-h-[80dvh] max-w-md place-items-center px-6 text-center">
        <div>
          <span className="material-symbols-outlined text-5xl text-[var(--color-academy-muted)]" aria-hidden="true">link_off</span>
          <h1 className="mt-3 text-xl font-black text-[var(--color-academy-ink)]">{DRIVER_LINK_DISABLED_MESSAGE}</h1>
          <p className="mt-1 text-base text-[var(--color-academy-muted)]">원장님이 기사님 역할을 준 계정으로 로그인하면 운행표가 열립니다.</p>
          <a
            href={`/login?${new URLSearchParams({ redirect: "/staff/run" }).toString()}`}
            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl border border-[var(--color-academy-line-input)] px-5 text-base font-bold text-[var(--color-academy-ink)]"
          >
            앱에서 로그인하기
          </a>
        </div>
      </div>
    </AcademyTheme>
  );
}

/**
 * viaAccount = 로그인 계정 경로(/staff/run)가 이미 셔틀 권한을 확인하고 연 경우.
 * 이때만 운행 링크 스위치를 건너뛴다. 토큰 주소(/driver/[token] 등)는 스위치가 꺼지면 안내만 보인다.
 */
export default async function UnifiedDriverRunPage({ token, searchDate, rememberToken = false, focusDirection = null, viaAccount = false }: { token: string; searchDate?: string | null; rememberToken?: boolean; focusDirection?: "PICKUP" | "DROPOFF" | null; viaAccount?: boolean }) {
  // 운행 링크 스위치(서버 판정) — 꺼졌으면 토큰이 맞아도 명단을 읽지 않는다.
  if (!viaAccount && !(await isDriverRunLinkEnabled())) {
    return <DriverLinkDisabledNotice />;
  }
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
    <AcademyTheme role="driver" className="min-h-screen py-2">
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
        focusDirection={focusDirection}
      />
      {/* 토큰 검증을 통과한 뒤에만 기억한다. 만료된 링크를 기억하면 홈 화면
          아이콘이 매번 "유효하지 않은 링크" 화면을 여는 꼴이 된다.
          설치된 앱의 영역(/driver/)에 있는 주소에서만 켠다. */}
      {rememberToken && <RememberDriverToken token={token} />}
    </AcademyTheme>
  );
}
