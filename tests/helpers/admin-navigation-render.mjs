import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const Link = ({ children, prefetch, ...props }) => React.createElement('a', props, children);

// 2026-11-13 메뉴 정리: 메뉴 셸이 화면 위 «탭 줄»(SectionTabs)과 묶음 정의(admin-sections)를 실제로 쓴다.
// 이 둘은 가짜로 바꾸지 않고 진짜 파일을 불러와 — 탭으로 옮긴 화면도 «메뉴에서 도달 가능»한지 검사한다.
const REAL_MODULES = {
  '@/lib/admin-sections': 'src/lib/admin-sections.ts',
  '@/components/admin/SectionTabs': 'src/components/admin/SectionTabs.tsx',
};

/** TS/TSX 파일을 CommonJS 로 바꿔 실행한다. pathname = usePathname() 이 돌려줄 주소 */
export function loadAdminModule(file, pathname = '/admin') {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (REAL_MODULES[id]) return loadAdminModule(REAL_MODULES[id], pathname);
    if (id === 'next/link') return { default: Link };
    if (id === 'next/navigation') return { usePathname: () => pathname };
    if (id === 'next/image' || id.startsWith('@/components/')) return { default: ({ children }) => children ?? null };
    if (id === 'next/dynamic') return { default: () => () => null };
    if (id === '@/app/actions/auth') return { logout: '/logout' };
    return require(id);
  }, module, module.exports);
  return module.exports;
}

/** 실제 메뉴 컴포넌트를 렌더한다. JSX 표기 방식 대신 도달 가능한 링크를 검사한다. */
export function renderAdminNavigation(pathname) {
  const Shell = loadAdminModule('src/app/admin/AdminShellClient.tsx', pathname).default;
  return renderToStaticMarkup(React.createElement(Shell, { initialUserName: '시험 관리자', initialUserEmail: 'masked@preview.invalid' }, '시험 본문'));
}
