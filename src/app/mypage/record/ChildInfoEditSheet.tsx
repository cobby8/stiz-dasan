"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import InlineConfirm from "@/components/parent/InlineConfirm";
import { customerMessage } from "@/components/parent/customerMessage";
import { cancelChildChange, requestChildChange, saveChildInfo } from "@/app/actions/child-edit";
import type { ChildEditInfo } from "@/lib/parent/childEdit";
import { HEALTH_NOTE_MAX, REQUEST_FIELD_LABEL, changeLine, type RequestField } from "@/lib/parent/childEditRules";
import { formatPhoneInput } from "@/lib/application-display-format";

// 학부모 «아이 정보 수정» 시트 (2026-11-14 원장 결정 b4·b5)
// - 휴대폰: 아래에서 올라오는 시트 · PC: 오른쪽 패널(ListDetailPanel — Esc·바깥 누르기·포커스 가두기)
// - 위 칸 = 바로 반영(학교·학생 전화·주소·건강 특이사항) → «저장»
// - 아래 칸 = 변경 신청(이름·생년월일) → 학원이 확인한 뒤 바뀐다. 확인 중이면 그 자리에서 취소
// - 학년은 생년월일로 계산한 값을 보여 주기만 한다(직접 입력 없음)

const LABEL = "grid gap-1 text-sm font-medium text-[var(--color-academy-ink)]";

