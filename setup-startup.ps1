# Create a startup shortcut in the user's Startup folder (no admin required)
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'NanoClaw-PM2.lnk'

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'cmd.exe'
$shortcut.Arguments = "/c `"$env:APPDATA\npm\pm2.cmd`" resurrect"
$shortcut.WorkingDirectory = 'C:\projects\nanoclaw'
$shortcut.WindowStyle = 7  # minimized
$shortcut.Description = 'Start NanoClaw PM2 processes on login'
$shortcut.Save()

Write-Host "Startup shortcut created: $shortcutPath"
