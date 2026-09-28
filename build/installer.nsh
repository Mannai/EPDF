; Epdf NSIS installer additions (included by electron-builder).
;
; Adds Explorer right-click entries:
;   "Convert to PDF with Epdf"   for pictures, Office/OpenDocument, RTF, text and CSV files
;   "Combine files in Epdf"      for the same types
; PDFs get no extra entries: right-clicking a PDF shows Epdf only under "Open with".
; They run:  Epdf.exe --convert-to-pdf "%1"   /   Epdf.exe --combine "%1"
; With several files selected, Explorer either passes them all in one command line (MultiSelectModel=Player) or
; starts one process per file; the app copes with both (see src/main/features/create/argv.ts and index.ts).
;
; Everything is written under SHCTX, so a per-user install touches only HKCU and a per-machine install only HKLM,
; and the uninstaller removes exactly what was added.

!include "LogicLib.nsh"

; The menu text follows the language the installer ran in ($LANGUAGE is a Windows LCID).
!macro EpdfPickLabels
  StrCpy $R8 "Convert to PDF with Epdf"
  StrCpy $R9 "Combine files in Epdf"
  ${If} $LANGUAGE == 1025
    StrCpy $R8 "تحويل إلى PDF باستخدام Epdf"
    StrCpy $R9 "دمج الملفات في Epdf"
  ${ElseIf} $LANGUAGE == 1036
    StrCpy $R8 "Convertir en PDF avec Epdf"
    StrCpy $R9 "Combiner les fichiers dans Epdf"
  ${ElseIf} $LANGUAGE == 1031
    StrCpy $R8 "Mit Epdf in PDF umwandeln"
    StrCpy $R9 "Dateien in Epdf zusammenführen"
  ${ElseIf} $LANGUAGE == 3082
    StrCpy $R8 "Convertir a PDF con Epdf"
    StrCpy $R9 "Combinar archivos en Epdf"
  ${EndIf}
!macroend

; Register both verbs for one file extension.
!macro EpdfVerbs EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Convert" "" "$R8"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Convert" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Convert" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Convert\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --convert-to-pdf "%1"'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Combine" "" "$R9"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Combine" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Combine" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Combine\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --combine "%1"'
!macroend

!macro EpdfRemoveVerbs EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Convert"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\Epdf.Combine"
!macroend

!macro customInstall
  !insertmacro EpdfPickLabels
  !insertmacro EpdfVerbs "jpg"
  !insertmacro EpdfVerbs "jpeg"
  !insertmacro EpdfVerbs "png"
  !insertmacro EpdfVerbs "tif"
  !insertmacro EpdfVerbs "tiff"
  !insertmacro EpdfVerbs "heic"
  !insertmacro EpdfVerbs "heif"
  !insertmacro EpdfVerbs "doc"
  !insertmacro EpdfVerbs "docx"
  !insertmacro EpdfVerbs "xls"
  !insertmacro EpdfVerbs "xlsx"
  !insertmacro EpdfVerbs "ppt"
  !insertmacro EpdfVerbs "pptx"
  !insertmacro EpdfVerbs "odt"
  !insertmacro EpdfVerbs "ods"
  !insertmacro EpdfVerbs "odp"
  !insertmacro EpdfVerbs "rtf"
  !insertmacro EpdfVerbs "txt"
  !insertmacro EpdfVerbs "csv"
  ; Versions before 1.0.6 added "Combine files in Epdf" to PDFs: installing over one removes it.
  !insertmacro EpdfRemoveVerbs "pdf"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)' ; tell Explorer the associations changed
!macroend

!macro customUnInstall
  !insertmacro EpdfRemoveVerbs "jpg"
  !insertmacro EpdfRemoveVerbs "jpeg"
  !insertmacro EpdfRemoveVerbs "png"
  !insertmacro EpdfRemoveVerbs "tif"
  !insertmacro EpdfRemoveVerbs "tiff"
  !insertmacro EpdfRemoveVerbs "heic"
  !insertmacro EpdfRemoveVerbs "heif"
  !insertmacro EpdfRemoveVerbs "doc"
  !insertmacro EpdfRemoveVerbs "docx"
  !insertmacro EpdfRemoveVerbs "xls"
  !insertmacro EpdfRemoveVerbs "xlsx"
  !insertmacro EpdfRemoveVerbs "ppt"
  !insertmacro EpdfRemoveVerbs "pptx"
  !insertmacro EpdfRemoveVerbs "odt"
  !insertmacro EpdfRemoveVerbs "ods"
  !insertmacro EpdfRemoveVerbs "odp"
  !insertmacro EpdfRemoveVerbs "rtf"
  !insertmacro EpdfRemoveVerbs "txt"
  !insertmacro EpdfRemoveVerbs "csv"
  !insertmacro EpdfRemoveVerbs "pdf"
  ; electron-builder's association step leaves `.pdf`'s default pointing at its (now deleted) "PDF Document" class.
  ; Clear it, but only while it still holds our value, so another program's registration is never touched.
  ReadRegStr $0 SHCTX "Software\Classes\.pdf" ""
  ${If} $0 == "PDF Document"
    DeleteRegValue SHCTX "Software\Classes\.pdf" ""
  ${EndIf}
  ; The updater's download cache (a copy of the last installer, ~130 MB) is not needed once Epdf is gone.
  RMDir /r "$LOCALAPPDATA\epdf-updater"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
