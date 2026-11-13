"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { completeKakaoShuttleRosterTask } from "@/app/actions/kakao-shuttle-roster-task";
import { kstLabel } from "@/lib/datetime/kst";
import type { KakaoShuttleRosterTaskItem } from "@/lib/kakao-shuttle-roster-task-query";

// 원장 할 일 «셔틀 명단에 넣어 주세요» — 카카오로 들어온 정규 셔틀 신청을 셔틀 명단 화면 맨 위에 한 줄로 보여 준다.
// 한 건 = 한 줄: 학생 · 신청 요약 · [명단에 넣기](기존 «신청 학생 선택해 명단 추가» 흐름) · [완료].
// 명단은 여기서 바꾸지 않는다. «완료»는 처리 표시만 남기고, 학부모에게는 아무것도 보내지 않는다.
export default function KakaoShuttleRosterTasks({ tasks }: { tasks: KakaoShuttleRosterTaskItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  if (tasks.length === 0) return null;

  function complete(task: KakaoShuttleRosterTaskItem) {
    const ask = task.inRoster
      ? `${task.studentName} 학생 셔틀 신청을 «처리 완료»로 표시할까요?\n학부모에게 문자는 보내지 않습니다.`
      : `${task.studentName} 학생이 그 달 셔틀 명단에 아직 없습니다.\n그래도 «처리 완료»로 표시할까요? (명단은 바뀌지 않습니다 · 학부모에게 문자는 보내지 않습니다)`;
    if (!window.confirm(ask)) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await completeKakaoShuttleRosterTask({ intakeId: task.intakeId });
        if (!result.ok) { setError(result.message); return; }
        router.refresh();
      } catch (e) { setError(adminErrorText(e, "처리 표시를 남기지 못했습니다.")); }
    });
  }

  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <details open className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
        <summary className="cursor-pointer font-medium">
          카카오 정규 셔틀 신청 <span className="tabular-nums">{tasks.length}</span>건 — 셔틀 명단에 넣어 주세요
        </summary>
        {error && <p role="alert" className="mt-2 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs text-[var(--color-academy-danger)]">{error}</p>}
        <ul className="mt-2 divide-y divide-[var(--color-academy-line)]">
          {tasks.map((task) => (
            <li key={task.intakeId} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
              <span className="font-semibold">{task.studentName}</span>
              <span className="text-xs text-[var(--color-academy-muted)] tabular-nums">{kstLabel(task.createdAt)} 접수</span>
              {task.summary && <span className="text-xs">{task.summary}</span>}
              {task.inRoster && <span className="rounded bg-[var(--color-academy-success-soft)] px-1.5 py-0.5 text-xs text-[var(--color-academy-success)]">명단에 있음</span>}
              <span className="ml-auto flex flex-wrap justify-end gap-1">
                {/* 명단 화면이 ?studentId= 를 받아 «신청 학생 선택해 명단 추가»를 띄운다(기존 기능) */}
                {/* 병합 후 학생을 못 찾으면 주소가 없다 — 엉뚱한(흡수된) 학생으로 명단에 넣지 않게 버튼을 숨기고 안내만 한다 */}
                {task.href
                  ? <Link href={task.href} prefetch={false} className="academy-button-secondary academy-button-sm">명단에 넣기</Link>
                  : <span className="inline-flex min-h-11 items-center px-1 text-xs text-[var(--color-academy-muted)]">학생 확인 필요(카카오 접수함)</span>}
                <button type="button" disabled={pending} onClick={() => complete(task)} className="academy-button-secondary academy-button-sm">완료</button>
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
