import "./public-home.css";

const steps = [
  { title: "전화 상담", description: "전화 또는 카카오톡으로 궁금한 점을 편하게 물어보세요" },
  { title: "체험 수업", description: "실제 수업에 참여하여 분위기와 수업 방식을 직접 느껴보세요" },
  { title: "수강 등록", description: "아이에게 맞는 반과 시간을 선택하고 등록을 완료하세요" },
  { title: "수업 시작", description: "전문 코치진과 함께 즐거운 농구 수업이 시작됩니다" },
];
export default function ProcessSteps() {
  return <section className="public-process" aria-label="수강 시작 안내"><h2>수강 시작은 이렇게 쉬워요</h2><ol>{steps.map((step, i) =>
    <li key={step.title}><span className="public-process__number" aria-hidden="true">{i + 1}</span><div><h3>{step.title}</h3><p>{step.description}</p></div></li>,
  )}</ol></section>;
}
