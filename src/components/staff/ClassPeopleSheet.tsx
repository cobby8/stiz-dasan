"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStaffClassPeople } from "@/app/actions/staff-class-people";
import type { StaffClassPerson } from "@/lib/staff-class-people";
import { useStaffDialog } from "./useStaffDialog";
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { ATTENDANCE_TONE, PAYMENT_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";

const peopleRequests = new Map<string, Promise<Awaited<ReturnType<typeof loadStaffClassPeople>>>>();
const phoneHref = (phone: string) => phone.replace(/[^\d+]/g, "");

export function ClassPeopleSheet({ open, classId, sessionId, sessionDateId, className, onClose, onOpenBilling }: { open: boolean; classId: string; sessionId?: string | null; sessionDateId?: string | null; className: string; onClose: () => void; /** 없으면(선생님 화면) 미납 배지·청구 버튼을 숨긴다(f3 보완). */ onOpenBilling?: (student: { id: string; name: string }) => void }) {
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
    <section ref={sheetRef} className="relative max-h-[92dvh] w-full max-w-lg overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
      <header className="border-b border-[var(--color-academy-line)] px-5 pb-4 pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--color-academy-line-input)]" />
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs text-[var(--color-academy-muted)]">{className}</p><h2 id="class-people-title" className="mt-0.5 text-xl font-bold">학생 정보 · 연락</h2></div><button type="button" data-dialog-initial-focus onClick={onClose} aria-label="닫기" className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-[var(--color-academy-soft)]"><span className="material-symbols-outlined" aria-hidden="true">close</span></button></div>
        <label className="mt-4 flex min-h-12 items-center gap-2 rounded-xl bg-[var(--color-academy-soft)] px-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="학생·학부모 이름 검색" className="w-full bg-transparent text-sm outline-none" /></label>
      </header>
      <div className="max-h-[calc(92dvh-10.5rem)] overflow-y-auto overscroll-contain px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        {loading && people.length === 0 && <SheetMessage text="학생 정보를 불러오는 중입니다." />}{error && <SheetMessage text={error} />}{!loading && !error && visible.length === 0 && <SheetMessage text="표시할 학생이 없습니다." />}
        <div className="space-y-3">{visible.map((person) => <PersonCard key={person.id} person={person} onOpenBilling={onOpenBilling} />)}</div>
      </div>
    </section>
  </div>;
}

function PersonCard({ person, onOpenBilling: openBilling }: { person: StaffClassPerson; onOpenBilling?: (student: { id: string; name: string }) => void }) {
  // 청구 정보는 «서버가 값을 보냈고(원장·부원장) + 화면이 청구 시트를 열 수 있을 때»만 보인다.
  // 선생님은 서버가 billing=null 로 보내고 화면도 onOpenBilling 을 넘기지 않는다(f3 보완).
  const billing = openBilling ? person.billing : null;
  const onOpenBilling = openBilling ?? (() => {});
  const guardian = person.guardians.find((item) => item.isPrimary) ?? person.guardians[0];
  // 오늘 출결 표시 — 색은 공용 지도(statusTones), 미확인은 중립
  const attendance = person.todayStatus === "PRESENT" ? ["출석", TONE_BADGE_CLASS[ATTENDANCE_TONE.PRESENT]] : person.todayStatus === "LATE" ? ["지각", TONE_BADGE_CLASS[ATTENDANCE_TONE.LATE]] : person.todayStatus === "ABSENT" ? ["결석", TONE_BADGE_CLASS[ATTENDANCE_TONE.ABSENT]] : ["미확인", TONE_BADGE_CLASS.neutral];
  return <article className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{person.name}</h3><p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">{[person.school, person.grade].filter(Boolean).join(" · ") || "학교·학년 미등록"}</p></div><div className="flex flex-wrap justify-end gap-1.5"><span className={`rounded px-2.5 py-1 text-xs ${attendance[1]}`}>{attendance[0]}</span>{billing && billing.unpaidCount > 0 && <span className={`rounded px-2.5 py-1 text-xs tabular-nums ${TONE_BADGE_CLASS[PAYMENT_TONE.UNPAID]}`}>미납 {billing.unpaidCount}건</span>}</div></div>
    {billing && billing.unpaidCount > 0 && <button type="button" onClick={() => onOpenBilling({ id: person.id, name: person.name })} className={`mt-3 flex min-h-12 w-full items-center justify-between rounded-xl px-3 text-left text-sm font-medium ${TONE_BADGE_CLASS[PAYMENT_TONE.UNPAID]}`}><span className="tabular-nums">미납 {billing.unpaidAmount.toLocaleString("ko-KR")}원</span><span>청구 확인</span></button>}
    <div className="mt-3 grid grid-cols-3 gap-2"><ContactLink phone={person.studentPhone} label="학생 전화" /><ContactLink phone={guardian?.phone ?? null} label="학부모 전화" accent /><ContactLink phone={guardian?.phone ?? null} label="문자" sms /></div>
    {billing && billing.unpaidCount === 0 && <button type="button" onClick={() => onOpenBilling({ id: person.id, name: person.name })} className="academy-button-secondary mt-2 w-full">청구 내역</button>}
    <details className="group mt-3 rounded-xl bg-[var(--color-academy-soft)]"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium"><span>상세정보 · 보호자 {person.guardians.length}명</span><span className="material-symbols-outlined transition-transform group-open:rotate-180" aria-hidden="true">expand_more</span></summary><div className="space-y-3 border-t border-[var(--color-academy-line)] px-3 py-3 text-sm"><p className="text-[var(--color-academy-muted)]">최근 {person.recentAttendance.total}회: 출석 {person.recentAttendance.present} · 지각 {person.recentAttendance.late} · 결석 {person.recentAttendance.absent}</p>{person.memo && <p className="whitespace-pre-wrap rounded-lg bg-white p-3 text-[var(--color-academy-ink)]">{person.memo}</p>}<div className="space-y-2">{person.guardians.map((item, index) => <div key={item.id ?? `${item.name}-${index}`} className="flex items-center justify-between gap-2"><span className="font-medium">{item.name} · {item.relation}</span><span className="tabular-nums text-[var(--color-academy-muted)]">{item.phone || "연락처 없음"}</span></div>)}</div></div></details>
  </article>;
}

// accent(학부모 전화) = 보조 버튼(흰 바탕·입력선 테두리·검정 글자) — 학생마다 반복되는 버튼이라 검정 채움을 걷었다. 전화 버튼은 어느 화면이든 같은 모양(2026-11-09)
function ContactLink({ phone, label, accent = false, sms = false }: { phone: string | null; label: string; accent?: boolean; sms?: boolean }) {
  if (!phone) return <span className="flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-academy-soft)] px-1 text-center text-xs text-[var(--color-academy-faint)]">연락처 없음</span>;
  return <a href={`${sms ? "sms" : "tel"}:${phoneHref(phone)}`} className={`flex min-h-11 items-center justify-center rounded-xl px-1 text-center text-xs font-medium ${accent ? "border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)]" : "border border-[var(--color-academy-line)]"}`}>{label}</a>;
}
// 2026-11-13 UI 통일: 큰 장식 아이콘 없이 글자로만 알린다
function SheetMessage({ text }: { text: string }) { return <div className="py-12 text-center text-sm text-[var(--color-academy-muted)]">{text}</div>; }
