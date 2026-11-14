"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import type { ParentIllnessReview, UpcomingChild, UpcomingClassDate } from "@/lib/regular/parent-regular-absence";
import type { RegularMakeupRow } from "@/lib/regular/parent-regular-makeup";
import { groupByUpcomingDate } from "@/components/admin/list/upcomingDateGroups";
import { todayKst } from "@/lib/datetime/kst";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { presetFirst } from "@/lib/mypage/requestPreset";
import { resumeNotice } from "@/lib/enrollment/resumeWindow";
import { compressImageForUpload } from "@/lib/clientImageCompression";
import { EVIDENCE_MAX_PHOTOS, ILLNESS_REASON, REASON_TEXT_MAX, illnessReviewLabel } from "@/lib/regular/illnessCarryRules";

// 날짜 묶음 이름 — 가까운 수업일이 먼저 보이게(오늘 → 이번 주 → 다음 주 → 이후)
const DATE_GROUP_LABELS = { today: "오늘", thisWeek: "이번 주", nextWeek: "다음 주", later: "이후", past: "지난 수업" };

// 결석 사유 선택지(정규 5종). 방학특강과 동일 집합.
const REASONS: { value: string; label: string }[] = [
  { value: "ILLNESS_INJURY", label: "질병/부상" },
  { value: "PERSONAL", label: "개인 사정" },
  { value: "FAMILY_TRIP", label: "가족 여행" },
  { value: "SCHOOL_EVENT", label: "학교 행사" },
  { value: "ETC", label: "기타" },
];

// 결석 신고의 보강권 상태 → 행에 붙는 짧은 글(2026-11-10: 신고 즉시 보강권 발급)
// AVAILABLE(보강권 1장)은 글자가 아니라 «보강 예약하기» 버튼으로 보인다(2026-11-14 — 보강 화면으로 바로 이어지게)
const CREDIT_NOTE: Record<string, string> = {
  RESERVED: "보강 예약됨",
  USED: "보강 완료",
  NO_SHOW: "보강 불참",
};

// 질병·부상 이월 검토 상태 → 배지 색 뜻(상태색 5종: 검토 중=주의 · 승인=완료 · 보강권 전환=안내)
const REVIEW_BADGE: Record<string, string> = {
  PENDING: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  APPROVED: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
  MAKEUP: "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]",
};

// 증빙 사진으로 받는 형식(서버와 같은 집합 — gif 제외)
const EVIDENCE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const EVIDENCE_ACCEPT = EVIDENCE_TYPES.join(",");
const evidenceUrl = (id: string) => `/api/mypage/regular-absence/evidence?id=${encodeURIComponent(id)}`;

/** 학원 연락처(설정값) — 마감 뒤에는 여기서 바로 전화·문의로 이어진다 */
export type AbsenceContact = { phone: string | null; kakaoChannelUrl: string | null };

// 이미 보강을 들었거나(무단 불참 포함) — 신고 취소를 막는 상태(서버도 같은 규칙으로 막는다)
function creditBlocksCancel(d: UpcomingClassDate) {
  return d.makeupCredit === "USED" || d.makeupCredit === "NO_SHOW";
}

// 지금 신고·취소·사유 변경을 받을 수 있는 줄인가(서버가 준 값 — 서버도 같은 규칙으로 다시 막는다).
// 값이 없으면(옛 응답) 열린 것으로 본다: 막는 쪽은 서버다.
function changeOpen(d: UpcomingClassDate) {
  return d.changeOpen !== false;
}

// 다가오는 날짜 하나를 나타내는 카드용 키(자녀·반·날짜 조합).
function dateKey(d: UpcomingClassDate) {
  return `${d.studentId}|${d.classId}|${d.date}`;
}

/**
 * 여기서 바꿀 수 없는 줄(마감·학원 확정·보강 완료)의 안내 — 한 단어 + 그 자리에서 전화·문의 버튼.
 * (원장: «학원에 문의하세요» 글만 두지 말고 바로 해결할 수 있게)
 */
