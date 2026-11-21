"use client";

// 유니폼 신청 학생 한 명분 수정 칸(2026-11-21 원장 «주문 내용을 수정하는 기능»).
// 디자인·사이즈 목록은 신청 화면과 같은 공용 목록(uniform-options). 예전 신청에 목록 밖 값이 있으면 그 값도 고를 수 있게 앞에 붙인다.
// 저장은 서버(updateUniformOrderItemAction)가 다시 검사하고, 본사에 이미 접수된 신청이면 거절한다.
import { useState } from "react";
import { updateUniformOrderItemAction } from "@/app/actions/uniform";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import { DESIGN_OPTIONS, SIZE_OPTIONS } from "@/lib/uniform-options";

export type UniformEditableItem = {
  id: string;
  studentName: string;
  design: string | null;
  initials: string | null;
  backNumber: string | null;
  topSize: string | null;
  bottomSize: string | null;
};

/** 목록 + (목록 밖이면) 원래 값 — 옛 값을 고르지 못해 다른 칸 수정이 막히지 않게 */
export function optionsWithCurrent(options: readonly string[], current: string | null): string[] {
  const value = String(current ?? "").trim();
  return value && !options.includes(value) ? [value, ...options] : [...options];
}

const INPUT = "mt-1 min-h-10 w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-sm text-[var(--color-academy-ink)]";

export default function UniformItemEditForm({
  item,
  onDone,
  onCancel,
}: {
  item: UniformEditableItem;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    studentName: item.studentName ?? "",
    design: item.design ?? "",
    initials: item.initials ?? "",
    backNumber: item.backNumber ?? "",
    topSize: item.topSize ?? "",
    bottomSize: item.bottomSize ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await updateUniformOrderItemAction(item.id, form);
      onDone(result.changed.length > 0 ? `${result.item.studentName} 신청을 고쳤어요(${result.changed.join(", ")}).` : "바뀐 내용이 없어요.");
    } catch (caught) {
      setError(adminErrorText(caught, "저장하지 못했습니다."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="col-span-2 mt-2 grid grid-cols-2 gap-2 rounded-lg bg-[var(--color-academy-soft)] p-3">
      <label className="text-xs text-[var(--color-academy-muted)]">학생 이름
        <input className={INPUT} value={form.studentName} onChange={set("studentName")} maxLength={30} />
      </label>
      <label className="text-xs text-[var(--color-academy-muted)]">디자인
        <select className={INPUT} value={form.design} onChange={set("design")}>
          {optionsWithCurrent(DESIGN_OPTIONS, item.design).map((option) => <option key={option || "none"} value={option}>{option || "선택 안 함"}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--color-academy-muted)]">이니셜
        <input className={INPUT} value={form.initials} onChange={set("initials")} maxLength={20} />
      </label>
      <label className="text-xs text-[var(--color-academy-muted)]">등번호
        <input className={INPUT} value={form.backNumber} onChange={set("backNumber")} inputMode="numeric" maxLength={3} />
      </label>
      <label className="text-xs text-[var(--color-academy-muted)]">상의 사이즈
        <select className={INPUT} value={form.topSize} onChange={set("topSize")}>
          {optionsWithCurrent(SIZE_OPTIONS, item.topSize).map((option) => <option key={option || "none"} value={option}>{option || "없음"}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--color-academy-muted)]">하의 사이즈
        <select className={INPUT} value={form.bottomSize} onChange={set("bottomSize")}>
          {optionsWithCurrent(SIZE_OPTIONS, item.bottomSize).map((option) => <option key={option || "none"} value={option}>{option || "없음"}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="col-span-2 text-xs font-medium text-[var(--color-academy-danger)]">{error}</p>}
      <div className="col-span-2 flex gap-2">
        <button type="button" className="academy-button-primary academy-button-sm" disabled={saving} onClick={save}>
          {saving ? "저장 중…" : "저장"}
        </button>
        <button type="button" className="academy-button-text academy-button-sm" disabled={saving} onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}
