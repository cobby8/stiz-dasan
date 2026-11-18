/**
 * «가입·연결을 마치면 앱으로 돌아가 로그인까지» 표식 쿠키 이름(2026-11-17). 값은 살려 둔 앱 로그인 요청 번호뿐이다.
 * 굽고 지우는 일은 @/lib/native-auth/http, 검증은 /auth/native/resume 이 한다. 웹 라우트(/auth/callback·/auth/oauth)는
 * «있는지»만 보고 그쪽으로 넘긴다 — 그래서 이름만 따로 둔다(가져오는 것이 없는 순수 모듈).
 */
export const NATIVE_RESUME_COOKIE = "stiz-native-resume";
