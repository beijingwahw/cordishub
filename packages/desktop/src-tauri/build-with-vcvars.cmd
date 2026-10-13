@echo off
rem CordisHub Desktop 构建包装：先加载 MSVC 环境再 cargo build。
rem 直接在 Git Bash / 裸 cmd 里跑 cargo 时，rc.exe 可能因缺 INCLUDE 而报
rem "RC.EXE failed to compile specified resource file"——用本脚本规避。
for /f "usebackq tokens=*" %%i in (`"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do call "%%i\VC\Auxiliary\Build\vcvars64.bat"
cd /d "%~dp0"
cargo build %*
