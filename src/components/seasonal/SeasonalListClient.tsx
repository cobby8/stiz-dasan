"use client";

import Link from "next/link";
import { isPastSeasonalProgram, publicSeasonalDate } from "./publicPresentation";
import { useEffect, useState } from "react";
import { extractPrograms, formatWon, programClasses, statusLabel, type SeasonalListResponse, type SeasonalProgram } from "./types";

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

  if (state === "loading") return <StatusBox icon="progress_activity" text="모집 중인 특강을 확인하고 있어요." />;
  if (state === "error") return <StatusBox icon="error" text="특강 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." retry />;
  if (programs.length === 0) return <StatusBox icon="calendar_today" text="현재 공개된 방학특강이 없습니다." />;

  const current = programs.filter((program) => !isPastSeasonalProgram(program));
  const past = programs.filter((program) => isPastSeasonalProgram(program));
  return <div className="space-y-5">
    {current.length ? <div className="grid gap-4 md:grid-cols-2">{current.map((program) => <ProgramCard key={program.id} program={program} />)}</div> : <StatusBox icon="calendar_today" text="현재 모집 중인 특강이 없습니다. 새 일정이 정해지면 안내드릴게요." />}
    {past.length > 0 && <details className="public-card p-4"><summary className="cursor-pointer font-semibold">지난 특강 {past.length}개</summary><div className="mt-3 divide-y divide-[var(--color-public-border)]">{past.map((program) => <Link key={program.id} href={`/seasonal/${program.slug}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 py-3"><span className="font-semibold">{program.title}</span><span className="text-sm text-[var(--color-public-muted)]">운영 종료 · 상세 보기</span></Link>)}</div></details>}
  </div>;
}

function ProgramCard({ program }: { program: SeasonalProgram }) {
  const offerings = programClasses(program);
  const hasOpenCapacity = offerings.some((item) => item.capacity === null);
  const seats = offerings.reduce((sum, item) => sum + Math.max(item.remaining ?? 0, 0), 0);
  const minPrice = Math.min(...offerings.map((item) => item.price).filter((price) => price >= 0));
  return <article className="public-card flex flex-col gap-4 p-5">
    <div><p className="public-eyebrow">{statusLabel(program.status)}</p><h2 className="mt-1 break-keep text-xl font-bold">{program.title}</h2>{program.summary && <p className="mt-2 text-sm leading-6 text-[var(--color-public-muted)]">{program.summary}</p>}</div>
    <Info icon="calendar_today" text={[program.operationStart, program.operationEnd].map(publicSeasonalDate).filter(Boolean).join(" ~ ") || "운영 일정 준비 중"} />
    <Info icon="location_on" text={program.location || "장소 준비 중"} />
    <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[var(--color-public-border)] pt-3"><p className="font-bold">{Number.isFinite(minPrice) ? `${formatWon(minPrice)}부터` : "수강료 안내 예정"}</p><span className="text-sm text-[var(--color-public-muted)]">{hasOpenCapacity ? "접수 가능" : seats > 0 ? `잔여 ${seats}석` : "대기 여부 확인"}</span></div>
    <Link href={`/seasonal/${program.slug}`} className="public-button self-start">자세히 보기</Link>
  </article>;
}

function Info({ icon, text }: { icon: string; text: string }) {
  return <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"><span className="material-symbols-outlined" aria-hidden="true">{icon}</span><span>{text}</span></div>;
}

function StatusBox({ icon, text, retry }: { icon: string; text: string; retry?: boolean }) {
  return <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800"><span className="material-symbols-outlined text-4xl text-gray-400" aria-hidden="true">{icon}</span><p className="mt-3 text-gray-600 dark:text-gray-300">{text}</p>{retry && <button type="button" onClick={() => location.reload()} className="mt-4 min-h-11 rounded-xl border border-gray-300 px-5 font-bold">다시 시도</button>}</div>;
}
