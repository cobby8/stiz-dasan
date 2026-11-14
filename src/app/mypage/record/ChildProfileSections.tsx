"use client";

import UiIcon from "@/components/common/UiIcon";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { TONE_BADGE_CLASS, type StatusTone } from "@/lib/ui/statusTones";
import type { ChildProfile, ChildShuttle } from "@/lib/parent/childRecordQuery";
import { birthLine, classTimeText, dotYmd, genderText, gradeLine, guardianRows, makeupLine } from "@/lib/parent/childProfileRules";
import { changeLine } from "@/lib/parent/childEditRules";
import { realBirthYmd } from "@/lib/makeup/student-grade";
import { formatPhoneInput } from "@/lib/application-display-format";
import PhoneChangeButton from "@/components/account/PhoneChangeButton";
import type { ShuttleDayLeg, ShuttleDayRow, ShuttleDayStatus } from "@/lib/shuttle/childShuttleRules";
import { presetHref } from "@/lib/parent/classCards";
import { kstLabel } from "@/lib/datetime/kst";
import ProfilePhotoEditor from "@/components/parent/ProfilePhotoEditor";

// 수정 시트는 «수정»을 눌렀을 때만 내려받는다(서버 동작을 부르는 부품이라 첫 화면 묶음에 넣지 않는다)
const ChildInfoEditSheet = dynamic(() => import("./ChildInfoEditSheet"), { ssr: false });

// 학부모 «아이 기록» 위쪽 칸(2026-11-14 원장 «관리자 원생 상세 참고해서 아이 정보 모두 + 셔틀 정확하게»):
//  아이 정보 → (요약 4칸은 ChildRecordClient) → 수강 반 → 셔틀.
// 컴팩트 UI: 머리줄을 누르면 접기/펼치기(화살표 — 2026-11-15 아이콘 예외) · «라벨 : 값» 한 줄 행 · 터치 44px · 글자 12px 이상.
// 계산은 전부 순수 규칙(childProfileRules·childShuttleRules)에서 — 여기는 그리기만.

