import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skipEnv = process.argv.includes("--skip-env");
const skipDb = process.argv.includes("--skip-db");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = (process.env.RELEASE_ENV_SCOPE || process.env.VERCEL_ENV || "").toLowerCase();

function isPresent(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function hasStrongMessagePrivacySecret() {
  const value = process.env.MESSAGE_PRIVACY_HMAC_SECRET?.trim() || "";
  return Buffer.byteLength(value, "utf8") >= 32;
}

function hasValidStizPartnerSecret() {
  const value = process.env.STIZ_PARTNER_SECRET?.trim() || "";
  return /^[a-f0-9]{64}$/i.test(value);
}

function hasValidCafe24BridgeSecret() {
  const value = process.env.CAFE24_PAYMENT_BRIDGE_SECRET?.trim()
    || process.env.STIZ_PARTNER_SECRET?.trim()
    || "";
  return /^[a-f0-9]{64}$/i.test(value);
}

function selectedPaymentProvider() {
  const raw = (process.env.PAYMENT_PROVIDER || process.env.NEXT_PUBLIC_PAYMENT_PROVIDER || "TOSS")
    .trim()
    .toUpperCase();
  if (["CAFE24", "CAFE24_BRIDGE", "CAFE24_PAYMENT", "STIZ_CAFE24"].includes(raw)) {
    return "CAFE24_BRIDGE";
  }
  return "TOSS";
}

function hasHttpUrl(name) {
  const value = process.env[name]?.trim() || "";
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function requirePaymentEnvironment(missing) {
  const provider = selectedPaymentProvider();
  if (provider === "CAFE24_BRIDGE") {
    const hasBridgeUrl = isPresent("CAFE24_PAYMENT_BRIDGE_URL") || isPresent("STIZ_CAFE24_PAYMENT_API_URL");
    if (!hasBridgeUrl) {
      missing.push("CAFE24_PAYMENT_BRIDGE_URL (또는 STIZ_CAFE24_PAYMENT_API_URL)");
    } else if (!hasHttpUrl("CAFE24_PAYMENT_BRIDGE_URL") && !hasHttpUrl("STIZ_CAFE24_PAYMENT_API_URL")) {
      missing.push("CAFE24_PAYMENT_BRIDGE_URL (http/https URL 형식)");
    }
    if (!hasValidCafe24BridgeSecret()) {
      missing.push("CAFE24_PAYMENT_BRIDGE_SECRET 또는 STIZ_PARTNER_SECRET (64자 hex 형식의 본사 결제 서명키)");
    }
    return;
  }

  if (!isPresent("TOSS_PAYMENTS_SECRET_KEY")) {
    missing.push("TOSS_PAYMENTS_SECRET_KEY");
  }
  if (!isPresent("NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY") && !isPresent("TOSS_PAYMENTS_CLIENT_KEY")) {
    missing.push("NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY (또는 TOSS_PAYMENTS_CLIENT_KEY)");
  }
}

function currentSmsProvider() {
  const provider = (process.env.SMS_PROVIDER || "").trim().toUpperCase();
  if (provider === "BIZPPURIO" || provider === "BIZ_PPURIO" || provider === "PPURIO") return "BIZPPURIO";
  if (provider === "SOLAPI" || provider === "COOLSMS") return "SOLAPI";
  return isPresent("BIZPPURIO_ACCOUNT") ? "BIZPPURIO" : "SOLAPI";
}

function requireSmsEnvironment(missing) {
  const provider = currentSmsProvider();
  if (provider === "BIZPPURIO") {
    if (!isPresent("BIZPPURIO_ACCOUNT")) missing.push("BIZPPURIO_ACCOUNT");
    if (!isPresent("BIZPPURIO_PASSWORD") && !isPresent("BIZPPURIO_API_KEY")) {
      missing.push("BIZPPURIO_PASSWORD (or BIZPPURIO_API_KEY)");
    }
    if (!isPresent("BIZPPURIO_SENDER") && !isPresent("BIZPPURIO_FROM")) {
      missing.push("BIZPPURIO_SENDER (or BIZPPURIO_FROM)");
    }
    return;
  }

  ["SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER"].forEach((name) => {
    if (!isPresent(name)) missing.push(name);
  });
}

function checkEnvironment() {
  const missing = [];
  const requireAll = (names) => names.forEach((name) => {
    if (!isPresent(name)) missing.push(name);
  });

  if (!scope || !["production", "preview"].includes(scope)) {
    console.error("[환경] RELEASE_ENV_SCOPE 또는 VERCEL_ENV를 production/preview로 지정해야 합니다.");
    return false;
  }

  requireAll([
    "DATABASE_URL",
    "DIRECT_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "GEMINI_API_KEY",
    "INVITE_OTP_SECRET",
    "STIZ_PARTNER_SECRET",
  ]);

  if (!hasStrongMessagePrivacySecret()) {
    missing.push("MESSAGE_PRIVACY_HMAC_SECRET (32바이트 이상의 무작위 서버 비밀값)");
  }
  if (isPresent("STIZ_PARTNER_SECRET") && !hasValidStizPartnerSecret()) {
    missing.push("STIZ_PARTNER_SECRET (64자 hex 형식의 본사 연동 비밀키)");
  }

  requireSmsEnvironment(missing);
  requirePaymentEnvironment(missing);

  if (process.env.RELEASE_REQUIRE_INSTAGRAM === "true") {
    if (!isPresent("INSTAGRAM_ACCESS_TOKEN") && !isPresent("META_ACCESS_TOKEN")) {
      missing.push("INSTAGRAM_ACCESS_TOKEN (또는 META_ACCESS_TOKEN)");
    }
    requireAll(["INSTAGRAM_BUSINESS_ACCOUNT_ID"]);
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "";
  if (siteUrl && (scope === "production") && (!siteUrl.startsWith("https://") || /localhost/i.test(siteUrl))) {
    console.error("[환경] production의 NEXT_PUBLIC_SITE_URL은 localhost가 아닌 https URL이어야 합니다.");
    return false;
  }

  if (missing.length > 0) {
    console.error(`[환경] ${scope} 범위에서 누락된 변수 ${missing.length}개:`);
    missing.forEach((name) => console.error(`- ${name}`));
    console.error("비밀값은 출력하지 않았습니다. Vercel의 해당 Environment 범위를 확인하세요.");
    return false;
  }

  console.log(`[환경] ${scope} 필수 변수의 존재 여부를 확인했습니다. 비밀값은 출력하지 않았습니다.`);
  return true;
}

function run(label, command, args) {
  console.log(`\n[검사] ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[실패] ${label}: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[실패] ${label} (종료 코드 ${result.status ?? "unknown"})`);
    return false;
  }
  console.log(`[통과] ${label}`);
  return true;
}

if (!skipEnv && !checkEnvironment()) process.exit(1);
if (skipEnv) console.log("[환경] --skip-env로 환경변수 검사를 생략했습니다. 배포 승인을 의미하지 않습니다.");

const prisma = resolve(root, "node_modules", "prisma", "build", "index.js");
const tsc = resolve(root, "node_modules", "typescript", "bin", "tsc");
const seasonalDbPreflight = resolve(root, "scripts", "seasonal-db-preflight.mjs");
const regularShuttleDbPreflight = resolve(root, "scripts", "regular-shuttle-db-preflight.mjs");
const operationsSyncDbPreflight = resolve(root, "scripts", "operations-sync-db-preflight.mjs");
const uniformOrderDbPreflight = resolve(root, "scripts", "uniform-order-db-preflight.mjs");
const kakaoParentDbPreflight = resolve(root, "scripts", "kakao-parent-db-preflight.mjs");

if (!existsSync(prisma) || !existsSync(tsc)) {
  console.error("[실패] node_modules가 없습니다. npm ci 후 다시 실행하세요.");
  process.exit(1);
}

const testFiles = readdirSync(resolve(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve(root, "tests", name));

const checks = [
  ["Prisma 스키마", process.execPath, [prisma, "validate"]],
  ["TypeScript", process.execPath, [tsc, "--noEmit"]],
  ["정책 및 계약 테스트", process.execPath, ["--test", ...testFiles]],
  // tests/ 밖(src/)에 있어 위 목록에 안 잡히던 가드. 빠지면 병합된 유령 학생 쿼리가 조용히 늘어난다.
  ["학생 병합 필터 가드", process.execPath, ["--experimental-strip-types", "--test", resolve(root, "src", "lib", "studentVisibility.test.ts")]],
];

if (!skipEnv) {
  // 화면 코드보다 DB 구조가 뒤처진 배포를 먼저 차단한다.
  checks.unshift(
    ["운영 동기화 DB 준비 상태", process.execPath, [operationsSyncDbPreflight, ...(skipDb ? ["--skip-db"] : [])]],
    ["정규 셔틀 DB 준비 상태", process.execPath, [regularShuttleDbPreflight, ...(skipDb ? ["--skip-db"] : [])]],
    ["방학특강 DB 준비 상태", process.execPath, [seasonalDbPreflight, ...(skipDb ? ["--skip-db"] : [])]],
    ["유니폼 주문 DB 준비 상태", process.execPath, [uniformOrderDbPreflight, ...(skipDb ? ["--skip-db"] : [])]],
    ["카카오 학부모 접수 DB 준비 상태", process.execPath, [kakaoParentDbPreflight, ...(skipDb ? ["--skip-db"] : [])]],
  );
} else {
  console.log("[건너뜀] --skip-env 코드 검사에서는 방학특강·정규 셔틀·운영 동기화·유니폼·카카오 DB 연결 검사를 실행하지 않습니다.");
}

for (const [label, command, args] of checks) {
  if (!run(label, command, args)) process.exit(1);
}

console.log("\n[완료] 읽기 전용 릴리스 검사를 통과했습니다. DB SQL 적용·배포·외부 발송은 수행하지 않았습니다.");
