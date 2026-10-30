"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startClassSession } from "@/app/actions/staff-sessions";
import { addDaysKst } from "@/lib/datetime/kst";
import type { StaffTodayClass } from "@/lib/staff-session-queries";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

// 특강 카드 1장 = 홈과 동일한 반 단위 항목(StaffTodayClass).
// 버그#2 수정: offering별로 쪼개지 않고 반+시간으로 묶인 목록을 그대로 사용한다.
type SeasonalClass = StaffTodayClass;

async function getJSON(url: string) {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || "요청 실패");
  return j;
}

export default function StaffSeasonalClient({ initial }: { initial: { ymd: string; classes: SeasonalClass[] } }) {
  const router = useRouter();
  const [ymd, setYmd] = useState<string>(initial.ymd);
  const [dates, setDates] = useState<SeasonalClass[]>(initial.classes || []);
  const [err, setErr] = useState("");
  // 어떤 카드에서 "수업 시작"이 진행 중인지(중복 클릭·로딩 표시용)
  const [startingId, setStartingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // 날짜 이동 시 그 날짜의 특강 반 목록을 다시 불러온다(상태·sessionId 포함).
  const loadDay = useCallback(async (d: string) => {
    setErr("");
    try {
      const data = await getJSON(`/api/staff/seasonal?date=${d}`);
      setDates(data.classes || []);
      setYmd(data.ymd);
    } catch (e) {
      setErr(userErrorMessage(e, "특강 목록을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요."));
    }
  }, []);

  function shiftDay(delta: number) {
    // 달력 더하기는 KST 공용 모듈로(휴대폰 시간대가 달라도 하루 밀리지 않게)
    void loadDay(addDaysKst(ymd, delta));
  }

  // 정규 수업 시작과 완전히 동일한 흐름:
  // startClassSession(정규 서버액션) 호출 → 반환된 sessionId로 통합 진행화면 이동.
  // 이미 다른 수업이 진행 중이면 ACTIVE_SESSION 코드로 그 세션으로 라우팅한다(홈 startLesson과 동일).
  function startLesson(row: SeasonalClass) {
    // StaffTodayClass.id = 연결된 반(Class)의 id, sessionDateId = 대표 회차 id
    if (!row.id || !row.sessionDateId) {
      setErr("이 특강은 연결된 수업 정보가 없어 시작할 수 없습니다. 관리자에게 문의해 주세요.");
      return;
    }
    setErr("");
    setStartingId(row.sessionDateId);
    startTransition(async () => {
      const result = await startClassSession({
        classId: row.id,
        date: ymd,
        sessionDateId: row.sessionDateId as string,
      });
      if (!result.ok) {
        if (result.code === "ACTIVE_SESSION" && result.activeSessionId) {
          router.push(`/staff/sessions/${result.activeSessionId}`);
          return;
        }
        setErr(result.message);
        setStartingId(null);
        return;
      }
      router.push(`/staff/sessions/${result.sessionId}?view=attendance`);
    });
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-3 flex items-center gap-1.5 text-lg font-black dark:text-white">
        <span className="material-symbols-outlined text-xl text-[var(--brand-accent)]" aria-hidden="true">sports_basketball</span>
        특강 수업
      </h1>

      {/* 날짜 네비(정규와 동일하게 유지, 오늘 기본) — 이동 버튼은 44px 터치 */}
      <div className="mb-3 flex items-center justify-between rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-1">
        <button type="button" aria-label="이전 날짜" onClick={() => shiftDay(-1)} className="grid size-11 place-items-center text-[var(--color-academy-muted)]">
          <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <span className="text-sm font-black tabular-nums">{ymd}</span>
        <button type="button" aria-label="다음 날짜" onClick={() => shiftDay(1)} className="grid size-11 place-items-center text-[var(--color-academy-muted)]">
          <span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
      </div>

      {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:bg-red-950 dark:text-red-300">{err}</div>}

      {dates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-academy-line)] p-5 text-center text-sm text-[var(--color-academy-muted)]">
          이 날짜에 특강 수업이 없습니다.
        </p>
      ) : (
        // 한 특강 = 한 줄 행: 시간 | 반 이름 | 인원(오른쪽) | 상태·행동 버튼. 숨길 정보가 없어 상세 시트는 두지 않는다.
        <ul aria-label="특강 수업 목록" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {dates.map((d) => {
            const status = d.sessionStatus;
            const busy = pending && startingId === d.sessionDateId;
            return (
              <li key={d.scheduleKey} className="flex min-h-14 items-center gap-2 border-b border-[var(--color-academy-line)] px-3 py-1.5 last:border-b-0">
                <span className="shrink-0 text-xs font-bold tabular-nums text-[var(--color-academy-muted)]">{d.startTime}~{d.endTime}</span>
                {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
                <span className="min-w-0 flex-1 break-keep font-black">{d.name}</span>
                <span className="shrink-0 text-right text-xs font-bold tabular-nums text-[var(--color-academy-muted)]">{d.studentCount}명</span>
                {status === "IN_PROGRESS" && d.sessionId ? (
                  // 진행 중: 통합 진행화면으로 바로 이어하기
                  <button
                    type="button"
                    onClick={() => router.push(`/staff/sessions/${d.sessionId}`)}
                    className="academy-button-primary flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-3 text-sm font-black"
                  >
                    <span className="material-symbols-outlined text-lg" aria-hidden="true">arrow_forward</span>
                    수업 이어하기
                  </button>
                ) : status === "COMPLETED" ? (
                  // 완료: 배지 + (세션 있으면) 기록 보기
                  <span className="flex shrink-0 items-center gap-1">
                    <StatusBadge status={status} />
                    {d.sessionId && (
                      <button
                        type="button"
                        aria-label={`${d.name} 기록 보기`}
                        onClick={() => router.push(`/staff/sessions/${d.sessionId}`)}
                        className="flex min-h-11 items-center gap-1 rounded-xl border border-[var(--color-academy-line)] px-2 text-sm font-bold text-[var(--color-academy-muted)]"
                      >
                        <span className="material-symbols-outlined text-lg" aria-hidden="true">history</span>
                        기록 보기
                      </button>
                    )}
                  </span>
                ) : (
                  // 시작 전(PLANNED 또는 세션 미생성): 수업 시작
                  // 게슈탈트 T-09: 여러 행에 반복되므로 tonal. 꽉 찬 색은 하나뿐인 «수업 이어하기»에만.
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startLesson(d)}
                    className="academy-button-tonal flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-3 text-sm font-black disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-lg" aria-hidden="true">play_arrow</span>
                    {busy ? "시작 중…" : "수업 시작"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// 회차 상태 배지(정규 홈의 StatusBadge와 동일한 문구 체계)
function StatusBadge({ status }: { status: SeasonalClass["sessionStatus"] }) {
  const text = status === "COMPLETED" ? "완료" : status === "IN_PROGRESS" ? "수업 중" : "시작 전";
  const tone =
    status === "IN_PROGRESS"
      ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]"
      : status === "COMPLETED"
        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  return <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-black ${tone}`}>{text}</span>;
}
