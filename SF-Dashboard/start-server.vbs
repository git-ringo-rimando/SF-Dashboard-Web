Set oShell = CreateObject("WScript.Shell")
oShell.Run "cmd /c ""set PATH=C:\Program Files\nodejs;%PATH% && cd /d ""c:\SF Dashboard"" && npm run dev >> ""c:\SF Dashboard\server.log"" 2>&1""", 0, False
