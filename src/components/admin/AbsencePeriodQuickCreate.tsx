"use client";

/**
 * 관리자 «기간 결석 등록» 빠른 입구 (2026-11-15 원장: 「기간 결석 신고 기능이 안 보이는거 같던데」)
 *
 * 왜: 기간 결석 등록은 학생 상세 › 수강·출결 탭 안에만 있어 찾기 어려웠다. 결석 관리 화면 위쪽 버튼과
 * 학생 목록 ⚡ 빠른 작업에서 바로 열 수 있게 한다.
 * - 등록 창은 새로 만들지 않는다 — 학생 상세의 등록 창(CreatePeriodModal)을 «그대로» 연다(규칙·저장이 한 벌).
 * - 학생을 아직 안 골랐으면 이름으로 찾아 고른 뒤 그 창을 연다. 학생 목록 ⚡에서 오면 고르는 단계를 건너뛴다.
 */

import { useEffect, useMemo, useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { CreatePeriodModal, type AbsencePeriodClassOption } from "@/app/admin/students/[id]/AbsencePeriodPanel";

type StudentOption = { id: string; name: string; parent: { name: string | null }; classes: { id: string; name: string; dayOfWeek: string; startTime: string }[] };

const DAY_LABEL: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

const toClassOptions = (student: StudentOption): AbsencePeriodClassOption[] =>
  student.classes.map((c) => ({ classId: c.id, className: c.name, dayLabel: DAY_LABEL[c.dayOfWeek] ?? c.dayOfWeek, startTime: c.startTime }));

export default function AbsencePeriodQuickCreate({
  presetStudentId = null, onClose, onDone,
}: {
  /** 이미 고른 학생(학생 목록 ⚡) — 있으면 찾기 단계를 건너뛴다 */
  presetStudentId?: string | null;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [students, setStudents] = useState<StudentOption[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(presetStudentId);

  // 학생·수강 중 반 목록(관리자 전용 API — 수강 등록 창이 쓰는 것과 같은 목록)
  useEffect(() => {
    let alive = true;
    fetch("/api/admin/student-options", { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok || !Array.isArray(json?.students)) { setError("학생 목록을 불러오지 못했습니다. 잠시 후 다시 열어 주세요."); return; }
        setStudents(json.students);
      })
      .catch(() => { if (alive) setError("학생 목록을 불러오지 못했습니다. 잠시 후 다시 열어 주세요."); });
    return () => { alive = false; };
  }, []);

  const picked = useMemo(() => students?.find((student) => student.id === pickedId) ?? null, [students, pickedId]);
  const matches = useMemo(() => {
    const keyword = query.trim();
    const list = students ?? [];
    return (keyword ? list.filter((student) => student.name.includes(keyword)) : list).slice(0, 30);
  }, [students, query]);

  // 학생이 정해졌고 수강 중 반이 있으면 기존 등록 창을 그대로 연다
  if (picked && picked.classes.length > 0) {
    return (
      <CreatePeriodModal
        studentId={picked.id}
        studentName={picked.name}
        activeClasses={toClassOptions(picked)}
        onClose={onClose}
        onDone={async (message) => { await onDone(`${picked.name} · ${message}`); }}
      />
    );
  }

  return (
    <AdminModal onClose={onClose} titleId="absence-period-quick-title" panelClassName="max-w-lg p-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 id="absence-period-quick-title" className="min-w-0 flex-1 text-lg font-bold text-[var(--color-academy-ink)]">기간 결석 등록</h2>
        <button type="button" onClick={onClose} className="academy-button-text">닫기</button>
      </div>
      {error && <p role="alert" className="text-sm font-medium text-[var(--color-academy-danger)]">{error}</p>}
      {!error && !students && <p className="text-sm text-[var(--color-academy-muted)]">불러오는 중…</p>}
      {picked && picked.classes.length === 0 && (
        <p role="alert" className="mb-2 text-sm font-medium text-[var(--color-academy-danger)]">{picked.name} 원생은 수강 중인 반이 없어 기간 결석을 만들 수 없습니다.</p>
      )}
      {students && !presetStudentId && (
        <>
          <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
            원생 이름
            <input
              type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름으로 찾기" autoFocus
              className="academy-input mt-1 w-full"
            />
          </label>
          {/* 한 줄 행 목록 — 누르면 그 원생의 등록 창이 열린다 */}
          <ul className="mt-2 max-h-72 divide-y divide-[var(--color-academy-line)] overflow-y-auto rounded-lg border border-[var(--color-academy-line)]">
            {matches.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-[var(--color-academy-muted)]">찾는 원생이 없습니다.</li>
            ) : matches.map((student) => (
              <li key={student.id}>
                <button
                  type="button"
                  onClick={() => setPickedId(student.id)}
                  className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-academy-soft)]"
                >
                  <span className="shrink-0 font-medium text-[var(--color-academy-ink)]">{student.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-academy-muted)]">
                    {student.classes.length ? student.classes.map((c) => c.name).join(" · ") : "수강 중인 반 없음"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </AdminModal>
  );
}
