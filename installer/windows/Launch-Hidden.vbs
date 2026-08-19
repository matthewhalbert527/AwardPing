' AwardPing hidden launcher: runs the given command with no console window.
' Scheduled tasks call this via wscript.exe so PowerShell's console never
' flashes. Usage: wscript.exe //B //Nologo Launch-Hidden.vbs <exe> <args...>
Option Explicit
Dim shell, command, index, part
If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If
command = ""
For index = 0 To WScript.Arguments.Count - 1
  part = WScript.Arguments(index)
  If InStr(part, " ") > 0 And Left(part, 1) <> """" Then
    part = """" & part & """"
  End If
  If index > 0 Then command = command & " "
  command = command & part
Next
Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, True)