export default function ChildInfoEditSheet({
  studentId,
  name,
  birthYmd,
  school,
  gradeText,
  edit,
  onClose,
}: {
  studentId: string;
  name: string;
  /** 진짜 생일만(임시 생일이면 null) */
  birthYmd: string | null;
  school: string | null;
  /** 생년월일로 계산한 학년 한 줄 */
  gradeText: string;
  edit: ChildEditInfo;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    school: school ?? "",
    phone: edit.phone ? formatPhoneInput(edit.phone) : "",
    address: edit.address ?? "",
    healthNote: edit.healthNote ?? "",
  });
  const [nextName, setNextName] = useState("");
  const [nextBirth, setNextBirth] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 처음 값(저장하면 그때 값으로) — 고친 뒤 저장하지 않고 닫으려 하면 한 번 묻는다
  const [saved, setSaved] = useState(form);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || nextName.trim() !== "" || nextBirth !== "";
  // 닫기 버튼·Esc 공통 — 바깥을 눌러서는 닫히지 않는다(긴 글을 쓰다 실수로 사라지지 않게)
  function requestClose() {
    if (dirty && !confirmClose) { setConfirmClose(true); return; }
    onClose();
  }

  const pendingOf = (field: RequestField) => edit.requests.find((r) => r.field === field && r.status === "PENDING") ?? null;

  function run(work: () => Promise<{ ok: true; notice?: string } | { ok: false; error: string }>, done: string, after?: () => void) {
    setError(""); setNotice("");
    startTransition(async () => {
      const result = await work().catch(() => ({ ok: false as const, error: "처리하지 못했어요. 잠시 후 다시 시도해 주세요." }));
      // 서버가 준 안내만 보이고, 고객용 문장이 아니면 준비한 문장으로 바꾼다
      if (!result.ok) { setError(customerMessage(result.error, "처리하지 못했어요. 잠시 후 다시 시도해 주세요.")); return; }
      setNotice(result.notice ?? done);
      after?.();
      router.refresh(); // 아이 정보 칸·확인 중 줄을 새 값으로
    });
  }

  const healthLength = [...form.healthNote].length;

  return (
    <ListDetailPanel onClose={requestClose} titleId="child-info-edit-title" closeOnBackdrop={false}>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-2">
        <h2 id="child-info-edit-title" className="min-w-0 flex-1 text-base font-bold text-[var(--color-academy-ink)]">{name} 정보 수정</h2>
        <button type="button" onClick={requestClose} className="academy-button-text shrink-0">닫기</button>
      </div>
      {confirmClose && (
        <div role="alertdialog" aria-label="저장하지 않고 닫기" className="flex flex-wrap items-center gap-2 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-warning-soft)] px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">저장하지 않은 내용이 있어요.</span>
          <button type="button" onClick={() => setConfirmClose(false)} className="academy-button-secondary">계속 쓰기</button>
          <button type="button" onClick={onClose} className="academy-button-danger">저장 안 하고 닫기</button>
        </div>
      )}

      <div className="grid gap-4 px-4 py-3">
        {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>}
        {notice && <p role="status" className="rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-sm text-[var(--color-academy-success)]">{notice}</p>}

        {/* 바로 반영 */}
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            // 건강 칸이 없는 환경이면 그 칸은 보내지 않는다(서버가 묻지도 않는다)
            const sent = edit.healthAvailable ? form : { school: form.school, phone: form.phone, address: form.address };
            run(() => saveChildInfo(studentId, sent), "저장했어요.", () => { setSaved(form); setConfirmClose(false); });
          }}
        >
          <label className={LABEL}>
            학교
            <input value={form.school} maxLength={40} autoComplete="off" onChange={(e) => setForm({ ...form, school: e.target.value })} className="academy-input" />
          </label>
          <label className={LABEL}>
            학생 전화
            <input value={form.phone} type="tel" inputMode="tel" maxLength={13} autoComplete="off" readOnly={!edit.canEditPhone} aria-describedby={edit.canEditPhone ? undefined : "child-phone-note"} placeholder={edit.canEditPhone ? "없으면 비워 두세요" : undefined} onChange={(e) => setForm({ ...form, phone: formatPhoneInput(e.target.value) })} className="academy-input read-only:bg-[var(--color-academy-soft)] read-only:text-[var(--color-academy-muted)]" />
            {/* 학생 전화는 대표 보호자만 — 연결 가족에게는 읽기 전용 */}
            {!edit.canEditPhone && <span id="child-phone-note" className="text-xs font-normal text-[var(--color-academy-muted)]">대표 보호자만 바꿀 수 있어요</span>}
          </label>
          <label className={LABEL}>
            주소
            <input value={form.address} maxLength={200} autoComplete="off" onChange={(e) => setForm({ ...form, address: e.target.value })} className="academy-input" />
          </label>
          {edit.healthAvailable && (
            <label className={LABEL}>
              건강·알레르기·특이사항
              <textarea
                value={form.healthNote}
                rows={3}
                maxLength={HEALTH_NOTE_MAX}
                placeholder="천식, 견과류 알레르기, 안경 착용"
                onChange={(e) => setForm({ ...form, healthNote: e.target.value })}
                className="academy-input resize-none"
              />
              <span className="flex justify-between gap-2 text-xs font-normal text-[var(--color-academy-muted)]">
                <span>담당 선생님과 셔틀 기사님이 봐요</span>
                <span className="tabular-nums">{healthLength}/{HEALTH_NOTE_MAX}</span>
              </span>
            </label>
          )}
          <button type="submit" disabled={pending} className="academy-button-primary justify-self-start">{pending ? "저장 중…" : "저장"}</button>
        </form>

        {/* 변경 신청 — 이름·생년월일 */}
        {edit.requestsAvailable && (
          <section aria-labelledby="child-change-title" className="grid gap-3 border-t border-[var(--color-academy-line)] pt-3">
            <div>
              <h3 id="child-change-title" className="text-sm font-semibold text-[var(--color-academy-ink)]">이름·생년월일</h3>
              <p className="text-xs text-[var(--color-academy-muted)]">학원이 확인한 뒤 바뀌어요</p>
            </div>
            {(["name", "birthDate"] as RequestField[]).map((field) => {
              const waiting = pendingOf(field);
              const isName = field === "name";
              const value = isName ? nextName : nextBirth;
              return (
                <div key={field} className="grid gap-1">
                  <span className="text-sm font-medium text-[var(--color-academy-ink)]">
                    {REQUEST_FIELD_LABEL[field]}
                    <span className="ml-2 font-normal tabular-nums text-[var(--color-academy-muted)]">지금 {isName ? name : birthYmd ? birthYmd.replaceAll("-", ".") : "미등록"}</span>
                  </span>
                  {waiting ? (
                    // 확인 중 — 한 줄 + 그 자리 취소
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 break-keep text-[var(--color-academy-ink)]">확인 중 · {changeLine(waiting)}</span>
                      <InlineConfirm
                        label="신청 취소"
                        question="이 변경 신청을 취소할까요?"
                        confirmLabel="취소하기"
                        pending={pending}
                        openClassName="basis-full"
                        onConfirm={() => run(() => cancelChildChange(waiting.id), "신청을 취소했어요.")}
                      />
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        aria-label={`새 ${REQUEST_FIELD_LABEL[field]}`}
                        type={isName ? "text" : "date"}
                        value={value}
                        maxLength={isName ? 30 : undefined}
                        autoComplete="off"
                        placeholder={isName ? "새 이름" : undefined}
                        onChange={(e) => (isName ? setNextName(e.target.value) : setNextBirth(e.target.value))}
                        className="academy-input min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        disabled={pending || !value.trim()}
                        onClick={() => run(() => requestChildChange(studentId, field, value), "변경을 신청했어요.", () => (isName ? setNextName("") : setNextBirth("")))}
                        className="academy-button-secondary shrink-0"
                      >
                        변경 신청
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="text-xs text-[var(--color-academy-muted)]">학년 {gradeText} · 생년월일로 계산해요</p>
          </section>
        )}
      </div>
    </ListDetailPanel>
  );
}
