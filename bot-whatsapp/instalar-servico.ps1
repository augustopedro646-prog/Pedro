# Instala o robô de WhatsApp da ATPN como serviço do Windows (ATPNBot), igual ao PDVJabaBot:
# sobe sozinho com o computador, reinicia se cair e recebe "parada com calma" (8 s) pra gravar as chaves da sessão.
# Rodar UMA vez, como Administrador:   powershell -ExecutionPolicy Bypass -File .\instalar-servico.ps1
$ErrorActionPreference = 'Stop'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$env = Get-Content "$pasta\.env" -ErrorAction Stop
if (-not ($env | Where-Object { $_ -match '^ANTHROPIC_API_KEY=\S+' })) {
  Write-Host 'Falta a ANTHROPIC_API_KEY no bot-whatsapp\.env (sem ela o robô não sobe). Cole a chave e rode de novo.' -ForegroundColor Yellow
  exit 1
}
$node = (Get-Command node).Source
if (Get-Service ATPNBot -ErrorAction SilentlyContinue) { nssm stop ATPNBot | Out-Null; nssm remove ATPNBot confirm | Out-Null }
nssm install ATPNBot $node server.js | Out-Null
nssm set ATPNBot AppDirectory $pasta | Out-Null
nssm set ATPNBot Start SERVICE_AUTO_START | Out-Null
nssm set ATPNBot AppExit Default Restart | Out-Null
nssm set ATPNBot AppStopMethodConsole 8000 | Out-Null
nssm set ATPNBot AppStdout "$pasta\service-out.log" | Out-Null
nssm set ATPNBot AppStderr "$pasta\service-err.log" | Out-Null
nssm set ATPNBot AppRotateFiles 1 | Out-Null
nssm set ATPNBot AppRotateBytes 5242880 | Out-Null
nssm start ATPNBot
Write-Host 'Serviço ATPNBot instalado e iniciado. Abra a aba WhatsApp no sistema e escaneie o QR Code com o número da ATPN.' -ForegroundColor Green
