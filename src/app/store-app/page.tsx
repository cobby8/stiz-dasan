import { resolveContinueDestination } from "@/lib/auth/continue-destination";
import { buildStoreAppStartScript } from "@/lib/storeAppStartScript";
import StoreAppStart from "./StoreAppStart";

// 스토어 앱(통합 앱)의 시작 주소. manifest-app.json 의 start_url 이다.
// 표식을 찍고 역할에 맞는 화면으로 넘긴다 — 로그인 안 했으면 로그인 화면으로 간다.
//
// 속도(2026-11-17): 예전엔 여기 → /auth/continue → 목적 화면으로 서버를 세 번 깨웠다(쉬던 서버는 깨어나는 데 0.7~2초).
// 이제 어디로 갈지를 여기서 바로 정해(/auth/continue 와 같은 함수) 목적 화면으로 한 번에 넘긴다.
export const metadata = {
  title: "스티즈 농구교실",
};

// 사람마다 목적지가 달라 미리 만들어 둘 수 없다.
export const dynamic = "force-dynamic";

export default async function StoreAppPage() {
  // 확인에 실패하면 예전 경로(역할 판별 화면)로 — 거기서 다시 확인하고, 안 되면 안내 화면을 보인다.
  const destination = await resolveContinueDestination({}).catch(() => "/auth/continue");

  return (
    <>
      {/* 문서를 읽는 즉시 표식을 찍고 넘어간다. 아래 StoreAppStart 는 이 스크립트가 못 돌았을 때의 대비다. */}
      <script dangerouslySetInnerHTML={{ __html: buildStoreAppStartScript(destination) }} />
      <StoreAppStart destination={destination} />
    </>
  );
}
