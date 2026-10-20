"use client";

import Link from "next/link";
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

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {programs.map((program) => {
        const offerings = programClasses(program);
        const hasOpenCapacity = offerings.some((item) => item.capacity === null);
        const seats = offerings.reduce((sum, item) => sum + Math.max(item.remaining ?? 0, 0), 0);
        const minPrice = Math.min(...offerings.map((item) => item.price).filter((price) => price >= 0));
        return (
          <article key={program.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="bg-brand-navy-900 px-5 py-5 text-white">
              <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold">{statusLabel(program.status)}</span>
              <h2 className="mt-3 text-2xl font-black break-keep">{program.title}</h2>
              {program.summary && <p className="mt-2 text-sm leading-6 text-blue-100 break-keep">{program.summary}</p>}
            </div>
            <div className="space-y-3 p-5">
              <Info icon="calendar_today" text={[program.operationStart, program.operationEnd].filter(Boolean).join(" ~ ") || "운영 일정 준비 중"} />
              <Info icon="location_on" text={program.location || "장소 준비 중"} />
              <div className="flex items-end justify-between gap-4 border-t border-gray-100 pt-4 dark:border-gray-700">
                <div><p className="text-xs text-gray-500">수강료</p><p className="font-black text-brand-navy-900 dark:text-white">{Number.isFinite(minPrice) ? `${formatWon(minPrice)}부터` : "안내 예정"}</p></div>
                <div className="text-right"><p className="text-xs text-gray-500">전체 잔여석</p><p className="font-bold text-emerald-600">{hasOpenCapacity ? "접수 가능" : seats > 0 ? `${seats}석` : "대기 가능"}</p></div>
              </div>
              <Link href={`/seasonal/${program.slug}`} className="flex min-h-12 items-center justify-center rounded-xl bg-brand-orange-500 px-4 font-bold text-white transition hover:bg-orange-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-orange-500">자세히 보고 신청하기</Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Info({ icon, text }: { icon: string; text: string }) {
  return <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"><span className="material-symbols-outlined" aria-hidden="true">{icon}</span><span>{text}</span></div>;
}

function StatusBox({ icon, text, retry }: { icon: string; text: string; retry?: boolean }) {
  return <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800"><span className="material-symbols-outlined text-4xl text-gray-400" aria-hidden="true">{icon}</span><p className="mt-3 text-gray-600 dark:text-gray-300">{text}</p>{retry && <button type="button" onClick={() => location.reload()} className="mt-4 min-h-11 rounded-xl border border-gray-300 px-5 font-bold">다시 시도</button>}</div>;
}
