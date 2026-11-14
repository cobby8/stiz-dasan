"use client";

import { useEffect, useState } from "react";
import { loadStaffClassPeople } from "@/app/actions/staff-class-people";
import { loadStaffRosterPhotoVersions } from "@/app/actions/staff-sessions";
import type { StaffClassPerson } from "@/lib/staff-class-people";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { ATTENDANCE_TONE, PAYMENT_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";

const phoneHref = (phone: string) => phone.replace(/[^\d+]/g, "");

export type ClassPeopleState = {
  people: StaffClassPerson[];
  /** 학생 id → 프로필 사진 캐시 버전(사진이 있는 학생만) */
  photoVersions: Record<string, string>;
  loading: boolean;
  error: string;
  /** 한 번이라도 다 읽었는가 */
  loaded: boolean;
  reload: () => void;
};

/**
 * 출석부에 통합한 «학생 정보»(2026-11-15) — 예전 학생 정보 시트(ClassPeopleSheet)가 읽던 것과 같은 서버 기능을 쓴다.
 * 출석부를 처음 펼칠 때(enabled) 한 번만 읽는다. 연락처가 들어 있어 화면을 닫으면 버린다(따로 저장하지 않는다).
 */
export function useClassPeople(input: { classId: string; sessionId?: string | null; sessionDateId?: string | null; enabled: boolean }): ClassPeopleState {
  const { classId, sessionId, sessionDateId, enabled } = input;
  const [people, setPeople] = useState<StaffClassPerson[]>([]);
  const [photoVersions, setPhotoVersions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    queueMicrotask(() => { if (active) { setLoading(true); setError(""); } });
    void loadStaffClassPeople({ classId, sessionId, sessionDateId })
      .then((result) => {
        if (!result.ok) throw new Error(result.message);
        if (active) { setPeople(result.people); setLoaded(true); }
      })
      .catch((reason: unknown) => { if (active) setError(userErrorMessage(reason, "학생 정보를 불러오지 못했습니다.")); })
      .finally(() => { if (active) setLoading(false); });
    // 프로필 사진은 없어도 되는 정보라 실패해도 조용히 첫 글자로 그린다
    void loadStaffRosterPhotoVersions({ classId, sessionId, sessionDateId })
      .then((result) => { if (active && result.ok) setPhotoVersions(result.versions); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [attempt, classId, enabled, sessionDateId, sessionId]);

  return { people, photoVersions, loading, error, loaded, reload: () => setAttempt((value) => value + 1) };
}

const TODAY_LABEL = { PRESENT: "출석", LATE: "지각", ABSENT: "결석" } as const;

/**
 * 출석부 줄의 이름을 누르면 그 자리에서 펼쳐지는 학생 정보.
 * 예전 시트가 보여 주던 것 전부: 프로필 사진·학교/학년·오늘 상태·학생/학부모 전화·문자·메모·최근 출결·보호자 전체·(원장·부원장만) 미납·청구.
 */
export function RosterPersonInfo({
  person,
  photoVersion,
  todayStatus,
  onOpenBilling: openBilling,
}: {
  person: StaffClassPerson;
  photoVersion?: string | null;
  /** 출석부에서 방금 찍은 상태(있으면 서버에서 읽은 오늘 상태보다 먼저 쓴다). undefined = 서버 값 사용 */
  todayStatus?: "PRESENT" | "LATE" | "ABSENT" | null;
  /** 없으면(선생님 화면) 미납 배지·청구 버튼을 숨긴다(f3 보완). */
  onOpenBilling?: (student: { id: string; name: string }) => void;
}) {
  // 청구 정보는 «서버가 값을 보냈고(원장·부원장) + 화면이 청구 시트를 열 수 있을 때»만 보인다.
  const billing = openBilling ? person.billing : null;
  const guardian = person.guardians.find((item) => item.isPrimary) ?? person.guardians[0];
  const status = todayStatus === undefined ? person.todayStatus : todayStatus;
  const statusClass = status === "PRESENT" ? TONE_BADGE_CLASS[ATTENDANCE_TONE.PRESENT] : status === "LATE" ? TONE_BADGE_CLASS[ATTENDANCE_TONE.LATE] : status === "ABSENT" ? TONE_BADGE_CLASS[ATTENDANCE_TONE.ABSENT] : TONE_BADGE_CLASS.neutral;
  // 사진 주소는 권한을 확인하는 조회 주소다(담당 선생님·관리자만 열린다). 'item:' 으로 시작하는 미전환 신청자는 사진이 없다.
  const photoSrc = profilePhotoUrl({ kind: "student", id: person.id }, photoVersion ?? null, true);

  return (
    <div className="mt-2 space-y-3 rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm">
      <div className="flex items-center gap-3">
        <ProfileAvatar decorative name={person.name} src={photoSrc} size={40} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[var(--color-academy-ink)]">{person.name}</p>
          <p className="text-xs text-[var(--color-academy-muted)]">{[person.school, person.grade].filter(Boolean).join(" · ") || "학교·학년 미등록"}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <span className={`rounded px-2 py-0.5 text-xs ${statusClass}`}>오늘 {status ? TODAY_LABEL[status] : "미확인"}</span>
          {billing && billing.unpaidCount > 0 && <span className={`rounded px-2 py-0.5 text-xs tabular-nums ${TONE_BADGE_CLASS[PAYMENT_TONE.UNPAID]}`}>미납 {billing.unpaidCount}건</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <ContactLink phone={person.studentPhone} label="학생 전화" />
        <ContactLink phone={guardian?.phone ?? null} label="학부모 전화" />
        <ContactLink phone={guardian?.phone ?? null} label="문자" sms />
      </div>

      {billing && (
        <button type="button" onClick={() => openBilling?.({ id: person.id, name: person.name })} className="academy-button-secondary w-full">
          {billing.unpaidCount > 0 ? <span className="tabular-nums">미납 {billing.unpaidAmount.toLocaleString("ko-KR")}원 · 청구 확인</span> : "청구 내역"}
        </button>
      )}

      <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">
        최근 {person.recentAttendance.total}회: 출석 {person.recentAttendance.present} · 지각 {person.recentAttendance.late} · 결석 {person.recentAttendance.absent}
      </p>

      {person.memo && <p className="whitespace-pre-wrap rounded-lg bg-[var(--color-academy-surface)] p-3 text-[var(--color-academy-ink)]">{person.memo}</p>}

      <ul aria-label={`${person.name} 보호자`} className="space-y-1">
        {person.guardians.length === 0 && <li className="text-xs text-[var(--color-academy-muted)]">등록된 보호자가 없습니다.</li>}
        {person.guardians.map((item, index) => (
          <li key={item.id ?? `${item.name}-${index}`} className="flex min-h-11 items-center justify-between gap-2">
            <span className="min-w-0 break-keep font-medium text-[var(--color-academy-ink)]">{item.name} · {item.relation}</span>
            {item.phone
              ? <a href={`tel:${phoneHref(item.phone)}`} className="shrink-0 tabular-nums text-[var(--color-academy-primary)] underline underline-offset-2">{item.phone}</a>
              : <span className="shrink-0 text-xs text-[var(--color-academy-faint)]">연락처 없음</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// 전화·문자 버튼은 학생마다 반복되므로 보조 모양(흰 바탕·테두리) — 예전 학생 정보 시트와 같은 모양
function ContactLink({ phone, label, sms = false }: { phone: string | null; label: string; sms?: boolean }) {
  if (!phone) return <span className="flex min-h-11 items-center justify-center rounded-xl bg-[var(--color-academy-surface)] px-1 text-center text-xs text-[var(--color-academy-faint)]">연락처 없음</span>;
  return <a href={`${sms ? "sms" : "tel"}:${phoneHref(phone)}`} className="flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-1 text-center text-xs font-medium text-[var(--color-academy-ink)]">{label}</a>;
}
