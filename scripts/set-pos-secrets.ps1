# POS 결제 알림용 비밀값 3개를 Vercel(운영)에 안전하게 넣는다.
#
# 왜 이 스크립트가 필요한가 (2026-09-30 ~ 10-01 실제로 겪은 일)
#   1) "값 복사 → 명령어 복사해 붙여넣기" 순서로 하면, 명령어를 복사하는 순간 클립보드의 값이
#      명령어 글자로 덮어써진다. 세 값 모두 토큰 대신 명령어 글자가 저장됐었다.
#   2) PowerShell 의 `값 | 명령` 은 끝에 줄바꿈(\r\n)을 붙여 저장한다.
#   3) 일부 터미널은 **** 로 가리는 입력칸에 붙여넣기를 막는다.
#   4) Vercel 프로그램은 버전 안내문을 "오류 출력"으로 내보내서, 오류에 즉시 멈추도록 설정하면
#      저장 도중 멈춘다.
#
# 그래서 이 스크립트는
#   · 먼저 실행해 두고 → 크롬에서 값을 복사 → 여기서 Enter 만 누른다(붙여넣기 불필요).
#     실행 중에 복사하므로 클립보드가 명령어로 덮어써질 일이 없다.
#   · 값의 형식을 확인해서 틀리면 다시 받는다. 화면·로그 어디에도 값을 출력하지 않는다.
#   · 읽은 직후 클립보드를 비운다.
#   · 줄바꿈 없는 임시 파일로 넘기고, 외부 명령은 cmd 로 감싸 종료코드로만 성패를 본다.
#
# 사용법: 저장소 폴더에서  powershell -ExecutionPolicy Bypass -File scripts/set-pos-secrets.ps1

$ErrorActionPreference = "Continue"

function Read-Secret {
    param([string]$Label, [string]$Where, [scriptblock]$IsValid, [string]$Hint)
    Write-Host ""
    Write-Host "▶ $Label" -ForegroundColor Cyan
    Write-Host "  1) 크롬에서 복사: $Where"
    while ($true) {
        Read-Host "  2) 복사했으면 여기서 Enter 만 누르세요" | Out-Null
        $plain = (Get-Clipboard -Raw)
        if ($null -eq $plain) { $plain = "" }
        $plain = $plain.Trim()
        if ($plain -match 'Get-Clipboard|vercel env|npx |set-pos-secrets') {
            Write-Host "  ✗ 클립보드에 명령어 글자가 들어 있습니다. 크롬에서 값을 다시 복사한 뒤 Enter 를 눌러 주세요." -ForegroundColor Yellow
            continue
        }
        if ($plain -eq "") {
            Write-Host "  ✗ 클립보드가 비어 있습니다. 크롬에서 값을 복사한 뒤 Enter 를 눌러 주세요." -ForegroundColor Yellow
            continue
        }
        if (& $IsValid $plain) {
            # 비밀값이 클립보드에 남지 않게 바로 비운다.
            Set-Clipboard -Value " "
            Write-Host "  ✓ 형식 확인 (클립보드는 비웠습니다)" -ForegroundColor Green
            return $plain
        }
        Write-Host "  ✗ 형식이 맞지 않습니다. $Hint 다시 복사한 뒤 Enter 를 눌러 주세요." -ForegroundColor Yellow
    }
}

function Set-VercelSecret {
    param([string]$Name, [string]$Value)
    $tmp = [IO.Path]::GetTempFileName()
    try {
        # 줄바꿈 없이 파일에 쓰고 그 파일을 입력으로 넘긴다 — 파이프(|)는 끝에 \r\n 을 붙인다.
        [IO.File]::WriteAllText($tmp, $Value)
        # 이전(잘못된) 값을 지운다. 없으면 실패해도 괜찮다.
        cmd /c "npx vercel env rm $Name production -y >nul 2>nul"
        cmd /c "npx vercel env add $Name production < `"$tmp`" >nul 2>nul"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ✗ $Name 저장에 실패했습니다." -ForegroundColor Red
            return $false
        }
        Write-Host "  → Vercel 에 저장했습니다: $Name" -ForegroundColor Green
        return $true
    } finally {
        [IO.File]::Delete($tmp)
    }
}

# 시험용: -SelfTest 로 실행하면 비밀값 대신 가짜 값 하나를 저장만 한다(확인·삭제는 시험하는 쪽이 한다).
if ($args -contains "-SelfTest") {
    $ok = Set-VercelSecret -Name "POS_SECRET_SELFTEST" -Value "abc-selftest"
    Write-Host ("SELFTEST_RESULT=" + $ok)
    exit 0
}

Write-Host "POS 결제 알림 비밀값 3개를 넣습니다. 크롬에서 복사 → 여기서 Enter, 세 번 반복합니다. 값은 화면에 표시되지 않습니다." -ForegroundColor White

$bot = Read-Secret -Label "① 슬랙 봇 토큰 (Bot User OAuth Token)" `
    -Where "크롬 슬랙 탭 → 왼쪽 'OAuth & Permissions' → Bot User OAuth Token 의 [Copy]" `
    -IsValid { param($v) $v -match '^xoxb-[0-9A-Za-z-]{20,}$' } `
    -Hint "슬랙 봇 토큰은 'xoxb-' 로 시작합니다."

$sign = Read-Secret -Label "② 슬랙 서명 비밀키 (Signing Secret)" `
    -Where "크롬 슬랙 탭 → 왼쪽 'Basic Information' → Signing Secret 의 [Show] 후 복사" `
    -IsValid { param($v) $v -match '^[0-9a-f]{32}$' } `
    -Hint "서명 비밀키는 영문 소문자·숫자 32자리입니다."

$toss = Read-Secret -Label "③ 토스 웹훅 서명 비밀키" `
    -Where "크롬 토스 개발자센터 탭 → 웹훅 줄의 Secret Key 옆 눈 모양 아이콘 클릭 → 나타난 값 복사" `
    -IsValid { param($v) ($v -notmatch '\s') -and $v.Length -ge 16 } `
    -Hint "공백 없는 16자 이상의 값이어야 합니다."

Write-Host ""
Write-Host "Vercel 에 저장하는 중... (한 개에 몇 초씩 걸립니다)" -ForegroundColor White
$ok1 = Set-VercelSecret -Name "SLACK_BOT_TOKEN" -Value $bot
$ok2 = Set-VercelSecret -Name "SLACK_SIGNING_SECRET" -Value $sign
$ok3 = Set-VercelSecret -Name "TOSS_PLACE_WEBHOOK_SECRET" -Value $toss

$bot = $null; $sign = $null; $toss = $null
Write-Host ""
if ($ok1 -and $ok2 -and $ok3) {
    Write-Host "완료했습니다. Claude 에게 '넣었어' 라고 알려주세요." -ForegroundColor Green
} else {
    Write-Host "일부 저장에 실패했습니다. 이 화면을 Claude 에게 보여주세요." -ForegroundColor Red
}
