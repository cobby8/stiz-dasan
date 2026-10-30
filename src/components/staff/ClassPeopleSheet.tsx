"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStaffClassPeople } from "@/app/actions/staff-class-people";
import type { StaffClassPerson } from "@/lib/staff-class-people";
import { useStaffDialog } from "./useStaffDialog";
import { userErrorMessage } from "@/components/staff/userErrorMessage";

const peopleRequests = new Map<string, Promise<Awaited<ReturnType<typeof loadStaffClassPeople>>>>();
const phoneHref = (phone: string) => phone.replace(/[^\d+]/g, "");

export function ClassPeopleSheet({ open, classId, sessionId, sessionDateId, className, onClose, onOpenBilling }: { open: boolean; classId: string; sessionId?: string | null; sessionDateId?: string | null; className: string; onClose: () => void; onOpenBilling: (student: { id: string; name: string }) => void }) {
  const sheetRef = useRef<HTMLElement>(null);
  const cacheKey = `${classId}:${sessionId || sessionDateId || "today"}`;
  const [people, setPeople] = useState<StaffClassPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useStaffDialog(open, sheetRef, onClose);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => { if (active) { setPeople([]); setLoading(true); setError(""); } });
    const request = peopleRequests.get(cacheKey) ?? loadStaffClassPeople({ classId, sessionId, sessionDateId });
    peopleRequests.set(cacheKey, request);
    void request.then((result) => { if (!result.ok) throw new Error(result.message); if (active) setPeople(result.people); })
      .catch((reason: unknown) => { if (active) setError(userErrorMessage(reason, "학생 정보를 불러오지 못했습니다.")); })
      .finally(() => { peopleRequests.delete(cacheKey); if (active) setLoading(false); });
    return () => { active = false; };
  }, [cacheKey, classId, open, sessionDateId, sessionId]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("ko");
    if (!keyword) return people;
    return people.filter((person) => [person.name, person.school, person.grade, ...person.guardians.map((guardian) => guardian.name)].filter(Boolean).some((value) => value!.toLocaleLowerCase("ko").includes(keyword)));
  }, [people, query]);

  if (!open) return null;
  return <div className="fixed inset-0 z-[60] flex items-end bg-black/55 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="class-people-title">
    <button type="button" aria-label="학생 정보 닫기" className="absolute inset-0 cursor-default" onClick={onClose} />
    <section ref={sheetRef} className="relative max-h-[92dvh] w-full max-w-lg overflow-hidden rounded-t-3xl bg-white shadow-2xl dark:bg-gray-900 sm:rounded-3xl">
      <header className="border-b border-gray-100 px-5 pb-4 pt-3 dark:border-gray-800">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-[var(--brand-accent)]">{className}</p><h2 id="class-people-title" className="mt-0.5 text-xl font-black dark:text-white">학생 정보 · 연락</h2></div><button type="button" data-dialog-initial-focus onClick={onClose} aria-label="닫기" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800"><span className="material-symbols-outlined">close</span></button></div>
        <label className="mt-4 flex min-h-12 items-center gap-2 rounded-xl bg-gray-100 px-3 dark:bg-gray-800"><span className="material-symbols-outlined text-gray-500">search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="학생·학부모 이름 검색" className="w-full bg-transparent text-sm outline-none" /></label>
      </header>
      <div className="max-h-[calc(92dvh-10.5rem)] overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        {loading && people.length === 0 && <SheetMessage icon="progress_activity" text="학생 정보를 불러오는 중입니다." spin />}{error && <SheetMessage icon="error" text={error} />}{!loading && !error && visible.length === 0 && <SheetMessage icon="person_off" text="표시할 학생이 없습니다." />}
        <div className="space-y-3">{visible.map((person) => <PersonCard key={person.id} person={person} onOpenBilling={onOpenBilling} />)}</div>
      </div>
    </section>
  </div>;
}

