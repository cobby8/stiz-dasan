import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { getVerifiedParentState } from "@/lib/auth-guard";
import { bindIdentity, isKakaoConnectTokenUsable } from "@/lib/kakao-parent-chatbot";
import { detectInstallEnvironment } from "@/lib/pwa/installEnvironment";
import { InAppBrowserEscapeCard } from "@/components/pwa/InstallHelp";

// 카카오채널 「기존 수강생 인증」 링크가 여는 화면.
// 학부모가 보는 주소는 /mypage/kakao-connect 그대로다(next.config rewrite → 이 화면).
// /mypage 안에 두면 마이페이지 레이아웃이 로그인 안 된 사람을 먼저 튕겨 내서,
// "왜 안 되는지" 안내를 보여줄 수 없었다(오류 화면만 떴다). 그래서 레이아웃 밖으로 뺐다.

export const dynamic = "force-dynamic";
// 주소에 일회용 연결 토큰이 있으므로 다른 사이트로 주소가 새지 않게 한다.
// 일회용 링크 화면이라 검색에 잡히지 않게 한다.
export const metadata: Metadata = {
  title: "카카오 학부모 인증",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const CHANNEL_CHAT_URL = "https://pf.kakao.com/_HhaQG/chat";

export default async function KakaoConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; expired?: string }>;
}) {
  const params = await searchParams;
  const token = params.token?.trim() || "";

  if (params.done === "1") {
    return (
      <Shell tone="success">
        <div className="text-center">
          <div className="text-4xl">✅</div>
          <h1 className="mt-4 text-xl font-black text-gray-950">카카오 학부모 인증 완료</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">이제 카카오 채널에서 평소처럼 말씀하시면 연결된 자녀를 자동으로 확인합니다. 결석·당일 셔틀·입금·영수증은 실제 수업과 청구서를 고르는 전용 화면으로 바로 접수할 수 있어요.</p>
          <div className="mt-6 grid gap-2">
            <a href={CHANNEL_CHAT_URL} className="inline-flex justify-center rounded-xl bg-yellow-400 px-5 py-3 text-sm font-black text-gray-950">카카오 채널로 돌아가기</a>
            <Link href="/mypage" className="inline-flex justify-center rounded-xl bg-gray-950 px-5 py-3 text-sm font-bold text-white">학부모 마이페이지 보기</Link>
          </div>
        </div>
      </Shell>
    );
  }

  // 링크가 없거나 만료·사용됨 → 로그인 안내보다 먼저 알린다(로그인해도 어차피 연결할 수 없다).
  if (!token || params.expired === "1" || !(await isKakaoConnectTokenUsable(token))) {
    return (
      <Shell tone="warn">
        <p className="text-sm font-bold text-yellow-700">링크 확인</p>
        <h1 className="mt-2 text-2xl font-black text-gray-950">인증 링크가 만료됐거나 이미 사용됐어요</h1>
        <p className="mt-4 text-sm leading-6 text-gray-600">카카오채널에서 <b>‘기존 수강생 인증’</b>을 다시 눌러 새 링크를 받아 주세요. 링크는 받은 뒤 <b>15분</b> 동안만 쓸 수 있어요.</p>
        <a href={CHANNEL_CHAT_URL} className="mt-6 inline-flex w-full justify-center rounded-xl bg-yellow-400 px-5 py-3.5 font-black text-gray-950">카카오 채널로 돌아가기</a>
      </Shell>
    );
  }

  // 로그인·계정 연결이 끝나면 다시 이 화면으로 돌아와 연결을 이어 간다(허용된 내부 경로만 받는 기존 검증을 그대로 탄다).
  const selfPath = `/mypage/kakao-connect?token=${encodeURIComponent(token)}`;
  const loginHref = `/login?${new URLSearchParams({ redirect: selfPath }).toString()}`;
  const activateHref = `/signup/parent?${new URLSearchParams({ existing: "1", next: selfPath }).toString()}`;
  const state = await getVerifiedParentState();

  if (state.status === "OK") {
    async function connect() {
      "use server";
      const current = await getVerifiedParentState();
      // 그사이 로그아웃 등으로 상태가 바뀌었으면 안내 화면으로 되돌린다
      if (current.status !== "OK") redirect(selfPath);
      let connected = true;
      try {
        await bindIdentity(token, current.parent.appUserId);
      } catch {
        connected = false; // 만료·이미 사용된 링크 → 오류 화면 대신 다시 받기 안내
      }
      redirect(connected ? "/mypage/kakao-connect?done=1" : "/mypage/kakao-connect?expired=1");
    }

    return (
      <Shell tone="warn">
        <p className="text-sm font-bold text-yellow-700">최초 1회 인증</p>
        <h1 className="mt-2 text-2xl font-black text-gray-950">카카오와 학부모 계정 연결</h1>
        <p className="mt-4 text-sm leading-6 text-gray-600">{state.parent.appUserName} 학부모님의 검증된 계정을 현재 카카오 대화와 연결합니다. 카카오 사용자 키와 전화번호 원문은 화면이나 운영 기록에 노출하지 않습니다.</p>
        <form action={connect} className="mt-7">
          <button className="w-full rounded-xl bg-yellow-400 px-5 py-3.5 font-black text-gray-950">이 카카오 계정 연결하기</button>
        </form>
        <p className="mt-4 text-xs leading-5 text-gray-500">본인이 요청하지 않았다면 연결하지 말고 창을 닫아주세요. 인증 링크는 15분 후 만료됩니다.</p>
      </Shell>
    );
  }

  if (state.status === "STAFF_ACCOUNT") {
    return (
      <Shell tone="warn">
        <p className="text-sm font-bold text-yellow-700">계정 확인</p>
        <h1 className="mt-2 text-2xl font-black text-gray-950">학부모 계정으로 열어 주세요</h1>
        <p className="mt-4 text-sm leading-6 text-gray-600">지금은 관리자·선생님 계정으로 로그인돼 있어요. 카카오 학부모 인증은 학부모 계정에만 연결할 수 있어요. 로그아웃한 뒤 학부모 계정으로 다시 로그인해 주세요.</p>
        <form action={logout} className="mt-6">
          <button className="w-full rounded-xl bg-gray-950 px-5 py-3.5 font-bold text-white">로그아웃</button>
        </form>
      </Shell>
    );
  }

  if (state.status === "PHONE_UNVERIFIED") {
    return (
      <Shell tone="warn">
        <p className="text-sm font-bold text-yellow-700">휴대폰 인증 필요</p>
        <h1 className="mt-2 text-2xl font-black text-gray-950">휴대폰 인증을 먼저 끝내 주세요</h1>
        <p className="mt-4 text-sm leading-6 text-gray-600">학부모 계정의 휴대폰 인증이 아직 끝나지 않아 카카오와 연결할 수 없어요. 아래 버튼으로 인증을 마치면 이 화면으로 돌아와요. 계속 안 되면 학원에 문의해 주세요.</p>
        <Link href={`/auth/continue?${new URLSearchParams({ redirect: selfPath }).toString()}`} className="mt-6 inline-flex w-full justify-center rounded-xl bg-yellow-400 px-5 py-3.5 font-black text-gray-950">휴대폰 인증하러 가기</Link>
      </Shell>
    );
  }

  // 로그인 안 됨 / 간편로그인만 되고 학부모 계정과 연결 안 됨
  const env = detectInstallEnvironment({ userAgent: (await headers()).get("user-agent") || "" });
  const inApp = env.inAppBrowser;
  const activateButton = (
    <Link href={activateHref} className="inline-flex w-full justify-center rounded-xl bg-yellow-400 px-5 py-3.5 font-black text-gray-950">기존 학부모 계정 활성화</Link>
  );
  const loginButton = (
    <Link href={loginHref} className="inline-flex w-full justify-center rounded-xl bg-gray-950 px-5 py-3.5 font-bold text-white">로그인하고 연결하기</Link>
  );

  return (
    <Shell tone="warn">
      <p className="text-sm font-bold text-yellow-700">최초 1회 인증</p>
      <h1 className="mt-2 text-2xl font-black text-gray-950">
        {state.status === "NO_APP_ACCOUNT" ? "학부모 계정 연결이 필요해요" : "먼저 학부모 계정으로 로그인해 주세요"}
      </h1>
      <p className="mt-4 text-sm leading-6 text-gray-600">
        로그인하면 이 화면으로 돌아와 카카오 연결을 바로 이어 가요. <b>계정이 없거나 로그인이 안 되면</b> ‘기존 학부모 계정 활성화’를 눌러 주세요. 학원에 알려 주신 휴대폰 번호로 문자 인증하고 비밀번호만 정하면 됩니다.
      </p>
      {/* 카카오톡 안 브라우저는 간편로그인 세션이 자주 끊긴다 → 비밀번호 방식(활성화)을 먼저 보여 준다 */}
      <div className="mt-6 grid gap-2">
        {inApp ? <>{activateButton}{loginButton}</> : <>{loginButton}{activateButton}</>}
      </div>
      {inApp ? (
        <>
          <p className="mt-4 text-xs leading-5 text-gray-500">카카오·구글 간편로그인은 카카오톡 안에서 끊길 수 있어요. 간편로그인을 쓰려면 아래 안내대로 외부 브라우저에서 열어 주세요. 아이디·이메일 로그인과 계정 활성화는 여기서 그대로 하셔도 돼요.</p>
          <InAppBrowserEscapeCard
            inAppBrowser={inApp}
            platform={env.platform}
            description="간편로그인(카카오·구글)을 쓰려면 외부 브라우저에서 열어 주세요. 이 화면 주소가 그대로 열려 연결을 이어 갈 수 있어요."
          />
        </>
      ) : null}
      <p className="mt-4 text-xs leading-5 text-gray-500">인증 링크는 받은 뒤 15분 동안만 쓸 수 있어요. 시간이 지나면 카카오채널에서 ‘기존 수강생 인증’을 다시 눌러 주세요.</p>
    </Shell>
  );
}

function Shell({ tone, children }: { tone: "warn" | "success"; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <div className={`rounded-3xl border bg-white p-7 shadow-sm ${tone === "success" ? "border-emerald-200" : "border-yellow-200"}`}>
        {children}
      </div>
    </main>
  );
}
