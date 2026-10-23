"use client";

// 기사님 운행 화면 상단의 날짜 이동 네비. ‹ 이전 · [날짜(요일)] · 다음 ›
// 이동은 링크로만 처리(?date=대상날짜) → 서버가 그 날 데이터를 다시 조회한다. 클라 상태 없음.
// ★ 기사님 연세 고려 — 라이트 모드 고정, 큰 글자·큰 터치 영역.

import Link from "next/link";

// YYYY-MM-DD → "7/27 (월)" 형태로. 정오(+09:00) 기준으로 요일 계산해 날짜 밀림 방지.
function fmtDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${iso}T12:00:00+09:00`).getUTCDay()] ?? "";
  return `${Number(m[2])}/${Number(m[3])}${dow ? ` (${dow})` : ""}`;
}

export default function DriverDateNav({
  date, prevDate, nextDate, today,
}: {
  date: string;
  prevDate: string | null; // 없으면(범위 밖) 버튼 비활성
  nextDate: string | null;
  today: string;
}) {
  // 비활성 버튼과 활성 링크의 공통 크기 — 손가락으로 누르기 쉬운 큰 영역.
  const btn = "grid h-12 min-w-[84px] place-items-center rounded-xl text-[16px] font-black";
  return (
    <div className="mx-auto -mt-1 mb-3 flex max-w-lg items-center justify-between gap-2 px-3">
      {/* 이전: prevDate 있을 때만 이동 가능 */}
      {prevDate ? (
        <Link href={`?date=${prevDate}`} className={`${btn} bg-gray-100 text-gray-800 active:bg-gray-200`}>‹ 이전</Link>
      ) : (
        <span className={`${btn} bg-gray-50 text-gray-300`}>‹ 이전</span>
      )}

      {/* 가운데: 현재 날짜 + (오늘이 아니면) 오늘로 바로가기 */}
      <div className="flex flex-col items-center leading-tight">
        <span className="text-[17px] font-black text-gray-900">{fmtDate(date)}</span>
        {date !== today && (
          <Link href={`?date=${today}`} className="mt-0.5 inline-flex min-h-11 items-center justify-center px-2 text-[13px] font-black text-blue-600 active:text-blue-700">오늘로</Link>
        )}
      </div>

      {/* 다음: nextDate 있을 때만 이동 가능 */}
      {nextDate ? (
        <Link href={`?date=${nextDate}`} className={`${btn} bg-gray-100 text-gray-800 active:bg-gray-200`}>다음 ›</Link>
      ) : (
        <span className={`${btn} bg-gray-50 text-gray-300`}>다음 ›</span>
      )}
    </div>
  );
}