function PersonCard({ person, onOpenBilling }: { person: StaffClassPerson; onOpenBilling: (student: { id: string; name: string }) => void }) {
  const guardian = person.guardians.find((item) => item.isPrimary) ?? person.guardians[0];
  const attendance = person.todayStatus === "PRESENT" ? ["출석", "bg-green-50 text-green-700"] : person.todayStatus === "LATE" ? ["지각", "bg-amber-50 text-amber-700"] : person.todayStatus === "ABSENT" ? ["결석", "bg-red-50 text-red-700"] : ["미확인", "bg-gray-100 text-gray-600"];
  return <article className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-black dark:text-white">{person.name}</h3><p className="mt-0.5 text-xs text-gray-500">{[person.school, person.grade].filter(Boolean).join(" · ") || "학교·학년 미등록"}</p></div><div className="flex flex-wrap justify-end gap-1.5"><span className={`rounded-full px-2.5 py-1 text-xs font-black ${attendance[1]}`}>{attendance[0]}</span>{person.billing.unpaidCount > 0 && <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-black text-red-700">미납 {person.billing.unpaidCount}건</span>}</div></div>
    {person.billing.unpaidCount > 0 && <button type="button" onClick={() => onOpenBilling({ id: person.id, name: person.name })} className="mt-3 flex min-h-12 w-full items-center justify-between rounded-xl bg-red-50 px-3 text-left text-sm font-black text-red-700"><span>미납 {person.billing.unpaidAmount.toLocaleString("ko-KR")}원</span><span className="flex items-center">청구 확인 <span className="material-symbols-outlined">chevron_right</span></span></button>}
    <div className="mt-3 grid grid-cols-3 gap-2"><ContactLink phone={person.studentPhone} icon="call" label="학생 전화" /><ContactLink phone={guardian?.phone ?? null} icon="phone_in_talk" label="학부모 전화" accent /><ContactLink phone={guardian?.phone ?? null} icon="sms" label="문자" sms /></div>
    {person.billing.unpaidCount === 0 && <button type="button" onClick={() => onOpenBilling({ id: person.id, name: person.name })} className="mt-2 flex min-h-11 w-full items-center justify-center gap-1 rounded-xl border border-gray-200 text-sm font-black dark:border-gray-700"><span className="material-symbols-outlined text-xl">receipt_long</span>청구 내역</button>}
    <details className="group mt-3 rounded-xl bg-gray-50 dark:bg-gray-800/70"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-bold"><span>상세정보 · 보호자 {person.guardians.length}명</span><span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span></summary><div className="space-y-3 border-t border-gray-200 px-3 py-3 text-sm dark:border-gray-700"><p className="text-gray-600 dark:text-gray-300">최근 {person.recentAttendance.total}회: 출석 {person.recentAttendance.present} · 지각 {person.recentAttendance.late} · 결석 {person.recentAttendance.absent}</p>{person.memo && <p className="whitespace-pre-wrap rounded-lg bg-white p-3 text-gray-700 dark:bg-gray-900 dark:text-gray-200">{person.memo}</p>}<div className="space-y-2">{person.guardians.map((item, index) => <div key={item.id ?? `${item.name}-${index}`} className="flex items-center justify-between gap-2"><span className="font-bold">{item.name} · {item.relation}</span><span className="text-gray-500">{item.phone || "연락처 없음"}</span></div>)}</div></div></details>
  </article>;
}

function ContactLink({ phone, icon, label, accent = false, sms = false }: { phone: string | null; icon: string; label: string; accent?: boolean; sms?: boolean }) {
  if (!phone) return <span className="flex min-h-11 items-center justify-center rounded-xl bg-gray-100 px-1 text-center text-xs font-bold text-gray-400 dark:bg-gray-800">연락처 없음</span>;
  return <a href={`${sms ? "sms" : "tel"}:${phoneHref(phone)}`} className={`flex min-h-11 flex-col items-center justify-center rounded-xl text-xs font-black ${accent ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "border border-gray-200 dark:border-gray-700"}`}><span className="material-symbols-outlined text-xl">{icon}</span>{label}</a>;
}
function SheetMessage({ icon, text, spin = false }: { icon: string; text: string; spin?: boolean }) { return <div className="py-12 text-center text-sm font-bold text-gray-500"><span className={`material-symbols-outlined mb-2 block text-4xl ${spin ? "animate-spin" : ""}`}>{icon}</span>{text}</div>; }