/** 접히는 칸 — 머리줄 전체가 버튼(44px). 오른쪽 끝은 펼침 화살표(이름은 제목 글자) */
export function CollapsibleSection({ id, title, note, defaultOpen = true, children }: { id: string; title: string; note?: string | null; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    // id = 바로가기 주소(#record-info 등) — 마이페이지 «사진 올리기»가 이 칸으로 바로 온다(2026-11-14)
    <section id={id} aria-labelledby={`${id}-heading`} className="academy-panel scroll-mt-4 overflow-hidden">
      <h2 id={`${id}-heading`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left"
        >
          <span className="academy-section-title min-w-0 flex-1">{title}</span>
          {note && <span className="shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">{note}</span>}
          <span className="inline-flex shrink-0 text-[var(--color-academy-muted)]"><UiIcon name={open ? "expand_less" : "expand_more"} /></span>
        </button>
      </h2>
      {open && <div id={`${id}-body`} className="border-t border-[var(--color-academy-line)]">{children}</div>}
    </section>
  );
}

/** «라벨 : 값» 한 줄 행 — 관리자 원생 상세 DetailRow 와 같은 모양 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
      <span className="w-20 shrink-0 text-xs text-[var(--color-academy-muted)]">{label}</span>
      <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">{children}</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[tone]}`}>{children}</span>;
}

/** 칸 아래 링크 줄 — 기존 신청·설정 화면으로 보낸다. before = 링크 앞에 둘 버튼(그 자리에서 끝나는 일) */
function LinkBar({ links, before }: { links: { href: string; label: string }[]; before?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 border-t border-[var(--color-academy-line)] px-1.5 py-1">
      {before}
      {links.map((l) => (
        <Link key={l.href + l.label} href={l.href} className="academy-button-text whitespace-nowrap">
          {l.label} ▸
        </Link>
      ))}
    </div>
  );
}

// ── 아이 정보 ───────────────────────────────────────────────────────────────

export function ChildInfoSection({ profile, today, studentId, photo }: {
  profile: ChildProfile | null | undefined;
  today: string;
  studentId: string;
  /** 프로필 사진 올리기 칸(이름·지금 사진의 캐시 버전) — 없으면 칸을 그리지 않는다 */
  photo?: { name: string; version: string | null };
}) {
  // 수정 시트(2026-11-14 b4·b5) — 수정용 값을 읽은 경우에만 «수정» 버튼이 보인다
  const [editing, setEditing] = useState(false);
  if (profile === undefined) return null; // 옛 모양 데이터(칸 없음)
  const edit = profile?.edit ?? null;
  const childName = photo?.name ?? "아이";
  // 확인 중인 이름·생년월일 변경 신청(학원이 승인하면 바뀐다)
  const waiting = edit?.requests.filter((r) => r.status === "PENDING") ?? [];
  // 최근 반려된 신청 — 결과를 모르고 기다리지 않게 한 줄로 알린다(같은 항목을 다시 신청했으면 숨긴다)
  const rejected = (edit?.requests ?? []).filter((r) => r.status === "REJECTED" && !waiting.some((w) => w.field === r.field)).slice(0, 1);
  return (
    <CollapsibleSection id="record-info" title="아이 정보">
      {/* 아이 사진 올리기·바꾸기·지우기(2026-11-15) — 아이 정보를 못 불러와도 사진은 올릴 수 있게 맨 위에 따로 */}
      {photo && (
        <div className="border-b border-[var(--color-academy-line)]">
          <ProfilePhotoEditor target="student" studentId={studentId} ownerId={studentId} name={photo.name} initialVersion={photo.version} />
        </div>
      )}
      {profile === null ? (
        <p role="alert" className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">아이 정보를 불러오지 못했어요.</p>
      ) : (
        <>
          <div className="divide-y divide-[var(--color-academy-line)]">
            {/* 임시 생일(2000-01-01)은 진짜 생일이 아니라 «-» — 학년도 같은 규칙(realBirthYmd)으로 거른다 */}
            <Row label="생년월일">{birthLine(profile.birthYmd, today)}</Row>
            <Row label="학년">{gradeLine(profile.birthYmd, profile.gradeText, today)}</Row>
            <Row label="학교">{profile.school?.trim() || "-"}</Row>
            {edit && <Row label="학생 전화">{edit.phone ? formatPhoneInput(edit.phone) : "-"}</Row>}
            {edit && <Row label="주소">{edit.address?.trim() || "-"}</Row>}
            {edit?.healthAvailable && (
              <Row label="건강·특이">
                <span className="whitespace-pre-wrap">{edit.healthNote?.trim() || "-"}</span>
              </Row>
            )}
            <Row label="성별">{genderText(profile.gender) ?? "-"}</Row>
            <Row label="등록일">{dotYmd(profile.enrollYmd) || "-"}</Row>
            {profile.guardians ? (
              guardianRows(profile.guardians).map((r) => <Row key={r.label} label={r.label}>{r.value}</Row>)
            ) : (
              <Row label="보호자">불러오지 못했어요</Row>
            )}
            <Link href={presetHref("/mypage/makeup", { studentId })} className="block hover:bg-[var(--color-academy-soft)]">
              <Row label="보강권">{profile.makeup ? makeupLine(profile.makeup) : "불러오지 못했어요"}</Row>
            </Link>
          </div>
          {/* 변경 신청 상태 — 확인 중 / 최근 반려(사유) */}
          {(waiting.length > 0 || rejected.length > 0) && (
            <ul className="border-t border-[var(--color-academy-line)]">
              {waiting.map((r) => (
                <li key={r.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                  <Badge tone="warning">확인 중</Badge>
                  <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">{changeLine(r)}</span>
                </li>
              ))}
              {rejected.map((r) => (
                <li key={r.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                  <Badge tone="neutral">반려</Badge>
                  <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                    {changeLine(r)}
                    {r.note && <span className="block text-xs text-[var(--color-academy-muted)]">{r.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* 그 자리에서 고친다: 아이 정보 «수정»(시트) · 내 연락처(본인인증). 본인인증이 꺼진 환경이면 설정 화면 링크 */}
          <LinkBar
            before={
              <>
                {edit && (
                  <button type="button" onClick={() => setEditing(true)} className="academy-button-tonal whitespace-nowrap" aria-haspopup="dialog">
                    수정
                  </button>
                )}
                <PhoneChangeButton
                  label="내 연락처 바꾸기"
                  className="academy-button-text whitespace-nowrap"
                  messageClassName="px-2 text-xs"
                  fallback={<Link href="/mypage/settings#my-phone" className="academy-button-text whitespace-nowrap">내 연락처 보기 ▸</Link>}
                />
              </>
            }
            links={[{ href: "/mypage/children", label: "가족 연결" }]}
          />
          {editing && edit && (
            <ChildInfoEditSheet
              studentId={studentId}
              name={childName}
              birthYmd={realBirthYmd(profile.birthYmd)}
              school={profile.school}
              gradeText={gradeLine(profile.birthYmd, profile.gradeText, today)}
              edit={edit}
              onClose={() => setEditing(false)}
            />
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

// ── 수강 반 ─────────────────────────────────────────────────────────────────

export function ChildClassesSection({ profile, studentId }: { profile: ChildProfile | null | undefined; studentId: string }) {
  if (profile === undefined) return null;
  const classes = profile?.classes ?? null;
  return (
    <CollapsibleSection id="record-classes" title="수강 반" note={classes && classes.length > 0 ? `${classes.length}개 반` : null}>
      {classes === null ? (
        <p role="alert" className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">수강 반을 불러오지 못했어요.</p>
      ) : classes.length === 0 ? (
        <p className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">지금 다니는 반이 없어요.</p>
      ) : (
        <ul className="divide-y divide-[var(--color-academy-line)]">
          {classes.map((c) => (
            // 한 줄 행 두 줄 — 반 이름·상태 / 요일·시간·코치·시작일
            <li key={c.enrollmentId} className="min-h-12 px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-keep text-sm font-semibold text-[var(--color-academy-ink)]">{c.className}</span>
                <Badge tone={c.chip.tone}>{c.chip.text}</Badge>
              </div>
              <p className="break-keep text-xs tabular-nums text-[var(--color-academy-muted)]">
                {[
                  classTimeText(c.dayOfWeek, c.startTime, c.endTime),
                  c.coachName ? `코치 ${c.coachName}` : null,
                  c.startsOn ? `${dotYmd(c.startsOn)} 시작` : null,
                ].filter(Boolean).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
      <LinkBar
        links={[
          { href: `/mypage/classes?child=${encodeURIComponent(studentId)}`, label: "수업 탭에서 보기" },
          { href: presetHref("/mypage/enrollment-change", { studentId }), label: "반 변경·휴원 신청" },
        ]}
      />
    </CollapsibleSection>
  );
}

// ── 셔틀 ────────────────────────────────────────────────────────────────────

const DAY_TONE: Record<ShuttleDayStatus, StatusTone> = {
  RUN: "success",
  HOLIDAY: "neutral",
  PAUSED: "neutral",
  ENDED: "neutral",
  NOT_STARTED: "info",
  ABSENT: "warning",
  NO_CLASS: "neutral",
  CHECK: "warning",
};

/** 운행 일정 한 다리 «등원 17:45 다산푸르지오» / «등원 안 탐(신청)» / «등원 다른 곳: 학교 정문» */
function legText(name: "등원" | "하원", leg: ShuttleDayLeg | null): string | null {
  if (!leg) return null;
  if (leg.state === "SKIP") return `${name} 안 탐(신청)`;
  if (leg.state === "CHANGED") return `${name} 다른 곳: ${leg.changedTo ?? "-"}`;
  return [name, leg.time, leg.stopName].filter(Boolean).join(" ");
}

function dayDetail(d: ShuttleDayRow): string {
  // 명단 요일·시간에 맞는 반이 없다 — 운행으로 치지 않고 학원 확인을 안내한다
  // 학부모가 할 일은 없다(학원이 명단을 맞춘다) — 행동을 요구하지 않는 한 줄
  if (d.status === "CHECK") return "학원 확인 중";
  if (d.status === "NO_CLASS") return "다니는 반이 없어요";
  if (d.status !== "RUN") return d.className ?? "";
  return [legText("등원", d.board), legText("하원", d.alight)].filter(Boolean).join(" · ");
}

const OTHER_STATUS: Record<string, { text: string; tone: StatusTone }> = {
  REQUESTED: { text: "신청 접수", tone: "warning" },
  PREPARING: { text: "배정 준비 중", tone: "info" },
  CONFIRMED: { text: "배정 확정", tone: "success" },
  COMPLETED: { text: "운행 완료", tone: "neutral" },
};

export function ChildShuttleSection({ shuttle, studentId }: { shuttle: ChildShuttle | null | undefined; studentId: string }) {
  if (shuttle === undefined) return null;
  const weekly = shuttle?.regular.weekly ?? [];
  const days = shuttle?.regular.days ?? [];
  const others = shuttle?.others ?? [];
  const uses = weekly.length > 0 || others.length > 0;
  const monthNote = shuttle?.regular.rosterMonth ? `${Number(shuttle.regular.rosterMonth.slice(5, 7))}월 명단` : null;
  return (
    <CollapsibleSection id="record-shuttle" title="셔틀" note={uses ? monthNote : null}>
      {shuttle === null ? (
        <p role="alert" className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">셔틀 정보를 불러오지 못했어요.</p>
      ) : !uses ? (
        <p className="px-3 py-3 text-sm text-[var(--color-academy-muted)]">셔틀을 이용하지 않아요.</p>
      ) : (
        <>
          {/* 요일별 승하차 — 관리자 원생 상세 «셔틀 배차»와 같은 명단 행 */}
          {weekly.length > 0 && (
            <div>
              <p className="bg-[var(--color-academy-soft)] px-3 py-1 text-xs font-medium text-[var(--color-academy-muted)]">요일별 타는 곳·시각</p>
              <ul className="divide-y divide-[var(--color-academy-line)]">
                {weekly.map((w) => (
                  <li key={`${w.weekday}|${w.classTime ?? ""}`} className="flex min-h-11 items-start gap-2 px-3 py-1.5 text-sm">
                    <span className="w-20 shrink-0 text-xs leading-5 text-[var(--color-academy-muted)]">
                      {w.dayLabel}
                      {w.classTime ? ` ${w.classTime.split(/[~\-–]/)[0]} 수업` : ""}
                    </span>
                    <span className="min-w-0 flex-1 break-keep tabular-nums text-[var(--color-academy-ink)]">
                      {/* 타는 쪽만 보인다 — «등원 셔틀 없음»·«하원 셔틀 없음» 줄은 그리지 않는다(2026-11-14 문구 정리) */}
                      {w.board && <span className="block">{`승차 ${w.board.time ?? "시각 미정"} · ${w.board.stopName}`}</span>}
                      {w.alight && <span className="block">{`하차 ${w.alight.time ?? "시각 미정"} · ${w.alight.stopName}`}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* 오늘부터 7일 — 휴무·휴원·결석·«안 탐» 신청을 반영한 실제 운행 */}
          {weekly.length > 0 && (
            <div>
              <p className="bg-[var(--color-academy-soft)] px-3 py-1 text-xs font-medium text-[var(--color-academy-muted)]">다가오는 운행 · 7일</p>
              {days.length === 0 ? (
                <p className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">7일 안에 운행하는 날이 없어요.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-academy-line)]">
                  {days.map((d) => (
                    <li key={`${d.ymd}|${d.classTime ?? ""}`} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="w-16 shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">{kstLabel(d.ymd)}</span>
                      <Badge tone={d.statusText === "안 탐(신청)" ? "info" : DAY_TONE[d.status]}>{d.statusText}</Badge>
                      <span className="min-w-0 flex-1 break-keep tabular-nums text-[var(--color-academy-ink)]">
                        {dayDetail(d)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* 방학특강 셔틀·정규 셔틀 신청 접수 — 기존 학부모 셔틀 조회 그대로 */}
          {others.length > 0 && (
            <div>
              <p className="bg-[var(--color-academy-soft)] px-3 py-1 text-xs font-medium text-[var(--color-academy-muted)]">
                {others.some((o) => o.sourceType === "SPECIAL_PROGRAM") ? "방학특강 셔틀·신청" : "셔틀 신청"}
              </p>
              <ul className="divide-y divide-[var(--color-academy-line)]">
                {others.map((o) => {
                  const st = OTHER_STATUS[o.status] ?? { text: o.status, tone: "neutral" as StatusTone };
                  const eta = o.direction === "DROPOFF" ? o.dropoffEtaLabel : o.pickupEtaLabel ?? o.dropoffEtaLabel;
                  return (
                    <li key={o.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">
                        {o.title}
                        <span className="block text-xs tabular-nums text-[var(--color-academy-muted)]">
                          {[
                            o.serviceDate ? kstLabel(o.serviceDate) : null,
                            o.direction ? (o.direction === "PICKUP" ? "등원" : "하원") : null,
                            o.stopName,
                            eta,
                          ].filter(Boolean).join(" · ") || "배차 준비 중"}
                        </span>
                      </span>
                      <Badge tone={st.tone}>{st.text}</Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {/* 기사님 연락 — 홈과 같은 규칙(공용 기사 계정 이름·전화) */}
          {shuttle.driver?.phone && (
            <a
              href={`tel:${shuttle.driver.phone.replace(/[^0-9]/g, "")}`}
              aria-label={`셔틀 기사님 ${shuttle.driver.name}에게 전화하기`}
              className="flex min-h-11 items-center gap-2 border-t border-[var(--color-academy-line)] px-3 py-1.5 text-sm hover:bg-[var(--color-academy-soft)]"
            >
              <span className="w-20 shrink-0 text-xs text-[var(--color-academy-muted)]">기사님</span>
              <span className="min-w-0 flex-1 text-[var(--color-academy-ink)]">{shuttle.driver.name} · 전화하기</span>
            </a>
          )}
          <p className="border-t border-[var(--color-academy-line)] px-3 py-1.5 text-xs text-[var(--color-academy-muted)]">
            길 사정에 따라 시각이 조금 달라질 수 있어요
          </p>
        </>
      )}
      {uses && <LinkBar links={[{ href: presetHref("/mypage/shuttle", { studentId }), label: "셔틀 변경" }]} />}
    </CollapsibleSection>
  );
}
