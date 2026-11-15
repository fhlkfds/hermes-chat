; Until 0.1.4 the app was "Hermes Chat". The installer keys an install by product name (its folder, its uninstall entry),
; so installing Highwing over it would leave both. Run the old uninstaller silently first, in place, as Tauri's own
; reinstall page does. Its "delete app data" box stays off in silent mode, and the data folder is named by the bundle
; identifier, which didn't change, so chats, settings and the keyring sign-in carry over (ADR 0176).
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  ReadRegStr $R0 SHCTX "Software\${MANUFACTURER}\Hermes Chat" ""
  ReadRegStr $R1 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hermes Chat" "UninstallString"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
    ExecWait '$R1 /S _?=$R0'
    Delete "$R0\uninstall.exe"
    RMDir "$R0"
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\hermes-chat" "" "URL:Highwing link"
  WriteRegStr SHCTX "Software\Classes\hermes-chat" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\hermes-chat\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\hermes-chat\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\hermes-chat"
!macroend
