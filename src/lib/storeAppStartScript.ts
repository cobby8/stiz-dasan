// @ts-expect-error Node 의 타입 제거 테스트(tests/store-app-start-fast)에서도 같은 파일을 읽어서 확장자를 붙인다.
import { STORE_APP_CAPS_KEY, STORE_APP_FLAG_KEY, STORE_APP_START_FLAG_KEY } from "./storeApp.ts";

/** 앱이 시작 주소에 실어 보낼 수 있는 «할 수 있는 것» — storeApp.ts 의 parseStoreAppCapabilities 와 같은 목록(테스트가 같은 결과인지 대조한다) */
/** 스크립트가 이미 이동을 걸었다는 표시(창 변수). StoreAppStart 가 이걸 보고 같은 이동을 또 걸지 않는다 — 두 번 걸면 목적 화면 요청이 두 번 나간다 */
export const STORE_APP_START_DONE_FLAG = "__stizStoreAppStarted";

const KNOWN_CAPS = ["push", "links", "geolocation", "voice", "install", "sms"];

/**
 * 스토어 앱 시작 주소(/store-app)가 화면에 심는 짧은 스크립트(2026-11-17 속도 개선).
 *
 * 왜: 예전엔 화면 묶음(자바스크립트)이 다 내려와 준비된 뒤에야 표식을 찍고 다음 화면으로 넘어갔다.
 * 휴대폰에서는 그 기다림이 길다. 이 스크립트는 문서를 읽는 즉시 돌아 — 표식을 찍고 바로 목적 화면으로 넘긴다.
 * 하는 일은 StoreAppStart(markStoreApp·markStoreAppStart·recordStoreAppCapabilities)와 같다. 표식은 sessionStorage 에만 둔다.
 *
 * destination 은 서버가 정한 사이트 안 주소다. 그래도 문자열로 심을 때 «<» 를 바꿔 스크립트 밖으로 새지 않게 한다.
 */
export function buildStoreAppStartScript(destination: string): string {
  const literal = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  return [
    "(function(){",
    "var s=null;try{s=window.sessionStorage}catch(e){}",
    `try{s.setItem(${literal(STORE_APP_FLAG_KEY)},"1")}catch(e){}`,
    `try{s.setItem(${literal(STORE_APP_START_FLAG_KEY)},"1")}catch(e){}`,
    "try{",
    'var raw=new URLSearchParams(window.location.search).get("caps")||"";',
    `var known=${literal(KNOWN_CAPS)};`,
    'var caps=raw.split(",").map(function(c){return c.trim()}).filter(function(c){return known.indexOf(c)>=0});',
    `if(caps.length>0)s.setItem(${literal(STORE_APP_CAPS_KEY)},caps.join(","));`,
    "}catch(e){}",
    `window[${literal(STORE_APP_START_DONE_FLAG)}]=1;`,
    // replace: 뒤로 가기로 이 빈 화면에 다시 서지 않게.
    `window.location.replace(${literal(destination)});`,
    "})();",
  ].join("");
}
