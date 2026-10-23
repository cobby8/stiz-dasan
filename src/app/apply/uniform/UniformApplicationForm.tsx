"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { submitUniformOrder } from "@/app/actions/uniform";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

type StudentForm = {
  studentName: string;
  design: string;
  initials: string;
  backNumber: string;
  topSize: string;
  bottomSize: string;
};

type FormData = {
  parentName: string;
  parentPhone: string;
  memo: string;
  agreedPrivacy: boolean;
  honeypot: string;
  students: StudentForm[];
};

const DESIGN_OPTIONS = ["", "DYG 블랙&화이트", "카툰 블랙&화이트"];
const SIZE_OPTIONS = ["", "5XS(110)", "4XS(120)", "3XS(130)", "2XS(140)", "XS(150)", "S(160)", "M", "L", "XL", "2XL", "3XL", "4XL"];
const EMPTY_STUDENT: StudentForm = {
  studentName: "",
  design: "",
  initials: "",
  backNumber: "",
  topSize: "",
  bottomSize: "",
};
const INITIAL_FORM: FormData = {
  parentName: "",
  parentPhone: "",
  memo: "",
  agreedPrivacy: false,
  honeypot: "",
  students: [{ ...EMPTY_STUDENT }],
};

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function hasOrderSize(student: StudentForm) {
  return Boolean(student.topSize || student.bottomSize);
}

