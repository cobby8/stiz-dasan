"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import type { StaffStudentListItem } from "@/lib/staff-portal-queries";

export default function StaffStudentsClient({ students }: { students: StaffStudentListItem[] }) {
  const [query, setQuery] = useState("");
  // 행을 누르면 그 학생의 연락처 전체를 아래 시트로 연다(목록에는 핵심만)
  const [detailId, setDetailId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("ko");
    return keyword ? students.filter((student) => [student.name, student.parentName, student.school, student.grade, student.studentPhone, student.parentPhone, ...student.classNames].filter(Boolean).some((value) => value!.toLocaleLowerCase("ko").includes(keyword))) : students;
  }, [query, students]);
  const detail = detailId ? students.find((student) => student.id === detailId) ?? null : null;

  function handleRowKeyDown(event: KeyboardEvent<HTMLLIElement>, id: string) {
    // 행 안의 전화 버튼에서 누른 Enter 를 행이 가로채지 않게
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 py-5">
      <header><h1 className="text-2xl font-black text-brand-navy-900 dark:text-white">학생·학부모 연락</h1><p className="mt-1 text-sm text-gray-500">내가 맡은 수업의 재원생만 표시됩니다.</p></header>
      <label className="flex min-h-12 items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 focus-within:ring-2 focus-within:ring-[var(--brand-accent)] dark:border-gray-800 dark:bg-gray-900"><span aria-hidden="true" className="material-symbols-outlined text-gray-400">search</span><span className="sr-only">학생 검색</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="학생, 학부모, 수업명, 전화번호 검색" className="w-full bg-transparent text-sm outline-none" /></label>
      <p aria-live="polite" className="text-sm font-bold text-gray-500">총 <span className="tabular-nums">{filtered.length}</span>명</p>
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center">
          <p className="font-bold">{students.length === 0 ? "아직 담당 수업에 등록된 학생이 없습니다." : "검색 결과가 없습니다."}</p>
          {query && <button type="button" onClick={() => setQuery("")} className="mt-3 min-h-11 rounded-xl border border-[var(--color-academy-line)] px-4 font-bold">검색어 지우기</button>}
        </div>
      ) : (
        // 한 학생 = 한 줄 행: 이름 · 학년 · 반 · 학부모 전화. 연락처 전체는 행을 눌러 시트에서
        <ul aria-label="학생 목록" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {filtered.map((student) => (
            <li
              key={student.id}
              role="button"
              tabIndex={0}
              aria-label={`${student.name} 연락처 보기`}
              onClick={() => setDetailId(student.id)}
              onKeyDown={(event) => handleRowKeyDown(event, student.id)}
              className="flex min-h-14 cursor-pointer items-center gap-2 border-b border-[var(--color-academy-line)] px-3 py-1.5 last:border-b-0 hover:bg-[var(--color-academy-soft)]"
            >
              <span className="shrink-0 text-base font-black text-[var(--color-academy-ink)]">{student.name}</span>
              {student.grade && <span className="shrink-0 text-xs font-bold text-[var(--color-academy-muted)]">{student.grade}</span>}
              {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
              <span className="min-w-0 flex-1 break-keep text-xs text-[var(--color-academy-muted)]">{student.classNames.join(", ")}</span>
              {student.parentPhone ? (
                // 가장 많이 쓰는 «학부모에게 전화»는 목록에서 바로 — 행 열기와 섞이지 않게 전파 차단
                // 게슈탈트 T-09: 행마다 반복되므로 tonal. 테마 버튼 여백이 아이콘 칸을 넘지 않게 padding 0
                <a
                  href={`tel:${student.parentPhone}`}
                  aria-label={`학부모 ${student.parentName}에게 전화 ${student.parentPhone}`}
                  onClick={(event) => event.stopPropagation()}
                  className="academy-button-tonal grid size-11 shrink-0 place-items-center rounded-xl"
                  style={{ padding: 0 }}
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-xl">call</span>
                </a>
              ) : (
                <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">번호 없음</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <ListDetailPanel onClose={() => setDetailId(null)} titleId="staff-student-detail-title">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--color-academy-line)] px-4 py-3">
            <div className="min-w-0">
              <h2 id="staff-student-detail-title" className="text-lg font-black text-[var(--color-academy-ink)]">{detail.name}</h2>
              <p className="text-sm text-[var(--color-academy-muted)]">{[detail.school, detail.grade].filter(Boolean).join(" ") || "학교·학년 미등록"}</p>
            </div>
            <button type="button" aria-label="닫기" onClick={() => setDetailId(null)} className="grid size-11 shrink-0 place-items-center rounded-full">
              <span aria-hidden="true" className="material-symbols-outlined">close</span>
            </button>
          </div>
          <div className="px-4 pb-4 pt-2">
            <div className="flex flex-wrap gap-1">{detail.classNames.map((name) => <span key={name} className="rounded-full bg-[var(--color-academy-soft)] px-2 py-1 text-xs font-bold text-[var(--color-academy-muted)]">{name}</span>)}</div>
            <ContactActions label="학생" name={detail.name} phone={detail.studentPhone} />
            <ContactActions label="학부모" name={detail.parentName} phone={detail.parentPhone} accent />
          </div>
        </ListDetailPanel>
      )}
    </main>
  );
}

function ContactActions({ label, name, phone, accent = false }: { label: string; name: string; phone: string | null; accent?: boolean }) {
  if (!phone) return <div className="mt-3 flex min-h-12 items-center justify-between rounded-xl bg-gray-100 px-3 text-sm text-gray-400 dark:bg-gray-800"><span>{label} {name}</span><span>번호 없음</span></div>;
  return (
    <div className="mt-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><p className="min-w-0 break-keep text-sm font-bold">{label} {name}</p><a href={`tel:${phone}`} aria-label={`${name}에게 전화 ${phone}`} className="shrink-0 whitespace-nowrap text-sm font-bold text-[var(--brand-accent)] underline underline-offset-2">{phone}</a></div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <a href={`tel:${phone}`} className={`flex min-h-12 items-center justify-center gap-1 rounded-xl font-bold ${accent ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "border border-gray-200 dark:border-gray-700"}`}><span aria-hidden="true" className="material-symbols-outlined text-xl">call</span>전화</a>
        <a href={`sms:${phone}`} className="flex min-h-12 items-center justify-center gap-1 rounded-xl border border-gray-200 font-bold dark:border-gray-700"><span aria-hidden="true" className="material-symbols-outlined text-xl">sms</span>문자</a>
      </div>
    </div>
  );
}
