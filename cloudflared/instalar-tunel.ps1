# Coloca o site da Loja Gutto na internet pelo Cloudflare Tunnel (mesmo desenho do PDV Jabá).
# Não abre porta no roteador: o cloudflared faz uma conexão de SAÍDA pro Cloudflare.
#
# Antes: o domínio precisa estar na conta Cloudflare do Pedro (nameservers do registrador
# trocados pros da Cloudflare). Rodar no PowerShell como Administrador, dentro de C:\LojaGutto:
#   powershell -ExecutionPolicy Bypass -File .\cloudflared\instalar-tunel.ps1 -Dominio lojagutto.com.br
# Pode rodar de novo sem problema (cada passo confere se já foi feito).
param(
  [Parameter(Mandatory = $true)][string]$Dominio,
  [string]$Hosts = "",                  # padrão: o domínio e www.<domínio>
  [string]$NomeTunel = "loja-gutto",
  [string]$Servico = "LojaGuttoTunel"
)
$ErrorActionPreference = "Stop"
$Raiz = Split-Path -Parent $PSScriptRoot           # C:\LojaGutto
$Pasta = Join-Path $Raiz "cloudflared"             # sem espaço no caminho (lição do Jabá: o nssm perde aspas)
$Exe = Join-Path $Pasta "cloudflared.exe"
$Config = Join-Path $Pasta "config.yml"
$Dominio = $Dominio.Trim().ToLower() -replace '^https?://', '' -replace '/.*$', ''
if (-not $Hosts) { $Hosts = "$Dominio,www.$Dominio" }
$ListaHosts = $Hosts.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }

if ($Raiz -match ' ') { throw "O caminho '$Raiz' tem espaço; instale a loja numa pasta sem espaço (ex.: C:\LojaGutto)." }
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { throw "nssm não encontrado no PATH (é o mesmo usado pro serviço LojaGuttoAPI)." }

# 1) cloudflared.exe
if (-not (Test-Path $Exe)) {
  Write-Host "Baixando o cloudflared..."
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $Exe
}
& $Exe --version

# 2) Autorizar a conta Cloudflare (abre o navegador: escolha o domínio da loja)
$Cert = Join-Path $env:USERPROFILE ".cloudflared\cert.pem"
if (-not (Test-Path $Cert)) {
  Write-Host "Vai abrir o navegador: entre na conta Cloudflare e clique no domínio $Dominio pra autorizar."
  & $Exe tunnel login
}

# 3) Criar o túnel (se ainda não existe) e achar o id
$tuneis = & $Exe tunnel list -o json | ConvertFrom-Json
$tunel = $tuneis | Where-Object { $_.name -eq $NomeTunel } | Select-Object -First 1
if (-not $tunel) {
  & $Exe tunnel create $NomeTunel
  $tunel = (& $Exe tunnel list -o json | ConvertFrom-Json) | Where-Object { $_.name -eq $NomeTunel } | Select-Object -First 1
}
$Id = $tunel.id
$Credenciais = Join-Path $env:USERPROFILE ".cloudflared\$Id.json"
if (-not (Test-Path $Credenciais)) { throw "Não achei as credenciais do túnel em $Credenciais (o túnel foi criado em outro computador?)." }
Write-Host "Túnel $NomeTunel = $Id"

# 4) config.yml: todos os endereços vão pra API da loja na porta 3000. Pela internet, a API
#    só responde o site (vitrine, pedidos, fotos) — o painel fica na rede da loja (ver api\seguranca.js).
$linhas = @("tunnel: $Id", "credentials-file: $Credenciais", "", "ingress:")
foreach ($h in $ListaHosts) { $linhas += "  - hostname: $h"; $linhas += "    service: http://localhost:3000" }
$linhas += "  - service: http_status:404"
Set-Content -Path $Config -Value $linhas -Encoding ascii
& $Exe tunnel --config $Config ingress validate

# 5) DNS: um CNAME de cada endereço pro túnel
foreach ($h in $ListaHosts) { & $Exe tunnel route dns --overwrite-dns $NomeTunel $h }

# 6) Serviço do Windows pelo nssm (o "cloudflared service install" ficou em loop de erro no Jabá)
if (Get-Service $Servico -ErrorAction SilentlyContinue) { nssm stop $Servico | Out-Null } else { nssm install $Servico $Exe | Out-Null }
nssm set $Servico AppParameters "--config $Config tunnel run" | Out-Null
nssm set $Servico AppDirectory $Pasta | Out-Null
nssm set $Servico AppStdout (Join-Path $Pasta "servico-saida.log") | Out-Null
nssm set $Servico AppStderr (Join-Path $Pasta "servico-erro.log") | Out-Null
nssm set $Servico Start SERVICE_AUTO_START | Out-Null
nssm start $Servico | Out-Null
Start-Sleep -Seconds 8
& $Exe tunnel info $NomeTunel

# 7) SITE_URL no api\.env (link do site no painel e nas mensagens do WhatsApp)
$Env = Join-Path $Raiz "api\.env"
$url = "https://$($ListaHosts[0])"
$conteudo = Get-Content $Env -Raw
if ($conteudo -match '(?m)^SITE_URL=') { $conteudo = $conteudo -replace '(?m)^SITE_URL=.*$', "SITE_URL=$url" }
else { $conteudo = $conteudo.TrimEnd() + "`r`nSITE_URL=$url`r`n" }
Set-Content -Path $Env -Value $conteudo -NoNewline -Encoding utf8
Restart-Service LojaGuttoAPI
if (Get-Service LojaGuttoBot -ErrorAction SilentlyContinue) { Restart-Service LojaGuttoBot }

Write-Host ""
Write-Host "Pronto. Teste em outro aparelho (fora do Wi-Fi da loja): $url"
Write-Host "Se não abrir, é a propagação do DNS (minutos a ~24h) - confira com: nslookup $($ListaHosts[0]) 8.8.8.8"
