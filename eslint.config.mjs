import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 토스 POS 플러그인은 자체 package.json·tsconfig 로 따로 검사한다(사이트 빌드와 분리)
    "apps/toss-pos-plugin/**",
  ]),
]);

export default eslintConfig;
