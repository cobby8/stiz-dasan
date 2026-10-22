/** 확인되지 않은 누적 수치 대신 수업 선택에 필요한 안내를 표시한다. */
export default function TrustBadges() {
  const facts = [
    { value: "유아부터 성인", label: "연령별 프로그램" },
    { value: "평일 · 주말", label: "일정에 맞는 수업" },
    { value: "전문 코치진", label: "기본기부터 실전까지" },
    { value: "평일 셔틀", label: "노선·탑승 가능 여부 상담" },
  ];
  return <ul className="public-home-facts" aria-label="수업 선택 안내">{facts.map((fact) => <li key={fact.label}><strong>{fact.value}</strong><span>{fact.label}</span></li>)}</ul>;
}
