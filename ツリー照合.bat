@echo off
rem ドキュメントのフォルダツリーが実体と合っているか確かめます。
rem このファイルをダブルクリックするか、コマンドプロンプトから実行してください。
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 check_tree.py %*
) else (
  python check_tree.py %*
)

set RESULT=%errorlevel%
echo.
if %RESULT%==0 (
  echo 一致しています。
) else (
  echo 食い違いがあります。上の表示をご確認ください。
)
echo.
pause
exit /b %RESULT%
