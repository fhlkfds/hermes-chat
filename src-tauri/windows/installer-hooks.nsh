!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\hermes-chat" "" "URL:Hermes Chat link"
  WriteRegStr SHCTX "Software\Classes\hermes-chat" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\hermes-chat\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\hermes-chat\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\hermes-chat"
!macroend
