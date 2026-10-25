import StoreAppStart from "./StoreAppStart";

// 스토어 앱(통합 앱)의 시작 주소. manifest-app.json 의 start_url 이다.
// 표식을 찍고 역할 판별 화면(/auth/continue)으로 넘긴다 — 로그인 안 했으면 거기서 로그인 화면으로 간다.
// 판별은 서버(/auth/continue)가 하므로 여기서는 아무 데이터도 읽지 않는다.
export const metadata = {
  title: "스티즈 농구교실",
};

export default function StoreAppPage() {
  return <StoreAppStart />;
}
