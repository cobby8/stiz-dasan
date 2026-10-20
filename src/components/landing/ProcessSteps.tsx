import Link from "next/link";

export default function ProcessSteps() {
  return <section className="public-section bg-[var(--color-public-soft)]"><div className="public-container">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-extrabold text-[var(--color-public-text)]">처음 시작하는 농구 수업</h2><Link href="/faq" className="public-link inline-flex min-h-11 items-center">자주 묻는 질문</Link></div>
    <ol className="grid gap-3 md:grid-cols-3">{[
      { title: "체험 신청", description: "아이의 정보와 희망 수업을 알려주세요." },
      { title: "일정 확인", description: "학원과 체험 날짜와 수업을 확인해요." },
      { title: "체험 후 등록", description: "수업을 경험한 뒤 맞는 반을 선택해요." },
    ].map((step, index) => <li key={step.title} className="flex items-start gap-3 rounded-xl bg-[var(--color-public-surface)] p-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-public-soft)] text-sm font-bold text-[var(--color-public-accent)]">{index + 1}</span><div><h3 className="font-bold text-[var(--color-public-text)]">{step.title}</h3><p className="mt-1 text-sm leading-relaxed text-[var(--color-public-muted)]">{step.description}</p></div></li>)}</ol>
  </div></section>;
}
