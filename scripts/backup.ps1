# Backup automatico do Postgres da ATPN (banco atpn_gestao).
# Le a DATABASE_URL do .env (senha nunca vai em linha de comando nem em log).
# Gera um .dump (formato custom do pg_dump) por execucao, valida o arquivo
# e apaga os com mais de 30 dias. Cópia só LOCAL de propósito (dado de sócio:
# CPF/telefone) — copia fora do PC so com decisao explicita do Pedro.
# Restaurar: pg_restore -h localhost -U postgres -d <banco_novo> --clean --if-exists <arquivo.dump>

$ErrorActionPreference = 'Stop'

$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envPath = Join-Path $raiz '.env'
$pastaBackups = 'C:\Projeto pedro sistema site\backups-atpn'
$statusArquivo = Join-Path $pastaBackups 'status.txt'
$diasRetencao = 30
$pgBin = 'C:\Program Files\PostgreSQL\18\bin'

if (-not (Test-Path $pastaBackups)) { New-Item -ItemType Directory -Path $pastaBackups -Force | Out-Null }

try {
    if (-not (Test-Path $envPath)) { throw "Arquivo .env nao encontrado em $envPath" }
    $linhaUrl = Get-Content $envPath | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
    if (-not $linhaUrl) { throw "DATABASE_URL nao encontrada em $envPath" }
    $url = [System.Uri]($linhaUrl -replace '^DATABASE_URL=', '')

    $info = $url.UserInfo.Split(':', 2)
    $usuario = [System.Uri]::UnescapeDataString($info[0])
    $senha = [System.Uri]::UnescapeDataString($info[1])
    $banco = $url.AbsolutePath.TrimStart('/')

    $timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
    $arquivo = Join-Path $pastaBackups "atpn_gestao_$timestamp.dump"

    $env:PGPASSWORD = $senha
    try {
        & "$pgBin\pg_dump.exe" -h $url.Host -p $url.Port -U $usuario -Fc -f $arquivo $banco
        if ($LASTEXITCODE -ne 0) { throw "pg_dump saiu com codigo $LASTEXITCODE" }
        # valida: o arquivo precisa ser legivel pelo pg_restore e ter conteudo
        $lista = & "$pgBin\pg_restore.exe" -l $arquivo 2>&1
        if ($LASTEXITCODE -ne 0 -or -not ($lista -match 'TABLE DATA')) { throw "backup gerado mas invalido (pg_restore -l falhou)" }
    } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }

    $limite = (Get-Date).AddDays(-$diasRetencao)
    Get-ChildItem -Path $pastaBackups -Filter 'atpn_gestao_*.dump' |
        Where-Object { $_.LastWriteTime -lt $limite } |
        ForEach-Object { Remove-Item $_.FullName -Force }

    $kb = [int]((Get-Item $arquivo).Length / 1KB)
    Set-Content -Path $statusArquivo -Value ("OK " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " " + (Split-Path $arquivo -Leaf) + " ${kb}KB")
    Write-Host "Backup criado: $arquivo (${kb}KB)"
} catch {
    Set-Content -Path $statusArquivo -Value ("ERRO " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " " + $_.Exception.Message)
    Write-Error $_
    exit 1
}
