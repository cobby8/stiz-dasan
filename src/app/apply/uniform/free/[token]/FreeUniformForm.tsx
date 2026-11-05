"use client";

// 3년 이상 재원생 유니폼 무료 신청 폼
// - 아이 이름은 링크의 학생으로 고정(수정 불가), 학부모 정보는 미리 채우되 고칠 수 있다
// - 디자인·사이즈 목록과 검증은 기존 추가주문 폼과 같은 공용 모듈(uniform-options) 사용
// - 입력칸 글씨는 text-base(16px 이상) — 아이폰이 16px 미만 입력칸을 누르면 화면을 확대해 버린다
import { useState, useTransition } from "react";
import { submitFreeUniformOrder } from "@/app/actions/uniform-free";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import {
  DESIGN_OPTIONS,
  SIZE_OPTIONS,
  formatUniformPhone,
  validateUniformItemFields,
  validateUniformParentFields,
} from "@/lib/uniform-options";

type Props = {
  token: string;
  studentName: string;
  initialParentName: string;
  parentPhoneMask: string;
  contactPhone: string;
};

const INPUT_CLASS =
  "mt-1.5 min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white";

export default function FreeUniformForm({ token, studentName, initialParentName, parentPhoneMask, contactPhone }: Props) {
  const [form, setForm] = useState({
    parentName: initialParentName,
    parentPhone: "", // 비워 두면 서버가 저장된 번호(가려서 안내)를 쓴다
    design: "",
    initials: "",
    backNumber: "",
    topSize: "",
    bottomSize: "",
    memo: "",
    agreedPrivacy: false,
  });
  const [error, setError] = useState("");
  // 완료 화면: 성공 또는 «이미 신청됨/만료» 처럼 다시 입력할 필요가 없는 결과
  const [done, setDone] = useState<{ title: string; body: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function update<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError("");
  }

  function handleSubmit() {
    // 화면에서 먼저 검사(서버도 같은 규칙으로 다시 검사한다)
    const message =
      validateUniformParentFields(form.parentName, !form.parentPhone && parentPhoneMask ? "01000000000" : form.parentPhone) ||
      validateUniformItemFields(form) ||
      (form.agreedPrivacy ? "" : "개인정보 수집 및 이용에 동의해주세요.");
    if (message) {
      setError(message);
      return;
    }
    startTransition(async () => {
      try {
        const result = await submitFreeUniformOrder(token, form);
        if (result.ok) {
          setDone({
            title: "유니폼 무료 신청이 접수되었습니다",
            body: "학원에서 내용을 확인한 뒤 제작을 요청드립니다. 준비되면 안내드릴게요.",
          });
        } else if (result.reason === "INVALID") {
          setError(result.message);
        } else {
          setDone({ title: result.message, body: "궁금한 점은 학원으로 연락해 주세요." });
        }
      } catch {
        setError("신청 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
    });
  }

  if (done) {
    return (
      <div className="public-card rounded-2xl bg-white p-6 text-center shadow-lg dark:bg-gray-800">
        <FontFreeIcon name="check_circle" size={36} className="mx-auto text-green-600 dark:text-brand-neon-lime" />
        <h1 className="mt-3 break-keep text-lg font-black text-gray-900 dark:text-white">{done.title}</h1>
        <p className="mt-2 break-keep text-sm text-gray-600 dark:text-gray-300">{done.body}</p>
        {contactPhone && <p className="mt-3 text-sm font-bold text-gray-700 dark:text-gray-200">학원 {contactPhone}</p>}
      </div>
    );
  }

  return (
    <div className="public-form-card public-card overflow-hidden rounded-2xl bg-white shadow-lg dark:bg-gray-800">
      {/* 머리: 아이 이름 + 감사 한 줄(컴팩트) */}
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <h1 className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
          <FontFreeIcon name="checkroom" size={22} className="text-brand-orange-500 dark:text-brand-neon-lime" />
          {studentName} 유니폼 무료 신청
        </h1>
        <p className="mt-1 break-keep text-sm text-gray-600 dark:text-gray-300">
          3년 이상 함께해 준 감사의 마음으로 유니폼을 무료로 드립니다.
        </p>
      </div>

      <div className="space-y-4 p-4">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-bold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <FontFreeIcon name="error" size={18} />
            {error}
          </div>
        )}

        <section className="grid grid-cols-2 gap-3">
          <label className="col-span-2 block text-sm font-bold text-gray-700 dark:text-gray-200">
            아이 이름
            {/* 링크의 학생으로 고정 — 다른 아이 이름으로 바꿔 신청하지 못하게 읽기 전용 */}
            <input value={studentName} readOnly aria-readonly="true" className={`${INPUT_CLASS} bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300`} />
          </label>
          <label className="col-span-2 block text-sm font-bold text-gray-700 dark:text-gray-200 sm:col-span-1">
            디자인 <span className="text-red-500">*</span>
            <select value={form.design} onChange={(e) => update("design", e.target.value)} className={INPUT_CLASS}>
              {DESIGN_OPTIONS.map((option) => (
                <option key={option || "none"} value={option}>{option || "디자인 선택"}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            이니셜 <span className="text-red-500">*</span>
            <input value={form.initials} onChange={(e) => update("initials", e.target.value.slice(0, 20))} placeholder="예: GENO" className={INPUT_CLASS} />
          </label>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            등번호
            <input
              value={form.backNumber}
              inputMode="numeric"
              onChange={(e) => update("backNumber", e.target.value.replace(/\D/g, "").slice(0, 3))}
              placeholder="선택"
              className={INPUT_CLASS}
            />
          </label>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            상의 사이즈
            <select value={form.topSize} onChange={(e) => update("topSize", e.target.value)} className={INPUT_CLASS}>
              {SIZE_OPTIONS.map((size) => <option key={size || "none"} value={size}>{size || "선택 안 함"}</option>)}
            </select>
          </label>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            하의 사이즈
            <select value={form.bottomSize} onChange={(e) => update("bottomSize", e.target.value)} className={INPUT_CLASS}>
              {SIZE_OPTIONS.map((size) => <option key={size || "none"} value={size}>{size || "선택 안 함"}</option>)}
            </select>
          </label>
        </section>

        <section className="grid grid-cols-2 gap-3 border-t border-gray-100 pt-4 dark:border-gray-700">
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            학부모 이름 <span className="text-red-500">*</span>
            <input value={form.parentName} onChange={(e) => update("parentName", e.target.value)} autoComplete="name" className={INPUT_CLASS} />
          </label>
          <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
            휴대폰 <span className="text-red-500">*</span>
            <input
              type="tel"
              value={form.parentPhone}
              onChange={(e) => update("parentPhone", formatUniformPhone(e.target.value))}
              placeholder={parentPhoneMask || "010-0000-0000"}
              autoComplete="tel"
              className={INPUT_CLASS}
            />
            {parentPhoneMask && <span className="mt-1 block text-xs font-normal text-gray-500 dark:text-gray-400">비워 두면 등록된 번호({parentPhoneMask})로 받습니다</span>}
          </label>
          <label className="col-span-2 block text-sm font-bold text-gray-700 dark:text-gray-200">
            요청사항
            <input value={form.memo} onChange={(e) => update("memo", e.target.value.slice(0, 300))} placeholder="선택" className={INPUT_CLASS} />
          </label>
        </section>

        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
          <input
            type="checkbox"
            checked={form.agreedPrivacy}
            onChange={(e) => update("agreedPrivacy", e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500"
          />
          <span className="break-keep">유니폼 제작을 위해 학부모 연락처와 아이의 주문 정보를 STIZ 본사에 전달하는 데 동의합니다.</span>
        </label>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-orange-500 px-6 text-base font-black text-white transition hover:bg-brand-orange-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900"
        >
          <FontFreeIcon name={isPending ? "progress_activity" : "send"} size={20} className={isPending ? "animate-spin" : ""} />
          {isPending ? "접수 중..." : "무료 유니폼 신청하기"}
        </button>
      </div>
    </div>
  );
}
