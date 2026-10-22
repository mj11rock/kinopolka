# Открывает сервер из WSL для телевизора в локальной сети.
# Запускать ОДИН РАЗ в PowerShell от имени администратора:
#   powershell -ExecutionPolicy Bypass -File E:\projects\tv-streaming\tools\setup-network.ps1
$port = 8090

# 1. Зеркальный режим сети WSL: сервер в WSL получает тот же IP, что и Windows
$cfg = Join-Path $env:USERPROFILE '.wslconfig'
$text = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { '' }
if ($text -notmatch 'networkingMode\s*=\s*mirrored') {
    if ($text -notmatch '\[wsl2\]') { $text += "`r`n[wsl2]`r`n" }
    $text = $text -replace '\[wsl2\]', "[wsl2]`r`nnetworkingMode=mirrored"
    Set-Content -Path $cfg -Value $text.Trim() -Encoding ASCII
    Write-Host "Включен networkingMode=mirrored в $cfg"
}

# 2. Разрешаем входящие подключения к порту только из домашней сети
#    (частные/доменные профили и частные диапазоны адресов)
$lan = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
$wslVm = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'
Remove-NetFirewallHyperVRule -Name 'TVStreaming' -ErrorAction SilentlyContinue
New-NetFirewallHyperVRule -Name 'TVStreaming' -DisplayName 'TV streaming (WSL)' -Direction Inbound `
    -VMCreatorId $wslVm -Protocol TCP -LocalPorts $port -RemoteAddresses $lan -Profiles Private,Domain | Out-Null
Remove-NetFirewallRule -Name 'TVStreaming' -ErrorAction SilentlyContinue
New-NetFirewallRule -Name 'TVStreaming' -DisplayName 'TV streaming' -Direction Inbound `
    -Protocol TCP -LocalPort $port -RemoteAddress LocalSubnet -Action Allow -Profile Private,Domain | Out-Null

Write-Host "Готово. Перезапускаю WSL, чтобы применить настройки..."
wsl --shutdown
Write-Host "Открой WSL заново и запусти ./start.sh"
