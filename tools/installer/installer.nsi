; TraceFind 安装器（NSIS / MUI2）
; 由 tools/build-installer.ps1 填入版本与路径后调用 makensis 编译。
; 特点：可选安装目录、当前用户免管理员、开始菜单与桌面快捷方式保留应用图标。

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP_NAME "TraceFind"
!define APP_PUBLISHER "TraceFind"
!define APP_URL "https://github.com/fanfanhappy/TraceFind"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TraceFind"

!define APP_VERSION "{{VERSION}}"
!define SRC_EXE "{{SRC_EXE}}"
!define ICON_FILE "{{ICON}}"
!define OUT_FILE "{{OUT}}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\TraceFind"
InstallDirRegKey HKCU "Software\TraceFind" "InstallDir"
RequestExecutionLevel user
; 用非 solid 的 lzma：solid 模式在这台机器上会报 "Error writing temporary file"
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"
BrandingText "${APP_NAME} ${APP_VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEPAGE_TITLE "安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "将安装 ${APP_NAME} ${APP_VERSION}。$\r$\n$\r$\n下一步可以选择安装位置；默认装到当前用户目录，不需要管理员权限。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "选择 ${APP_NAME} 的安装位置。装到当前用户目录时，应用内的一键更新可以直接替换程序。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\TraceFind.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!define MUI_FINISHPAGE_LINK "项目主页"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "!${APP_NAME}（必需）" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /oname=TraceFind.exe "${SRC_EXE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\TraceFind.exe" "" "$INSTDIR\TraceFind.exe" 0

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\TraceFind.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegStr HKCU "Software\TraceFind" "InstallDir" "$INSTDIR"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "创建桌面快捷方式" SEC_DESKTOP
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\TraceFind.exe" "" "$INSTDIR\TraceFind.exe" 0
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$INSTDIR\TraceFind.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\TraceFind"
SectionEnd