function ContactActions({ label, contact }: { label: string; contact: AbsenceContact }) {
  return (
    <span className="flex basis-full flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-[var(--color-academy-muted)]">{label}</span>
      {contact.phone && (
        <a href={`tel:${contact.phone.replace(/[^0-9+]/g, "")}`} className="academy-button-secondary whitespace-nowrap">
          전화
        </a>
      )}
      {contact.kakaoChannelUrl && (
        <a href={contact.kakaoChannelUrl} data-outside-link target="_blank" rel="noopener noreferrer" className="academy-button-secondary whitespace-nowrap">
          카카오 문의
        </a>
      )}
    </span>
  );
}

export default function RegularAbsenceClient({
  initial,
  initialReviews = [],
  makeups = [],
  presetStudentId = null,
  contact = { phone: null, kakaoChannelUrl: null },
}: {
  initial: UpcomingChild[];
  /** 질병·부상 결석의 이월 검토(상태·사진) */
  initialReviews?: ParentIllnessReview[];
  makeups?: RegularMakeupRow[];
  /** 수업 탭 반 카드에서 온 아이 — 그 아이 날짜를 맨 위에(나머지 순서는 그대로) */
  presetStudentId?: string | null;
  contact?: AbsenceContact;
}) {
  const [children, setChildren] = useState<UpcomingChild[]>(initial);
  const [reviews, setReviews] = useState<ParentIllnessReview[]>(initialReviews);
  const [openKey, setOpenKey] = useState<string>(""); // 신고 폼이 열린 날짜 키
  const [reason, setReason] = useState<Record<string, string>>({}); // 날짜별 선택 사유
  const [reasonText, setReasonText] = useState<Record<string, string>>({}); // 날짜별 사유 글(질병·부상)
  const [photos, setPhotos] = useState<Record<string, File[]>>({}); // 날짜별 고른 증빙 사진(질병·부상)
  const [busyKey, setBusyKey] = useState<string>("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  // 서버에서 최신 상태 재조회.
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/mypage/regular-absence", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) {
        setChildren(j.children || []);
        setReviews(j.reviews || []);
      }
    } catch {
      /* noop */
    }
  }, []);

  // 증빙 사진 한 장 올리기 — 휴대폰 원본을 줄여서 보낸다(서버가 다시 인코딩해 위치·기기 정보를 지운다).
  const uploadEvidence = useCallback(async (absenceId: string, file: File) => {
    const compact = await compressImageForUpload(file, { maxEdge: 2000, targetBytes: 1.5 * 1024 * 1024, allowedTypes: EVIDENCE_TYPES });
    const form = new FormData();
    form.append("absenceId", absenceId);
    form.append("file", compact);
    const res = await fetch("/api/mypage/regular-absence/evidence", { method: "POST", body: form });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.error || "사진을 올리지 못했어요.");
  }, []);

  // 결석 알리기 · 사유 변경(신고된 줄에서 다른 사유로 다시 보내면 서버가 사유만 바꾼다).
  const report = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      const r = reason[key];
      if (!r) {
        setErr("결석 사유를 선택해 주세요.");
        return;
      }
      const illness = r === ILLNESS_REASON;
      const text = (reasonText[key] || "").trim();
      // 질병·부상이면 사유 글이 필수(서버도 다시 본다)
      if (illness && !text) {
        setErr("어디가 아픈지 한 줄로 적어 주세요. (예: 독감, 발목 염좌)");
        return;
      }
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
            reason: r,
            reasonText: illness ? text : null,
          }),
        });
        const j = await res.json();
        if (!res.ok) {
          // 화면을 연 뒤 마감(수업 1시간 전)이 지난 경우 — 다시 읽어 그 줄이 «마감»으로 바뀌게 한다
          if (j?.code === "ABSENCE_CHANGE_CLOSED") await reload();
          throw new Error(j?.error || "신고에 실패했습니다.");
        }
        // 질병·부상: 고른 사진을 이어서 올린다. 사진이 실패해도 결석은 이미 알렸다 — 7일 안에 다시 올리면 된다.
        const pending = j?.carryReview === "PENDING";
        const chosen = illness && pending && j?.absenceId ? (photos[key] || []).slice(0, EVIDENCE_MAX_PHOTOS) : [];
        let uploaded = 0;
        let uploadError = "";
        for (const file of chosen) {
          try {
            await uploadEvidence(j.absenceId, file);
            uploaded += 1;
          } catch (e) {
            uploadError = customerMessage(e, "사진을 올리지 못했어요.");
          }
        }
        // 완료 문구 — 질병·부상(이월 검토)·보강권 발급·그 밖으로 나눈다
        const head = d.reported ? "결석 사유를 바꿨어요." : "결석을 알렸어요.";
        setMsg(
          pending
            ? uploaded > 0
              ? `${head} 사진을 확인한 뒤 다음 달 수강료에서 빼 드려요.`
              : `${head} 7일 안에 증빙 사진을 올려 주시면 확인한 뒤 다음 달 수강료에서 빼 드려요.`
            : d.reported
              ? head
              : j?.makeupCreditIssued
                ? `${head} 보강권 1장이 생겼어요.`
                : `${head} 학원에서 확인합니다.`,
        );
        if (uploadError) setErr(`${uploadError} 아래 «질병·부상 결석»에서 다시 올려 주세요.`);
        setOpenKey("");
        setPhotos((prev) => ({ ...prev, [key]: [] }));
        await reload();
      } catch (e) {
        setErr(customerMessage(e, "결석 신고를 접수하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      } finally {
        setBusyKey("");
      }
    },
    [reason, reasonText, photos, reload, uploadEvidence],
  );

  // 결석 신고 취소.
  const cancel = useCallback(
    async (d: UpcomingClassDate) => {
      const key = dateKey(d);
      setErr("");
      setMsg("");
      setBusyKey(key);
      try {
        const res = await fetch("/api/mypage/regular-absence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            studentId: d.studentId,
            classId: d.classId,
            date: d.date,
            // 보강 예약이 있는 결석은 확인 문구(«보강 예약도 함께 취소돼요»)를 보고 누른 것이므로 함께 취소를 허락한다
            confirmMakeupCancel: d.makeupCredit === "RESERVED",
          }),
        });
        const j = await res.json();
        if (!res.ok) {
          // 화면을 연 뒤 보강 예약이 생긴 경우 — 최신 상태를 다시 읽어 «보강 예약도 함께 취소돼요» 확인 문구가 뜨게 한다
          if (j?.code === "MAKEUP_BOOKING_CONFIRM_REQUIRED") await reload();
          // 화면을 연 뒤 마감(수업 1시간 전)이 지난 경우도 다시 읽는다
          if (j?.code === "ABSENCE_CHANGE_CLOSED") await reload();
          throw new Error(j?.error || "취소에 실패했습니다.");
        }
        setMsg(
          j?.makeupBookingCanceled
            ? "결석 신고와 보강 예약을 취소했어요."
            : j?.makeupCreditRevoked
              ? "결석 신고를 취소했어요. 보강권도 함께 회수됐어요."
              : "결석 신고를 취소했어요.",
        );
        await reload();
      } catch (e) {
        setErr(customerMessage(e, "결석 신고를 취소하지 못했습니다. 잠시 후 다시 시도해 주세요."));
      } finally {
        setBusyKey("");
      }
    },
    [reload],
  );

  // «질병·부상 결석» 칸에서 사진 추가(알린 날부터 7일 안 · 3장까지 — 서버가 다시 본다)
  const addEvidence = useCallback(
    async (review: ParentIllnessReview, files: File[]) => {
      const room = Math.max(0, EVIDENCE_MAX_PHOTOS - review.photos.length);
      if (files.length === 0 || room === 0) return;
      setErr("");
      setMsg("");
      setBusyKey(`review:${review.absenceId}`);
      let uploaded = 0;
      let failure = "";
      for (const file of files.slice(0, room)) {
        try {
          await uploadEvidence(review.absenceId, file);
          uploaded += 1;
        } catch (e) {
          failure = customerMessage(e, "사진을 올리지 못했어요. 잠시 후 다시 시도해 주세요.");
        }
      }
      if (uploaded > 0) setMsg(`사진 ${uploaded}장을 올렸어요. 확인한 뒤 알려 드릴게요.`);
      if (failure) setErr(failure);
      await reload();
      setBusyKey("");
    },
    [reload, uploadEvidence],
  );

  // 내가 올린 사진 한 장 지우기(바꾸려면 지우고 다시 올린다)
  const removeEvidence = useCallback(
    async (review: ParentIllnessReview, photoId: string) => {
      setErr("");
      setMsg("");
      setBusyKey(`review:${review.absenceId}`);
      try {
        const res = await fetch(evidenceUrl(photoId), { method: "DELETE" });
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.error || "사진을 지우지 못했어요.");
        setMsg("사진을 지웠어요.");
      } catch (e) {
        setErr(customerMessage(e, "사진을 지우지 못했어요. 잠시 후 다시 시도해 주세요."));
      } finally {
        await reload();
        setBusyKey("");
      }
    },
    [reload],
  );

  const hasAnyClass = useMemo(
    () => children.some((c) => c.classes.some((cl) => cl.dates.length > 0)),
    [children],
  );

  // 자녀별로 반을 펼쳐 수업일 하나하나를 날짜 묶음에 넣는다(반 카드 안의 작은 카드 → 날짜별 한 줄 행).
  // 오늘은 KST 모듈로만 구한다.
  const childGroups = useMemo(() => {
    const today = todayKst();
    return presetFirst(children, presetStudentId, (child) => child.studentId)
      .map((child) => ({
        studentId: child.studentId,
        studentName: child.studentName,
        groups: groupByUpcomingDate(child.classes.flatMap((cl) => cl.dates), (d) => d.date, today, DATE_GROUP_LABELS),
      }))
      .filter((child) => child.groups.length > 0);
  }, [children, presetStudentId]);

  // 복귀 예정 반(2026-11-14): 복귀가 승인된 휴원 반은 복귀일 이후 수업만 목록에 있다 — 왜 앞 날짜가 없는지 한 줄로 알린다
  const resumeNotes = useMemo(
    () =>
      children.flatMap((child) =>
        child.classes
          .filter((cl) => cl.resumeFrom)
          .map((cl) => ({ key: `${child.studentId}|${cl.classId}`, who: `${child.studentName} · ${cl.className}`, text: resumeNotice(cl.resumeFrom, "신고") })),
      ),
    [children],
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      {/* 헤더 */}
      <div className="mb-2 flex items-center gap-2">
        {/* 뒤로가기 = 누르는 영역 44×44(academy-back-link) */}
        <Link href="/mypage" aria-label="마이페이지로" className="academy-back-link">
          <span aria-hidden="true">←</span>
        </Link>
        <h1 className="academy-heading">
          결석 알리기
        </h1>
      </div>
      {/* 화면 맨 위 설명 한 줄 = 본문 14px */}
      <p className="mb-4 text-sm text-[var(--color-academy-muted)]">
        수업 1시간 전까지 신고·취소할 수 있어요.
      </p>

      {/* 예정 보강(읽기 전용) — 관리자가 지정한 자녀의 보강 일정 */}
      {makeups.length > 0 && (
        <div className="mb-4 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-academy-info)]">
            예정 보강
          </h2>
          <ul className="divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-xl bg-white">
            {makeups.map((m) => (
              // 한 줄 행: 학생 · 보강 반(줄바꿈 허용) · 보강 날짜(오른쪽) · 상태 / 아래 줄에 원래 결석
              <li key={m.id} className="px-3 py-2">
                <div className="flex min-h-7 items-center gap-2">
                  <span className="shrink-0 text-sm font-semibold text-[var(--color-academy-ink)]">{m.studentName}</span>
                  <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-muted)]">{m.makeupClassName ?? "보강 반"}</span>
                  {m.makeupDateLabel && (
                    <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{m.makeupDateLabel}</span>
                  )}
                  <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">
                    {m.statusLabel}
                  </span>
                </div>
                {(m.originalClassName || m.originalDateLabel) && (
                  <p className="text-xs text-[var(--color-academy-faint)]">
                    (결석: {m.originalClassName ?? ""}
                    {m.originalDateLabel ? ` ${m.originalDateLabel}` : ""})
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {msg && (
        <div role="status" className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-success)]">
          {msg}
        </div>
      )}
      {err && (
        <div role="alert" className="mb-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm font-medium text-[var(--color-academy-danger)]">
          {err}
        </div>
      )}

      {/* 복귀 예정 안내 — 안내(파랑) 한 줄씩. 글자만(아이콘 없음) */}
      {resumeNotes.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] px-4 py-3 text-sm text-[var(--color-academy-info)]">
          {resumeNotes.map((note) => (
            <li key={note.key} className="break-keep">
              <span className="font-medium">{note.who}</span> — {note.text}
            </li>
          ))}
        </ul>
      )}

      {/* 질병·부상 결석(2026-11-14) — 이월 검토 상태 한 단어 + 증빙 사진 추가·삭제(알린 날부터 7일 안) */}
      {reviews.length > 0 && (
        <section aria-label="질병·부상 결석" className="mb-4 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
          <h2 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--color-academy-ink)]">
            <span>질병·부상 결석</span>
            <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{reviews.length}</span>
          </h2>
          <ul className="divide-y divide-[var(--color-academy-line)]">
            {reviews.map((review) => {
              const busy = busyKey === `review:${review.absenceId}`;
              const mine = review.photos.filter((photo) => photo.mine);
              return (
                <li key={review.absenceId} className="px-3 py-2">
                  {/* 한 줄 행: 아이·반(왼쪽) · 날짜(오른쪽) / 아래 줄에 상태 한 단어 + 사진 장수 */}
                  <div className="flex min-h-11 items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                        {review.studentName}
                        <span className="ml-1.5 font-normal text-[var(--color-academy-muted)]">{review.className}</span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${REVIEW_BADGE[review.status] ?? ""}`}>
                          {review.statusLabel}
                        </span>
                        <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
                          사진 {review.photos.length}장{review.canEdit ? ` · ${review.deadlineLabel}까지 올릴 수 있어요` : ""}
                        </span>
                      </p>
                    </div>
                    <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{review.dateLabel}</span>
                  </div>

                  {/* 결과 한 줄 — 승인이면 언제 빠지는지, 보강권 전환이면 바로 예약으로 */}
                  {review.status === "APPROVED" && (
                    <p className="mt-1 text-xs text-[var(--color-academy-muted)]">다음 달 수강료에서 1회분을 빼 드려요.</p>
                  )}
                  {review.status === "MAKEUP" && (
                    <div className="mt-1 flex justify-end">
                      <Link href={`/mypage/makeup?studentId=${encodeURIComponent(review.studentId)}`} className="academy-button-tonal shrink-0">
                        보강 예약하기
                      </Link>
                    </div>
                  )}

                  {/* 내가 올린 사진 — 작은 사진 + (기간 안이면) 삭제. 다른 보호자가 올린 사진은 장수만 보인다 */}
                  {mine.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2" aria-label="올린 사진">
                      {mine.map((photo, index) => (
                        <li key={photo.id} className="flex flex-col items-center gap-1">
                          {/* eslint-disable-next-line @next/next/no-img-element -- 권한 확인 API 가 내려 주는 비공개 사진 */}
                          <img
                            src={evidenceUrl(photo.id)}
                            alt={`올린 증빙 사진 ${index + 1}`}
                            className="h-20 w-20 rounded-lg border border-[var(--color-academy-line)] object-cover"
                          />
                          {review.canEdit && (
                            <InlineConfirm
                              label="삭제"
                              question="이 사진을 지울까요?"
                              confirmLabel="지우기"
                              onConfirm={() => removeEvidence(review, photo.id)}
                              pending={busy}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* 사진 추가 — 검토 중 + 7일 안 + 3장 미만일 때만 */}
                  {review.canAdd && (
                    <div className="mt-2 flex justify-end">
                      <label className={`academy-button-tonal shrink-0 ${busy ? "pointer-events-none opacity-60" : "cursor-pointer"}`}>
                        {busy ? "올리는 중…" : "사진 추가"}
                        <input
                          type="file"
                          accept={EVIDENCE_ACCEPT}
                          multiple
                          disabled={busy}
                          className="sr-only"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            e.target.value = ""; // 같은 사진을 다시 고를 수 있게
                            void addEvidence(review, files);
                          }}
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!hasAnyClass ? (
        <div className="rounded-2xl border border-dashed border-[var(--color-academy-line-input)] bg-white px-6 py-16 text-center text-sm text-[var(--color-academy-muted)]">
          다가오는 정규수업이 없습니다.
        </div>
      ) : (
        <div className="space-y-5">
          {childGroups.map((child) => (
            <div key={child.studentId}>
              <h2 className="mb-2 px-1 text-sm font-semibold text-[var(--color-academy-ink)]">{child.studentName}</h2>
              <div className="space-y-3">
                {child.groups.map((group) => (
                  // 날짜 묶음(오늘/이번 주/다음 주/이후) — 묶음 제목 오른쪽에 건수
                  <section
                    key={group.key}
                    aria-label={`${child.studentName} ${group.label}`}
                    className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white"
                  >
                    <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--color-academy-ink)]">
                      <span>{group.label}</span>
                      <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                    </h3>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                      {group.items.map((d) => {
                        const key = dateKey(d);
                        const busy = busyKey === key;
                        const reviewLabel = illnessReviewLabel(d.carryReview);
                        const illnessChosen = reason[key] === ILLNESS_REASON;
                        const chosenPhotos = photos[key] || [];
                        return (
                          <li key={key} className="px-3 py-1.5">
                            {/* 한 줄 행: 반·시각(왼쪽, 줄바꿈 허용) · 날짜(오른쪽, 숫자 폭 고정) · 동작 버튼 */}
                            <div className="flex min-h-11 flex-wrap items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                                  {d.className}
                                  <span className="ml-1.5 text-xs font-normal tabular-nums text-[var(--color-academy-faint)]">{d.startTime}</span>
                                </p>
                                {/* 상태 배지와 사유를 따로 나눠 보인다(«확정됨 · 사유» 이어 붙이지 않음) */}
                                {d.locked ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-success)]">
                                      확정됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    {/* 질병·부상이면 이월 검토 상태 한 단어 */}
                                    {reviewLabel && <span className="text-xs text-[var(--color-academy-info)]">{reviewLabel}</span>}
                                  </p>
                                ) : d.reported ? (
                                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-warning)]">
                                      결석 신고됨
                                    </span>
                                    {d.reasonLabel && <span className="text-xs text-[var(--color-academy-muted)]">{d.reasonLabel}</span>}
                                    {/* 질병·부상이면 이월 검토 상태 한 단어(사진 추가는 위 «질병·부상 결석» 칸에서) */}
                                    {reviewLabel && <span className="text-xs text-[var(--color-academy-info)]">{reviewLabel}</span>}
                                    {/* 보강권 상태(짧게) — 사용 가능(AVAILABLE)은 아래 «보강 예약하기» 버튼으로 보인다 */}
                                    {d.makeupCredit && CREDIT_NOTE[d.makeupCredit] && (
                                      <span className="text-xs text-[var(--color-academy-info)]">{CREDIT_NOTE[d.makeupCredit]}</span>
                                    )}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)]">{d.dateLabel}</span>

                              {/* 동작 버튼은 한 묶음으로 다음 줄에 — 좁은 화면(360px)에서 반 이름 칸이 눌리지 않게(2026-11-14 검수) */}
                              <div className="flex basis-full flex-wrap items-center justify-end gap-2">
                              {/* 보강권이 있으면 보강 예약 화면으로(그 아이 보강권이 맨 위에 오게 studentId 를 붙인다).
                                  마감·확정과 상관없이 보인다 — 보강권은 결석 신고를 못 바꿔도 쓸 수 있다 */}
                              {d.reported && d.makeupCredit === "AVAILABLE" && (
                                <Link
                                  href={`/mypage/makeup?studentId=${encodeURIComponent(d.studentId)}`}
                                  className="academy-button-tonal shrink-0"
                                >
                                  보강 예약하기
                                </Link>
                              )}

                              {/* 액션 — 신고 취소 · 사유 변경 / 결석 알리기 폼 열기. 여기서 못 바꾸는 줄은 한 단어 + 전화·문의 버튼 */}
                              {d.locked ? (
                                // 학원이 확정한 결석 — 여기서 바꿀 수 없다(서버도 막는다). 바로 전화·문의로 잇는다
                                <ContactActions label="학원 확정" contact={contact} />
                              ) : !changeOpen(d) ? (
                                // 마감 뒤(수업 1시간 전 지남) — 버튼 대신 «마감» + 전화·문의(서버도 같은 규칙으로 막는다)
                                <ContactActions label="마감" contact={contact} />
                              ) : d.reported && creditBlocksCancel(d) ? (
                                // 이미 그 결석의 보강을 들었다 — 신고 취소 불가(서버도 막는다)
                                <ContactActions label="보강을 이미 들어 취소할 수 없어요" contact={contact} />
                              ) : d.reported ? (
                                <>
                                  {/* 사유 변경 = 아래 사유 칸을 지금 사유로 채워 연다(글자 버튼 — 꽉 찬 색은 폼 안 최종 버튼만) */}
                                  {openKey !== key && (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => {
                                        setReason((prev) => ({ ...prev, [key]: d.reason || "" }));
                                        setOpenKey(key);
                                      }}
                                      className="academy-button-text shrink-0"
                                    >
                                      사유 변경
                                    </button>
                                  )}
                                  {/* 신고 취소 = 그 자리 확인(C-M1) 후 기존 cancel(d) 그대로 */}
                                  <InlineConfirm
                                    label="신고 취소"
                                    question={d.makeupCredit === "RESERVED" ? "보강 예약도 함께 취소돼요. 이 결석 신고를 취소할까요?" : "이 결석 신고를 취소할까요?"}
                                    confirmLabel="신고 취소하기"
                                    onConfirm={() => cancel(d)}
                                    pending={busy}
                                    openClassName="basis-full"
                                  />
                                </>
                              ) : openKey === key ? null : (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey(key)}
                                  // 행의 «여는» 버튼 = 옅은 바탕(tonal). 꽉 찬 색은 폼 안 «알리기»만(M-08)
                                  className="academy-button-tonal shrink-0"
                                >
                                  결석 알리기
                                </button>
                              )}
                              </div>
                            </div>

                            {/* 사유 칸 — 새 신고: 사유 고르고 «알리기» / 신고된 줄: 다른 사유를 골라 «사유 바꾸기»(같은 report 길) */}
                            {openKey === key && !d.locked && changeOpen(d) && !(d.reported && creditBlocksCancel(d)) && (
                              <div className="mb-1.5 mt-1 flex flex-wrap items-center gap-2">
                                <select
                                  value={reason[key] || ""}
                                  onChange={(e) => setReason((prev) => ({ ...prev, [key]: e.target.value }))}
                                  className="academy-input min-w-32 flex-1"
                                  aria-label="결석 사유"
                                >
                                  <option value="">사유 선택</option>
                                  {REASONS.map((r) => (
                                    <option key={r.value} value={r.value}>
                                      {r.label}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  // 사유 변경인데 같은 사유면 보낼 것이 없다
                                  disabled={busy || (d.reported && (reason[key] || "") === (d.reason || ""))}
                                  onClick={() => report(d)}
                                  className="academy-button-primary"
                                >
                                  {busy ? "보내는 중…" : d.reported ? "사유 바꾸기" : "알리기"}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setOpenKey("")}
                                  className="academy-button-text"
                                >
                                  닫기
                                </button>

                                {/* 질병·부상(2026-11-14 원장 결정 a1): 사유 글(필수) + 증빙 사진 1~3장(지금 또는 7일 안) */}
                                {illnessChosen && (
                                  <div className="basis-full space-y-2">
                                    <label className="block text-sm font-medium text-[var(--color-academy-ink)]">
                                      어디가 아픈가요?
                                      <input
                                        type="text"
                                        value={reasonText[key] || ""}
                                        onChange={(e) => setReasonText((prev) => ({ ...prev, [key]: e.target.value }))}
                                        maxLength={REASON_TEXT_MAX}
                                        placeholder="예: 독감, 발목 염좌"
                                        className="academy-input mt-1 w-full"
                                      />
                                    </label>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <label className={`academy-button-secondary shrink-0 ${busy ? "pointer-events-none opacity-60" : "cursor-pointer"}`}>
                                        증빙 사진 고르기
                                        <input
                                          type="file"
                                          accept={EVIDENCE_ACCEPT}
                                          multiple
                                          disabled={busy}
                                          className="sr-only"
                                          onChange={(e) => {
                                            const files = Array.from(e.target.files || []).slice(0, EVIDENCE_MAX_PHOTOS);
                                            e.target.value = "";
                                            setPhotos((prev) => ({ ...prev, [key]: files }));
                                          }}
                                        />
                                      </label>
                                      <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">
                                        {chosenPhotos.length > 0 ? `${chosenPhotos.length}장 골랐어요` : `진단서·진료확인서·처방전·약 봉투 (1~${EVIDENCE_MAX_PHOTOS}장)`}
                                      </span>
                                    </div>
                                    <p className="break-keep text-xs text-[var(--color-academy-muted)]">
                                      사진은 지금 올리거나 7일 안에 추가할 수 있어요. 확인한 뒤 다음 달 수강료에서 1회분을 빼 드려요. 사진이 없으면 보강권 1장으로 바뀌어요.
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
