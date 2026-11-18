import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 공식·선생님·학부모·기사 네 앱은 홈 화면에 따로 설치되고 눈으로 구분돼야 한다.
// id 가 겹치면 브라우저가 같은 앱으로 보고 덮어쓰고, 아이콘이 겹치면 사람이 구분하지 못한다.

const MANIFESTS = {
  public: "public/manifest.json",
  staff: "public/manifest-staff.json",
  parent: "public/manifest-parent.json",
  driver: "public/driver-manifest.json",
};

const loaded = Object.fromEntries(
  await Promise.all(
    Object.entries(MANIFESTS).map(async ([key, path]) => [key, JSON.parse(await readFile(path, "utf8"))]),
  ),
);

const nextConfig = await readFile("next.config.ts", "utf8");
const middleware = await readFile("src/lib/supabase/middleware.ts", "utf8");
const myPageLayout = await readFile("src/app/mypage/layout.tsx", "utf8");
const INSTALL_SCREENS = [
  { label: "학부모", path: "src/app/parent-app/ParentAppInstallClient.tsx", home: "/mypage" },
  { label: "선생님", path: "src/app/teacher-app/StaffAppInstallClient.tsx", home: "/staff" },
];

test("네 앱의 id 가 서로 겹치지 않는다", () => {
  const ids = Object.entries(loaded).map(([key, m]) => {
    assert.ok(m.id, `${key} manifest 에 id 가 있어야 합니다. 없으면 start_url 로 대체돼 조용히 바뀝니다.`);
    return m.id;
  });
  assert.equal(new Set(ids).size, ids.length, `앱 id 가 겹칩니다: ${ids.join(", ")}`);
});

test("네 앱의 아이콘이 서로 겹치지 않는다", () => {
  const firstIcons = Object.entries(loaded).map(([key, m]) => {
    assert.ok(m.icons?.length, `${key} manifest 에 아이콘이 있어야 합니다.`);
    return m.icons[0].src;
  });
  assert.equal(
    new Set(firstIcons).size,
    firstIcons.length,
    `아이콘이 겹치면 홈 화면에서 구분할 수 없습니다: ${firstIcons.join(", ")}`,
  );
});

test("역할 앱은 자기 영역만 차지한다", () => {
  // scope 가 겹치면 링크를 눌렀을 때 어느 앱이 열릴지 모호해진다.
  assert.equal(loaded.staff.scope, "/staff");
  assert.equal(loaded.staff.start_url, "/staff");
  assert.equal(loaded.parent.scope, "/mypage");
  assert.equal(loaded.parent.start_url, "/mypage");
});

test("세 앱의 이름이 홈 화면·아이폰·브라우저에서 모두 같다", async () => {
  // 이름이 manifest·레이아웃 metadata·appleWebApp 세 군데에 흩어져 있어 쉽게 어긋난다.
  // 어긋나면 안드로이드와 아이폰 홈 화면에 서로 다른 이름이 찍힌다.
  const NAMES = [
    { key: "staff", name: "스티즈 선생님", layout: "src/app/staff/layout.tsx" },
    { key: "parent", name: "스티즈 학부모", layout: "src/app/mypage/layout.tsx" },
    { key: "driver", name: "스티즈 기사님", layout: "src/app/driver/layout.tsx" },
  ];
  for (const { key, name, layout } of NAMES) {
    assert.equal(loaded[key].name, name, `${key} manifest name`);
    assert.equal(loaded[key].short_name, name, `${key} manifest short_name`);
    const source = await readFile(layout, "utf8");
    assert.match(source, new RegExp(`title: "${name}"`), `${layout} 의 제목이 앱 이름과 다릅니다.`);
  }
});

test("공식 홈페이지 앱은 설치 대상이 아니다", () => {
  // 공식 manifest 는 scope 가 없어 사이트 전체(/)를 자기 영역으로 잡았다.
  // 그 앱이 깔려 있으면 크롬이 /mypage·/staff 도 "이미 설치된 앱 영역"으로 보고
  // 학부모·선생님 앱 설치를 거부한다(실기기 확인, 2026-08-09).
  // 홈페이지는 웹으로 쓰고 앱은 역할별 3개만 남긴다.
  assert.equal(loaded.public.display, "browser");
  // 영역을 비워두면 다시 사이트 전체를 삼키므로 명시해 둔다.
  assert.equal(loaded.public.scope, "/");
  // 역할 앱은 설치돼야 하므로 반대로 단언한다.
  assert.equal(loaded.staff.display, "standalone");
  assert.equal(loaded.parent.display, "standalone");
});

test("학부모 화면은 공용 manifest 가 아니라 자기 manifest 를 쓴다", () => {
  // 앱의 시작 주소(/mypage)가 공용 manifest 를 내려주면 앱 신원이 흔들린다.
  assert.match(myPageLayout, /manifest:\s*"\/manifest-parent\.json"/);
});

// 2026-11-18 원장 승인: 옛 «홈 화면 바로가기» 설치 화면 두 개는 지웠다 — 주소는 /install 로 넘긴다
for (const { label, path } of INSTALL_SCREENS) {
  test(`${label} 옛 설치 화면은 지워져 있다`, async () => {
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(path), false, path);
  });
}

test("옛 설치 안내 주소는 스토어 앱 설치 안내로 넘어가고 로그인 없이 열린다", () => {
  // 2026-11-17 원장 승인: 홈 화면 바로가기식 옛 설치 안내 대신 스토어 앱 안내(/install) 하나로 모았다.
  assert.match(nextConfig, /source: "\/staff\/install", destination: "\/install", permanent: false/);
  assert.match(nextConfig, /source: "\/mypage\/install", destination: "\/install", permanent: false/);
  assert.match(nextConfig, /source: "\/app", destination: "\/install", permanent: false/);
  // 설치 안내는 로그인 전에 봐야 하므로 보호 경로에서 제외한다.
  assert.match(middleware, /isStaffInstall/);
  assert.match(middleware, /isMyPageInstall/);
  assert.match(middleware, /isMyPagePath && !isMyPageInstall/);
});
