@echo off
REM Builds the signer + vector harness against UNREAL'S OWN OpenSSL, so what is verified here
REM is what the plugin actually links.
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64 >nul
set UE=C:\Program Files\Epic Games\UE_5.6\Engine\Source\ThirdParty\OpenSSL\1.1.1t
cd /d "%~dp0"
cl /nologo /EHsc /std:c++17 /W3 /MD ^
   /I"%UE%\include\Win64\VS2015" /I"..\Source\X402Gaming\Public" ^
   verify.cpp ..\Source\X402Gaming\Private\X402Signer.cpp ^
   /Fe:verify.exe ^
   /link /LIBPATH:"%UE%\lib\Win64\VS2015\Release" libcrypto.lib ^
   ws2_32.lib crypt32.lib advapi32.lib user32.lib legacy_stdio_definitions.lib
