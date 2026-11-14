"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicBottomBar } from "@/components/public-floating";
// 남은 자리 3단계(여유/임박/마감) — 숫자 없이(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_BADGE_CLASS, SEAT_LEVEL_LABEL } from "@/lib/seats/seatLevel";
import { formatSeasonalDate, formatSeasonalPeriod, formatWon, normalizeProgram, programClasses, seasonalDisplayState, type SeasonalClass, type SeasonalProgram } from "./types";

// basePath = 목록·신청 화면 주소 머리. 공개 화면은 "/seasonal"(기본), 학부모 앱 안은 "/mypage/seasonal/apply"(2026-11-14 c9)
export default function SeasonalDetailClient({ slug, basePath = "/seasonal" }: { slug: string; basePath?: string }) {
  const [program, setProgram] = useState<SeasonalProgram | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/seasonal/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        return normalizeProgram(data.program ?? data.season ?? data);
      })
      .then(setProgram)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => controller.abort();
  }, [slug]);

  if (failed) return <Message text="특강 정보를 찾을 수 없습니다." />;
  if (!program) return <Message text="특강 정보를 불러오고 있어요." />;
  const offerings = programClasses(program);
  const display = seasonalDisplayState(program);

  return (
    <>
      <section className="public-page-hero public-page-hero--compact bg-[var(--color-public-dark)] px-5 py-10 text-white">
        <div className="mx-auto max-w-4xl">
          <span className="rounded bg-white/15 px-2.5 py-1 text-xs">{display.label}</span>
          <h1 className="mt-4 text-3xl font-bold break-keep">{program.title}</h1>
          {program.summary && <p className="mt-3 max-w-2xl text-[var(--color-public-dark-muted)] break-keep">{program.summary}</p>}
          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
            <Detail text={`운영 기간 · ${formatSeasonalPeriod(program.operationStart, program.operationEnd)}`} />
            {program.applicationEnd && <Detail text={`신청 마감 · ${formatSeasonalDate(program.applicationEnd, true)}`} />}
            {/* 지도 핀 아이콘 대신 «장소» 글자 라벨 */}
            <Detail text={`장소 · ${program.location || "준비 중"}`} />
          </div>
        </div>
      </section>
      <section className="public-content-section public-seasonal-detail bg-[var(--color-public-tint)] px-4 py-8 pb-28 dark:bg-[var(--color-public-paper)]">
        <div className="mx-auto max-w-4xl space-y-6">
          <div><h2 className="text-xl font-bold">{display.canApply ? "수업을 선택하세요" : "특강 수업 안내"}</h2><p className="mt-1 text-sm text-[var(--color-public-muted)]">{display.canApply ? "신청 화면에서 여러 수업을 함께 선택할 수 있습니다." : display.message}</p></div>
          <div className="grid gap-3 md:grid-cols-2">{offerings.length ? offerings.map((item) => <Offering key={item.id} item={item} showSeats={display.showSeats} />) : <Message text="등록된 수업 일정이 없습니다." />}</div>
          {program.shuttleNotice && <Notice title="셔틀 안내" text={program.shuttleNotice} />}
          {program.refundPolicy && <Notice title="취소·환불 안내" text={program.refundPolicy} />}
        </div>
      </section>
      {/* 하단 고정 바 — 높이를 --public-bottom-bar 로 알려 플로팅 버튼이 바 위로 올라간다(게슈탈트 C-P3) */}
      <PublicBottomBar className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-public-line)] bg-white/95 p-3 backdrop-blur dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)]/95">
        <div className="mx-auto flex max-w-4xl gap-2"><Link href={basePath} className="public-btn-secondary">목록</Link>{display.canApply ? <Link href={`${basePath}/${slug}/apply`} className="public-btn-primary flex-1">신청하기</Link> : <span role="status" className="flex min-h-11 flex-1 items-center justify-center rounded bg-[var(--color-public-line)] px-5 text-[var(--color-public-muted)]">{display.label}</span>}</div>
      </PublicBottomBar>
    </>
  );
}

function Offering({ item, showSeats }: { item: SeasonalClass; showSeats: boolean }) {
  const unlimited = item.capacity === null;
  const level = item.seatLevel;
  const wait = !unlimited && (level ?? "FULL") === "FULL";
  const badge = unlimited || level === null ? "자리 문의" : wait ? item.waitlistEnabled ? "대기 가능" : "마감" : SEAT_LEVEL_LABEL[level];
  // 색은 학원 CSS 변수만: 마감·대기 = 회색, 문의 = 여유색, 그 외 = 단계 색
  const badgeClass = wait ? SEAT_LEVEL_BADGE_CLASS.FULL : unlimited || level === null ? SEAT_LEVEL_BADGE_CLASS.AVAILABLE : SEAT_LEVEL_BADGE_CLASS[level];
  return <article className="public-card min-w-0 rounded-2xl border border-[var(--color-public-line)] bg-white p-5 dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-[var(--color-public-accent)]">{item.dayLabel} {item.dateLabel}</p><h3 className="mt-1 text-lg font-bold">{item.name}</h3></div>{showSeats && <span className={`rounded px-2 py-1 text-xs ${badgeClass}`}>{badge}</span>}</div><dl className="mt-4 grid grid-cols-2 gap-3 text-sm tabular-nums"><Pair label="시간" value={`${item.startTime}~${item.endTime}`} /><Pair label="대상" value={item.targetGrade || "전체"} /><Pair label="장소" value={item.location || "학원"} /><Pair label="수강료" value={formatWon(item.price)} /></dl><SessionSchedule item={item} /></article>;
}

function SessionSchedule({ item }: { item: SeasonalClass }) {
  if (!item.sessionDates.length) return null;
  return <section className="mt-4 border-t border-[var(--color-public-line)] pt-4 dark:border-[var(--color-public-line)]"><h4 className="text-sm font-semibold">전체 수업 일정 · {item.sessionDates.length}회</h4><ol className="mt-2 space-y-1.5">{item.sessionDates.map((session, index) => <li key={`${session.startsAt}-${index}`} className="flex gap-2 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]"><span className="w-8 shrink-0 font-medium tabular-nums text-[var(--color-public-accent)]">{index + 1}회</span><span>{session.dateLabel} ({session.dayLabel}) {session.startTime}~{session.endTime}</span></li>)}</ol></section>;
}

function Pair({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-[var(--color-public-muted)]">{label}</dt><dd className="mt-0.5 font-medium">{value}</dd></div>; }
// 안내 줄·안내 상자는 글자로만 말한다(장식 아이콘 제거 — 2026-11-13 UI 통일)
function Detail({ text }: { text: string }) { return <span className="flex min-w-0 items-start gap-1.5"><span className="min-w-0 break-keep [overflow-wrap:anywhere]">{text}</span></span>; }
function Notice({ title, text }: { title: string; text: string }) { return <section className="rounded-2xl border border-[var(--color-public-line)] bg-white p-5 dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]"><h2 className="font-bold">{title}</h2><p className="mt-3 whitespace-pre-line text-sm leading-6 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{text}</p></section>; }
function Message({ text }: { text: string }) { return <div className="mx-auto max-w-3xl p-12 text-center text-[var(--color-public-muted)]">{text}</div>; }
