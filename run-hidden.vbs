Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d D:\Discordchat && node bridge.js >> logs\bridge-stdout.log 2>> logs\bridge-stderr.log", 0, False
