; Nova IDE - extra installer steps (included by electron-builder's NSIS script)
; Adds Nova IDE to "Open with" for solutions and projects WITHOUT changing the default app
; (so Visual Studio keeps opening .sln files on double-click), and adds "Open with Nova IDE"
; to the Explorer menu for folders. SHCTX = current user, or all users for a per-machine install.

!macro NovaProgId PROGID DESC
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open" "FriendlyAppName" "Nova IDE"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro NovaOpenWith EXT PROGID
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro customInstall
  !insertmacro NovaProgId "NovaIDE.Solution" "Solution (Nova IDE)"
  !insertmacro NovaProgId "NovaIDE.Project" ".NET Project (Nova IDE)"
  !insertmacro NovaOpenWith "sln" "NovaIDE.Solution"
  !insertmacro NovaOpenWith "slnx" "NovaIDE.Solution"
  !insertmacro NovaOpenWith "csproj" "NovaIDE.Project"
  !insertmacro NovaOpenWith "fsproj" "NovaIDE.Project"
  !insertmacro NovaOpenWith "vbproj" "NovaIDE.Project"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Nova IDE"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Explorer: right-click a folder (or empty space inside one) > "Open with Nova IDE"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\NovaIDE" "" "Open with Nova IDE"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\NovaIDE" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "Software\Classes\Directory\shell\NovaIDE\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\NovaIDE" "" "Open with Nova IDE"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\NovaIDE" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\NovaIDE\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; tell Explorer that file types changed
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\NovaIDE.Solution"
  DeleteRegKey SHCTX "Software\Classes\NovaIDE.Project"
  DeleteRegValue SHCTX "Software\Classes\.sln\OpenWithProgids" "NovaIDE.Solution"
  DeleteRegValue SHCTX "Software\Classes\.slnx\OpenWithProgids" "NovaIDE.Solution"
  DeleteRegValue SHCTX "Software\Classes\.csproj\OpenWithProgids" "NovaIDE.Project"
  DeleteRegValue SHCTX "Software\Classes\.fsproj\OpenWithProgids" "NovaIDE.Project"
  DeleteRegValue SHCTX "Software\Classes\.vbproj\OpenWithProgids" "NovaIDE.Project"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\NovaIDE"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\NovaIDE"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
!macroend
