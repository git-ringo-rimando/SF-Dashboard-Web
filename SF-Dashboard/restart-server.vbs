Set oShell = CreateObject("WScript.Shell")
' Kill any process listening on port 3000
oShell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -aon ^| findstr "":3000""') do taskkill /F /PID %a", 0, True
WScript.Sleep 3000
' Start fresh
oShell.Run "cmd /c ""set PATH=C:\Program Files\nodejs;%PATH% && cd /d ""c:\SF Dashboard"" && npm run dev >> ""c:\SF Dashboard\server.log"" 2>&1""", 0, False
