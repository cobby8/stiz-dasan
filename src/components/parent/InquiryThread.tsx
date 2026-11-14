/**
 * 문의 대화 — 글을 쓴 순서대로 위에서 아래로(2026-11-14 원장 결정표 c3). 학부모 화면·관리자 요청함이 같이 쓴다.
 * - 보는 사람(viewer)이 쓴 글은 오른쪽·보조 색 연한 바탕, 상대 글은 왼쪽·회색 바탕(색만으로 구분하지 않게 이름표를 같이 둔다).
 * - 시각 글자(timeLabel)는 부르는 쪽이 KST 로 만들어 넘긴다. 비어 있으면(옛 답변) 시각을 그리지 않는다.
 * - 훅을 쓰지 않아 서버·클라이언트 화면 어디서나 그릴 수 있다.
 */
export type InquiryThreadBubble = { key: string; author: "PARENT" | "ADMIN"; body: string; timeLabel: string };

export default function InquiryThread({ bubbles, viewer }: { bubbles: InquiryThreadBubble[]; viewer: "PARENT" | "ADMIN" }) {
  const nameOf = (author: "PARENT" | "ADMIN") => (author === viewer ? "나" : author === "ADMIN" ? "학원" : "학부모");
  return (
    <ol aria-label="문의 대화" className="grid gap-2">
      {bubbles.map((bubble) => {
        const mine = bubble.author === viewer;
        return (
          <li key={bubble.key} data-inquiry-author={bubble.author} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 ${
                mine
                  ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-ink)]"
                  : "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"
              }`}
            >
              <p className="text-xs text-[var(--color-academy-muted)]">
                <span className="font-semibold">{nameOf(bubble.author)}</span>
                {bubble.timeLabel && <span className="tabular-nums"> · {bubble.timeLabel}</span>}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{bubble.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
