' XinYu silent launcher
' Run a .cmd / .bat with a hidden window so Scheduled Tasks do not flash a console.
' Usage: wscript.exe //B //Nologo _hidden.vbs "C:\path\to\task.cmd"

Option Explicit

Dim sh, cmd, i
If WScript.Arguments.Count = 0 Then WScript.Quit 1

cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next

Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False