export default function UniformApplicationForm() {
  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    mode: "created" | "existing";
    syncStatus: string;
    orderNumber: string | null;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const studentCount = useMemo(
    () => form.students.filter((student) => student.studentName.trim() && hasOrderSize(student)).length,
    [form.students],
  );

  function update(field: keyof Omit<FormData, "students">, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError("");
  }

  function updateStudent(index: number, field: keyof StudentForm, value: string) {
    setForm((prev) => ({
      ...prev,
      students: prev.students.map((student, currentIndex) => (
        currentIndex === index ? { ...student, [field]: value } : student
      )),
    }));
    setError("");
  }

  function addStudent() {
    if (form.students.length >= 6) {
      setNotice("한 번에 최대 6명까지 신청할 수 있습니다.");
      return;
    }
    setForm((prev) => ({ ...prev, students: [...prev.students, { ...EMPTY_STUDENT }] }));
    setNotice("");
  }

  function removeStudent(index: number) {
    setForm((prev) => ({
      ...prev,
      students: prev.students.length === 1
        ? [{ ...EMPTY_STUDENT }]
        : prev.students.filter((_, currentIndex) => currentIndex !== index),
    }));
  }

  function validate() {
    if (!form.parentName.trim()) return "학부모 이름을 입력해주세요.";
    const phoneDigits = form.parentPhone.replace(/\D/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 11) return "학부모 휴대폰 번호를 정확히 입력해주세요.";
    const activeStudents = form.students.filter((student) =>
      student.studentName.trim() || student.design.trim() || student.initials.trim() || hasOrderSize(student) || student.backNumber.trim(),
    );
    if (activeStudents.length === 0) return "학생 정보를 1명 이상 입력해주세요.";
    const missingName = activeStudents.find((student) => !student.studentName.trim());
    if (missingName) return "학생 이름을 입력해주세요.";
    const missingDesign = activeStudents.find((student) => !student.design.trim());
    if (missingDesign) return "유니폼 디자인을 선택해주세요.";
    const missingInitials = activeStudents.find((student) => !student.initials.trim());
    if (missingInitials) return "유니폼 이니셜을 입력해주세요.";
    const missingSize = activeStudents.find((student) => !hasOrderSize(student));
    if (missingSize) return "학생마다 상의 또는 하의 사이즈 중 하나 이상을 선택해주세요.";
    if (!form.agreedPrivacy) return "개인정보 수집 및 이용에 동의해주세요.";
    return "";
  }

  function handleSubmit() {
    const validationMessage = validate();
    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    startTransition(async () => {
      try {
        const response = await submitUniformOrder({
          parentName: form.parentName,
          parentPhone: form.parentPhone,
          memo: form.memo,
          agreedPrivacy: form.agreedPrivacy,
          honeypot: form.honeypot,
          students: form.students
            .filter((student) => student.studentName.trim())
            .map((student) => ({
              studentName: student.studentName,
              design: student.design,
              initials: student.initials,
              backNumber: student.backNumber,
              topSize: student.topSize,
              bottomSize: student.bottomSize,
            })),
        });
        setResult({
          mode: response.mode,
          syncStatus: response.syncStatus,
          orderNumber: response.orderNumber,
        });
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : "신청 중 문제가 발생했습니다.");
      }
    });
  }

  if (result) {
    const acceptedByStiz = result.syncStatus === "SENT" || result.syncStatus === "DUPLICATE";
    return (
      <div className="rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-gray-800">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100 dark:bg-brand-neon-lime/15">
          <FontFreeIcon name="check_circle" size={40} className="text-green-600 dark:text-brand-neon-lime" />
        </div>
        <h2 className="mb-3 text-2xl font-black text-gray-900 dark:text-white">
          {result.mode === "existing" ? "이미 접수된 유니폼 신청이 있습니다" : "유니폼 신청 완료!"}
        </h2>
        <p className="mx-auto max-w-xl text-gray-600 dark:text-gray-300">
          {acceptedByStiz
            ? "본사 주문 시스템에 접수되었습니다. 학부모 휴대폰으로 접수 안내가 발송됩니다."
            : "신청서는 정상 접수되었습니다. 담당자가 본사 접수 상태를 확인한 뒤 안내드리겠습니다."}
        </p>
        {result.orderNumber && (
          <div className="mx-auto mt-5 max-w-sm rounded-2xl border border-gray-200 bg-gray-50 p-4 text-left dark:border-gray-700 dark:bg-gray-900">
            <p className="text-xs font-bold text-gray-500 dark:text-gray-400">본사 접수번호</p>
            <p className="mt-1 text-lg font-black text-gray-950 dark:text-white">{result.orderNumber}</p>
          </div>
        )}
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <Link href="/apply" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-gray-200 bg-white px-5 text-sm font-bold text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
            신청 페이지로 돌아가기
          </Link>
          <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-navy-900 px-5 text-sm font-bold text-white hover:bg-brand-navy-800 dark:bg-brand-neon-lime dark:text-brand-navy-900">
            홈으로 돌아가기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="public-form-card public-card min-w-0 overflow-hidden rounded-2xl bg-white shadow-lg dark:bg-gray-800">
      <div className="public-stepper border-b border-gray-100 bg-gray-50 px-4 sm:px-6 py-4 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="flex items-center gap-2 text-xl font-black text-gray-900 dark:text-white">
          <FontFreeIcon name="checkroom" size={22} className="text-brand-orange-500 dark:text-brand-neon-lime" />
          유니폼 추가주문 정보
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          금액은 접수 후 STIZ 본사 기준으로 안내됩니다. 결제는 이 화면에서 진행하지 않습니다.
        </p>
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <FontFreeIcon name="error" size={18} />
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100">
            {notice}
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2">
          <Field
            label="학부모 이름"
            required
            value={form.parentName}
            onChange={(value) => update("parentName", value)}
            placeholder="학부모 이름"
          />
          <Field
            label="학부모 휴대폰 번호"
            required
            type="tel"
            value={form.parentPhone}
            onChange={(value) => update("parentPhone", formatPhone(value))}
            placeholder="010-0000-0000"
          />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-gray-900 dark:text-white">학생 목록</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">형제·자매는 한 신청서에 함께 입력해주세요.</p>
            </div>
            <button
              type="button"
              onClick={addStudent}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-brand-orange-200 bg-white px-3 text-sm font-bold text-brand-orange-600 hover:bg-orange-50 dark:border-brand-neon-lime/40 dark:bg-gray-950 dark:text-brand-neon-lime"
            >
              <FontFreeIcon name="add" size={18} />
              학생 추가
            </button>
          </div>

          {form.students.map((student, index) => (
            <div key={index} className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-black text-gray-900 dark:text-white">학생 {index + 1}</p>
                <button
                  type="button"
                  onClick={() => removeStudent(index)}
                  className="rounded-lg px-2 py-1 text-xs font-bold text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  삭제
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="학생 이름"
                  required
                  value={student.studentName}
                  onChange={(value) => updateStudent(index, "studentName", value)}
                  placeholder="학생 이름"
                />
                <Field
                  label="이니셜"
                  required
                  value={student.initials}
                  onChange={(value) => updateStudent(index, "initials", value)}
                  placeholder="예: GENO"
                />
                <Field
                  label="등번호"
                  value={student.backNumber}
                  onChange={(value) => updateStudent(index, "backNumber", value.replace(/\D/g, "").slice(0, 3))}
                  placeholder="선택"
                />
                <SelectField
                  label="디자인"
                  required
                  value={student.design}
                  options={DESIGN_OPTIONS}
                  emptyLabel="디자인 선택"
                  onChange={(value) => updateStudent(index, "design", value)}
                />
                <SelectField
                  label="상의 사이즈"
                  value={student.topSize}
                  options={SIZE_OPTIONS}
                  onChange={(value) => updateStudent(index, "topSize", value)}
                />
                <SelectField
                  label="하의 사이즈"
                  value={student.bottomSize}
                  options={SIZE_OPTIONS}
                  onChange={(value) => updateStudent(index, "bottomSize", value)}
                />
              </div>
            </div>
          ))}
        </section>

        <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
          요청사항 메모
          <textarea
            value={form.memo}
            onChange={(event) => update("memo", event.target.value)}
            rows={4}
            className="mt-2 w-full resize-none rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            placeholder="예: 사이즈 상담이 필요해요"
          />
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
          <input
            type="checkbox"
            checked={form.agreedPrivacy}
            onChange={(event) => update("agreedPrivacy", event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime"
          />
          <span>
            유니폼 주문 접수를 위해 학부모 연락처와 학생 주문 정보를 STIZ 본사에 전달하는 데 동의합니다.
          </span>
        </label>
        <input
          type="text"
          value={form.honeypot}
          onChange={(event) => update("honeypot", event.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-5 dark:border-gray-700">
          <p className="text-sm font-bold text-gray-500 dark:text-gray-400">
            접수 대상 {studentCount}명
          </p>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-brand-orange-500 px-6 text-base font-black text-white transition hover:bg-brand-orange-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400"
          >
            <FontFreeIcon name={isPending ? "progress_activity" : "send"} size={20} className={isPending ? "animate-spin" : ""} />
            {isPending ? "접수 중..." : "유니폼 신청하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  type = "text",
  value,
  onChange,
  placeholder,
}: {
  label: string;
  required?: boolean;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
      {label} {required && <span className="text-red-500">*</span>}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      />
    </label>
  );
}

function SelectField({
  label,
  required,
  value,
  options,
  emptyLabel = "선택 안 함",
  onChange,
}: {
  label: string;
  required?: boolean;
  value: string;
  options: string[];
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
      {label} {required && <span className="text-red-500">*</span>}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      >
        {options.map((size) => (
          <option key={size || "none"} value={size}>
            {size || emptyLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
