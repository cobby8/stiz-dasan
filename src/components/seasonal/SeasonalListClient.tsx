"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
// 모집 현황 3단계(여유/임박/마감) — 숫자 합계 대신(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { extractPrograms, formatSeasonalPeriod, formatWon, programClasses, seasonalDisplayState, type SeasonalListResponse, type SeasonalProgram } from "./types";

export default function SeasonalListClient() {
  const [programs, setPrograms] = useState<SeasonalProgram[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/seasonal", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("목록을 불러오지 못했습니다.");
        return response.json() as Promise<SeasonalListResponse>;
      })
      .then((data) => { setPrograms(extractPrograms(data)); setState("ready"); })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("error");
      });
    return () => controller.abort();
  }, []);

  // 상태 안내는 글자로만 말한다(장식 아이콘 제거 — 2026-11-13 UI 통일)
  if (state === "loading") return <StatusBox text="모집 중인 특강을 확인하고 있어요." />;
  if (state === "error") return <StatusBox text="특강 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." retry />;
  if (programs.length === 0) return <StatusBox text="현재 공개된 방학특강이 없습니다." />;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {programs.map((program) => {
        const offerings = programClasses(program);
        const display = seasonalDisplayState(program);
        const hasOpenCapacity = offerings.some((item) => item.capacity === null);
        const hasUnknownSeats = offerings.some((item) => item.capacity !== null && item.seatLevel === null);
        // 반 중 가장 여유 있는 단계를 대표로(여유 > 임박 > 마감)
        const bestLevel = offerings.some((item) => item.seatLevel === "AVAILABLE") ? "AVAILABLE" as const
          : offerings.some((item) => item.seatLevel === "LOW") ? "LOW" as const : "FULL" as const;
        const minPrice = Math.min(...offerings.map((item) => item.price).filter((price) => price >= 0));
        return (
          <article key={program.id} className="public-card min-w-0 overflow-hidden rounded-2xl border border-[var(--color-public-line)] bg-white shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
            <div className="bg-[var(--color-public-dark)] px-5 py-5 text-white">
              <span className="rounded bg-white/15 px-2.5 py-1 text-xs">{display.label}</span>
              <h2 className="mt-3 text-2xl font-bold break-keep">{program.title}</h2>
              {program.summary && <p className="mt-2 text-sm leading-6 text-[var(--color-public-dark-muted)] break-keep">{program.summary}</p>}
            </div>
            <div className="space-y-3 p-5">
              <Info text={`운영 기간 · ${formatSeasonalPeriod(program.operationStart, program.operationEnd)}`} />
              {(program.applicationStart || program.applicationEnd) && <Info text={`신청 기간 · ${formatSeasonalPeriod(program.applicationStart, program.applicationEnd)}`} />}
              {/* 지도 핀 아이콘이 «장소»임을 알리던 유일한 표시였으므로 글자 라벨로 대신한다 */}
              <Info text={`장소 · ${program.location || "준비 중"}`} />
              <div className="flex items-end justify-between gap-4 border-t border-[var(--color-public-line)] pt-4 dark:border-[var(--color-public-line)]">
                <div><p className="text-xs text-[var(--color-public-muted)]">수강료</p><p className="font-semibold tabular-nums text-[var(--color-public-ink)] dark:text-white">{Number.isFinite(minPrice) ? `${formatWon(minPrice)}부터` : "안내 예정"}</p></div>
                {display.showSeats && offerings.length > 0 && <div className="text-right"><p className="text-xs text-[var(--color-public-muted)]">모집 현황</p><p className={`font-medium ${hasOpenCapacity || hasUnknownSeats ? SEAT_LEVEL_TEXT_CLASS.AVAILABLE : SEAT_LEVEL_TEXT_CLASS[bestLevel]}`}>{hasOpenCapacity || hasUnknownSeats ? "학원 문의" : bestLevel !== "FULL" ? SEAT_LEVEL_LABEL[bestLevel] : offerings.some((item) => item.waitlistEnabled) ? "대기 가능" : "마감"}</p></div>}
              </div>
              {!display.canApply && <p className="text-sm text-[var(--color-public-muted)]">{display.message}</p>}
              <Link href={`/seasonal/${program.slug}`} className="public-btn-primary w-full">{display.actionLabel}</Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Info({ text }: { text: string }) {
  return <div className="flex min-w-0 items-start gap-2 text-sm tabular-nums text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]"><span className="min-w-0 break-keep [overflow-wrap:anywhere]">{text}</span></div>;
}

function StatusBox({ text, retry }: { text: string; retry?: boolean }) {
  return <div className="rounded-2xl border border-[var(--color-public-line)] bg-white p-8 text-center dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]"><p className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{text}</p>{retry && <button type="button" onClick={() => location.reload()} className="public-btn-secondary mt-4">다시 시도</button>}</div>;
}
