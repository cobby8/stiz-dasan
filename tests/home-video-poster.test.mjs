// 홈 영상은 미리보기 사진 먼저, 누르면 재생(2026-11-17 속도 개선) — 정적 테스트
//
// 왜: 유튜브 재생기를 홈에 바로 넣으면 영상을 안 보는 방문자도 재생기 파일을 내려받아 홈이 3초 가까이 늦게 다 떴다.
//     다시 «처음부터 재생기»로 돌아가지 않게 못박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const landing = read("src/app/LandingPageClient.tsx");
const video = read("src/components/landing/HomeVideo.tsx");
const css = read("src/components/landing/public-home.css");

test("홈 화면은 유튜브 재생기를 직접 넣지 않고 HomeVideo 부품에 맡긴다", () => {
  assert.doesNotMatch(landing, /<iframe/);
  assert.match(landing, /<HomeVideo videoId=\{videoId\} \/>/);
  // 영상 주소에서 11자 id 를 못 찾으면 칸 자체를 그리지 않는다(예전과 같다)
  assert.match(landing, /if \(!videoId\) return null;/);
});

test("누르기 전에는 사진 한 장만, 누른 뒤에만 재생기를 넣는다", () => {
  const playingAt = video.indexOf("if (playing) {");
  const iframeAt = video.indexOf("<iframe");
  const posterAt = video.indexOf('className="public-home-video__poster"');
  assert.ok(playingAt > 0 && iframeAt > playingAt && posterAt > iframeAt, "재생기는 «누른 뒤» 갈래 안에만 있다");
  assert.equal(video.split("<iframe").length - 1, 1);
  assert.match(video, /useState\(false\)/, "처음에는 재생 전 상태");
  assert.match(video, /youtube\.com\/embed\/\$\{videoId\}\?rel=0&autoplay=1&playsinline=1/, "누르면 그 자리에서 바로 재생");
  assert.match(video, /i\.ytimg\.com\/vi\/\$\{videoId\}\/hqdefault\.jpg/);
});

test("버튼은 글자로 말하고(아이콘 없음) 누를 수 있는 진짜 버튼이다", () => {
  assert.match(video, /<button type="button" className="public-home-video__poster" onClick=\{\(\) => setPlaying\(true\)\} aria-label="스티즈 농구교실 영상 재생">/);
  assert.match(video, />영상 재생<\/span>/);
  assert.doesNotMatch(video, /material-symbols|UiIcon|<svg/);
  // 터치 영역 44px 이상, 색은 공개 화면 토큰만
  const play = css.split("\n").find((line) => line.includes(".public-home-video__play{")) ?? "";
  assert.match(play, /min-height:2\.8rem/);
  assert.match(play, /background:var\(--color-public-orange\);color:var\(--color-public-dark\)/);
  assert.doesNotMatch(play, /#[0-9a-fA-F]{3,8}\b/);
});
