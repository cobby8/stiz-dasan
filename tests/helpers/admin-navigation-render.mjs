import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
/** 실제 메뉴 컴포넌트를 렌더한다. JSX 표기 방식 대신 도달 가능한 링크를 검사한다. */
export function renderAdminNavigation(pathname) {
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/app/admin/AdminShellClient.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function('require', 'exports', code)((id) => {
    if (id === 'next/link') return { default: ({ children, prefetch, ...props }) => React.createElement('a', props, children) };
    if (id === 'next/navigation') return { usePathname: () => pathname };
    if (id === 'next/image' || id.startsWith('@/components/')) return { default: ({ children }) => children ?? null };
    if (id === 'next/dynamic') return { default: () => () => null };
    if (id === '@/app/actions/auth') return { logout: '/logout' };
    return require(id);
  }, exports);
  return renderToStaticMarkup(React.createElement(exports.default, { initialUserName: '시험 관리자', initialUserEmail: 'masked@preview.invalid' }, '시험 본문'));
}
