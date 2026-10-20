"use client";

import { useState } from "react";
import Link from "next/link";

// FAQ 데이터 타입 (DB에서 가져온 FAQ 항목)
type FaqItem = { id: string; question: string; answer: string };

interface ApplyPageClientProps {
    trialTitle: string;
    trialContentHtml: string | null;
    enrollTitle: string;
    enrollContentHtml: string | null;
    // DB에서 가져온 FAQ 데이터 (없으면 기본 FAQ 표시)
    faqData?: FaqItem[];
}

// 안내 HTML은 서버 컴포넌트(page.tsx)에서 미리 sanitize한 뒤 전달한다.
function ContentBlock({ html }: { html: string }) {
    return (
        <div
            className="prose prose-gray max-w-none text-gray-700 dark:text-gray-200 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

// --- 기본 FAQ 데이터 --- DB에 데이터가 없을 때 fallback으로 사용
const DEFAULT_FAQ_DATA = [
    {
        question: "체험수업 비용이 얼마인가요?",
        answer: "체험수업은 1회 1만원의 체험비가 있습니다. 운동복과 실내화를 준비해 주시면 됩니다. 실제로 다닐 수 있는 요일과 시간대의 수업에서 체험하시길 권장합니다.",
    },
    {
        question: "수강료는 언제 납부하나요?",
        answer: "수강 시작 2주 전부터 수강일 전까지 납부합니다. 2주~1주 전은 우선등록 기간(기존 수강생), 1주 전부터는 신규 등록 기간입니다. 개인 사정으로 지연 시 원으로 연락해 일정을 조율할 수 있습니다.",
    },
    {
        question: "결석하면 환불이나 이월이 되나요?",
        answer: "개인 사정(여행, 행사, 늦잠 등)에 의한 결석은 이월·환불 대상이 아닙니다. 단, 본인의 질병·부상(진단서 제출 가능한 경우)이나 직계존비속 경조사는 확인 후 이월 또는 환불이 가능합니다.",
    },
    {
        question: "보강 수업은 어떻게 받나요?",
        answer: "결석 시 같은 레벨의 다른 수업에 보강 참여가 가능합니다. 단, 해당 수업 정원이 찬 경우 불가합니다. 보강은 결석일로부터 2개월 이내에 참여해야 하며, 2개월이 지나면 자동 소멸됩니다. 학부모님이 직접 보강 일정을 정하여 원에 알려주셔야 합니다.",
    },
    {
        question: "수업 중 다치면 어떻게 되나요?",
        answer: "스티즈농구교실은 삼성화재 보험에 가입되어 있습니다. 다만 보상 범위는 강사·시설물 등 원의 귀책사유가 법적으로 명확한 경우까지이며, 수강생 본인 실수로 인한 부상은 보상이 어려울 수 있습니다. 반드시 강사의 안전교육을 따라주세요.",
    },
    {
        question: "수업 참여 시 준비물은 무엇인가요?",
        answer: "운동복과 실내운동화를 반드시 착용해야 합니다. 미착용 시 수업 참여가 제한될 수 있습니다. 소지품은 체육관 내 사물함을 이용하시되, 수업 후 직접 챙겨주세요. 분실물에 대해 원은 책임지지 않습니다.",
    },
    {
        question: "수업 중 안경을 써도 되나요?",
        answer: "기본적으로 수업 중 안경 착용은 허용하지 않습니다. 시력 문제가 있는 경우 스포츠 고글 또는 깨지지 않는 렌즈/테의 안경을 착용해 주세요.",
    },
    {
        question: "몇 살부터 수업을 들을 수 있나요?",
        answer: "유아반(5~7세)부터 중등반(13~15세)까지 연령별 맞춤 수업을 운영하고 있습니다.",
    },
    {
        question: "중간에 반 변경이 가능한가요?",
        answer: "네, 코치와 상담 후 아이의 실력과 일정에 맞춰 반 변경이 가능합니다.",
    },
    {
        question: "유니폼은 꼭 구매해야 하나요?",
        answer: "네, 모든 수강생은 입단과 동시에 유니폼을 구매해야 합니다. 원활한 수업 운영과 팀 스포츠의 기본을 위한 필수 사항입니다.",
    },
];

// --- FAQ 아코디언 아이템 ---
function FAQItem({ question, answer }: { question: string; answer: string }) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
            {/* 질문 버튼 — 클릭 시 답변 토글 */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between py-5 px-1 text-left hover:text-brand-orange-500 dark:text-brand-neon-lime transition-colors cursor-pointer"
            >
                <span className="font-semibold text-gray-900 dark:text-white pr-4">{question}</span>
                {/* 화살표 아이콘 — 열림/닫힘 상태에 따라 회전 */}
                <svg
                    className={`w-5 h-5 text-gray-400 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {/* 답변 영역 — isOpen일 때만 표시 */}
            {isOpen && (
                <div className="pb-5 px-1">
                    <p className="text-gray-600 dark:text-gray-300 text-base leading-relaxed">{answer}</p>
                </div>
            )}
        </div>
    );
}

export default function ApplyPageClient({
    trialTitle,
    trialContentHtml,
    enrollTitle,
    enrollContentHtml,
    faqData,
}: ApplyPageClientProps) {
    // DB FAQ가 있으면 사용, 없으면 기본 FAQ fallback
    // DB에 FAQ가 있으면 DB 데이터 사용, 없으면 기본 데이터 fallback
    const displayFaqs = faqData && faqData.length > 0 ? faqData : DEFAULT_FAQ_DATA;

    return (
        <>
            <section className="public-section">
                <div className="public-container">
                    <div className="grid gap-4 md:grid-cols-2">
                        <article id="trial" className="public-card flex flex-col gap-4 p-5">
                            <div><p className="public-eyebrow">처음 방문하신다면</p><h2 className="mt-1 text-xl font-bold">{trialTitle}</h2></div>
                            <p className="text-sm">체험비 1만원 · 운동복과 실내화 준비</p>
                            <Link href="/apply/trial" data-tour-target="trial-apply-btn" className="public-button self-start">체험수업 신청하기</Link>
                            {trialContentHtml && <details className="border-t border-[var(--color-public-border)] pt-3"><summary className="cursor-pointer text-sm font-semibold">체험수업 안내</summary><div className="pt-3"><ContentBlock html={trialContentHtml} /></div></details>}
                            <p className="text-xs text-[var(--color-public-muted)]">신청 시 <Link href="/terms" className="public-link">이용약관</Link>에 동의한 것으로 간주합니다.</p>
                        </article>
                        <article id="enroll" className="public-card flex flex-col gap-4 p-5">
                            <div><p className="public-eyebrow">등록을 결정하셨다면</p><h2 className="mt-1 text-xl font-bold">{enrollTitle}</h2></div>
                            <p className="text-sm">학생·보호자 정보와 희망 수업을 접수합니다.</p>
                            <Link href="/apply/enroll" className="public-button-secondary self-start">수강신청하기</Link>
                            {enrollContentHtml && <details className="border-t border-[var(--color-public-border)] pt-3"><summary className="cursor-pointer text-sm font-semibold">수강신청 안내</summary><div className="pt-3"><ContentBlock html={enrollContentHtml} /></div></details>}
                        </article>
                    </div>
                    <div id="uniform" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-public-border)] px-4 py-3">
                        <div><h2 className="text-sm font-bold">유니폼 추가 주문</h2><p className="text-sm text-[var(--color-public-muted)]">형제·자매도 한 번에 신청 · 금액은 접수 후 본사 기준으로 안내</p></div>
                        <Link href="/apply/uniform" className="public-link inline-flex min-h-11 items-center gap-1 font-semibold">유니폼 신청<span className="material-symbols-outlined" aria-hidden="true">arrow_forward</span></Link>
                    </div>
                </div>
            </section>
            <section id="faq" className="public-section">
                <div className="public-container"><h2 className="mb-4 text-xl font-bold">자주 묻는 질문</h2><div className="public-card px-5">{displayFaqs.map((faq, i) => <FAQItem key={i} question={faq.question} answer={faq.answer} />)}</div></div>
            </section>
        </>
    );
}
