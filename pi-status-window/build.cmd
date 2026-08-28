@echo off
rem Build pi-status-window with the built-in .NET Framework csc.exe (C# 5).
rem Output: bin\pi-status-window.exe
setlocal

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
set OUT=bin\pi-status-window.exe

if not exist bin mkdir bin

echo Compiling pi-status-window...
"%CSC%" /nologo /target:winexe /optimize+ /out:%OUT% ^
  /r:System.dll ^
  /r:System.Core.dll ^
  /r:System.Drawing.dll ^
  /r:System.Windows.Forms.dll ^
  /r:System.Runtime.Serialization.dll ^
  Program.cs Core.cs MainForm.cs

if errorlevel 1 (
  echo.
  echo BUILD FAILED
  exit /b 1
)

echo.
echo BUILD OK: %OUT%
exit /b 0
