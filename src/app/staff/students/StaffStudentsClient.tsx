"use client";

import { useMemo, useState } from "react";
import type { StaffStudentListItem } from "@/lib/staff-portal-queries";

export default function StaffStudentsClient({ students }: { students: StaffStudentListItem[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("ko");
    return keyword ? students.filter((student) => [student.name, student.parentName, student.school, student.grade, student.studentPhone, student.parentPhone, ...student.classNames].filter(Boolean).some((value) => value!.toLocaleLowerCase("ko").includes(keyword))) : students;
  }, [query, students]);

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 py-5">
      <header><h1 className="text-2xl font-black text-brand-navy-900 dark:text-white">학생·학부모 연락</h1><p className="mt-1 text-sm text-gray-500">내가 맡은 수업의 재원생만 표시됩니다.</p></header>
      <label className="flex min-h-12 items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 focus-within:ring-2 focus-within:ring-[var(--brand-accent)] dark:border-gray-800 dark:bg-gray-900"><span aria-hidden="true" className="material-symbols-outlined text-gray-400">search</span><span className="sr-only">학생 검색</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="학생, 학부모, 수업명, 전화번호 검색" className="w-full bg-transparent text-sm outline-none" /></label>
      <p aria-live="polite" className="text-sm font-bold text-gray-500">총 {filtered.length}명</p>
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-900">
          <span aria-hidden="true" className="material-symbols-outlined text-4xl text-gray-400">person_search</span>
          <p className="mt-2 font-bold">{students.length === 0 ? "아직 담당 수업에 등록된 학생이 없습니다." : "검색 결과가 없습니다."}</p>
          {query && <button type="button" onClick={() => setQuery("")} className="mt-4 min-h-11 rounded-xl border border-gray-300 px-4 font-bold dark:border-gray-700">검색어 지우기</button>}
        </div>
      ) : filtered.map((student) => (
        <article key={student.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-black dark:text-white">{student.name}</h2>
          <p className="mt-1 text-sm text-gray-500">{[student.school, student.grade].filter(Boolean).join(" · ") || "학교·학년 미등록"}</p>
          <div className="mt-2 flex flex-wrap gap-1">{student.classNames.map((name) => <span key={name} className="rounded-full bg-gray-100 px-2 py-1 text-xs font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-300">{name}</span>)}</div>
          <ContactActions label="학생" name={student.name} phone={student.studentPhone} />
          <ContactActions label="학부모" name={student.parentName} phone={student.parentPhone} accent />
        </article>
      ))}
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
