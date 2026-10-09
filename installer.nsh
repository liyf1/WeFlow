; 高 DPI 支持
ManifestDPIAware true

!include "WordFunc.nsh"
!include "nsDialogs.nsh"

!macro customInit
  ; 设置 DPI 感知
  System::Call 'USER32::SetProcessDPIAware()'
!macroend

; ===== 语义检索存储位置（安装器自定义页面） =====
; 用户可选择索引目录与模型目录，写入 $INSTDIR\semantic.ini，应用首次启动时导入。
; 留空表示使用默认的用户数据目录。静默安装/自动升级不显示该页面，也不会覆盖已有设置。
!ifndef BUILD_UNINSTALLER
  Var SemDialog
  Var SemIndexInput
  Var SemModelInput
  Var SemIndexDir
  Var SemModelDir
  Var SemPageShown
!endif

!macro customPageAfterChangeDir
  Page custom SemanticPathsPageCreate SemanticPathsPageLeave

  Function SemanticPathsPageCreate
    ; 重新安装时预填上次的选择
    ${If} $SemIndexDir == ""
      ReadINIStr $SemIndexDir "$INSTDIR\semantic.ini" "paths" "indexDir"
    ${EndIf}
    ${If} $SemModelDir == ""
      ReadINIStr $SemModelDir "$INSTDIR\semantic.ini" "paths" "modelDir"
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "语义检索存储位置" "选择语义索引和嵌入模型的存放目录"
    nsDialogs::Create 1018
    Pop $SemDialog
    ${If} $SemDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 12u "索引目录（每个微信号一个索引文件，大小随聊天记录增长）："
    Pop $0
    ${NSD_CreateText} 0 14u 78% 13u "$SemIndexDir"
    Pop $SemIndexInput
    ${NSD_CreateButton} 80% 13u 20% 15u "浏览..."
    Pop $0
    ${NSD_OnClick} $0 SemanticBrowseIndex

    ${NSD_CreateLabel} 0 40u 100% 12u "模型目录（标准模型约 30 MB，高精度模型约 600 MB）："
    Pop $0
    ${NSD_CreateText} 0 54u 78% 13u "$SemModelDir"
    Pop $SemModelInput
    ${NSD_CreateButton} 80% 53u 20% 15u "浏览..."
    Pop $0
    ${NSD_OnClick} $0 SemanticBrowseModel

    ${NSD_CreateLabel} 0 82u 100% 40u "留空则使用默认的用户数据目录。$\r$\n如果模型目录中已放好离线模型，应用会直接使用，无需联网下载。$\r$\n安装后也可以在应用的「语义检索」页面修改。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function SemanticBrowseIndex
    Pop $0 ; 按钮句柄
    ${NSD_GetText} $SemIndexInput $1
    nsDialogs::SelectFolderDialog "选择索引目录" "$1"
    Pop $1
    ${If} $1 != error
      ${NSD_SetText} $SemIndexInput "$1"
    ${EndIf}
  FunctionEnd

  Function SemanticBrowseModel
    Pop $0 ; 按钮句柄
    ${NSD_GetText} $SemModelInput $1
    nsDialogs::SelectFolderDialog "选择模型目录" "$1"
    Pop $1
    ${If} $1 != error
      ${NSD_SetText} $SemModelInput "$1"
    ${EndIf}
  FunctionEnd

  Function SemanticPathsPageLeave
    ${NSD_GetText} $SemIndexInput $SemIndexDir
    ${NSD_GetText} $SemModelInput $SemModelDir
    StrCpy $SemPageShown "1"
  FunctionEnd
!macroend

!macro writeSemanticPathsIni
  ${If} $SemPageShown == "1"
    ${If} $SemIndexDir != ""
      CreateDirectory "$SemIndexDir"
    ${EndIf}
    ${If} $SemModelDir != ""
      CreateDirectory "$SemModelDir"
    ${EndIf}
    ; 先写入 UTF-16LE BOM，WriteINIStr 才会以 Unicode 写入，避免中文路径乱码
    Delete "$INSTDIR\semantic.ini"
    FileOpen $0 "$INSTDIR\semantic.ini" w
    FileWriteWord $0 0xFEFF
    FileClose $0
    WriteINIStr "$INSTDIR\semantic.ini" "paths" "indexDir" "$SemIndexDir"
    WriteINIStr "$INSTDIR\semantic.ini" "paths" "modelDir" "$SemModelDir"
    FlushINI "$INSTDIR\semantic.ini"
  ${EndIf}
!macroend

; 在安装开始前修正安装目录
!macro preInit
  ; 如果安装目录不以 WeFlow 结尾，自动追加
  ${WordFind} "$INSTDIR" "\" "-1" $R0
  ${If} $R0 != "WeFlow"
    StrCpy $INSTDIR "$INSTDIR\WeFlow"
  ${EndIf}
!macroend

; 安装完成后检测并安装 VC++ Redistributable
!macro customInstall
  !insertmacro writeSemanticPathsIni
  ; 检查 VC++ 2015-2022 x64 是否已安装
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 != "1"
    ; 未安装，显示提示并下载
    MessageBox MB_YESNO|MB_ICONQUESTION "检测到系统缺少 Visual C++ 运行库，这可能导致程序无法正常运行。$\n$\n是否立即下载并安装？（约 24MB）" IDYES downloadVC IDNO skipVC
    
    downloadVC:
      DetailPrint "正在下载 Visual C++ Redistributable..."
      SetOutPath "$TEMP"
      
      ; 从微软官方下载 VC++ Redistributable x64
      inetc::get /TIMEOUT=30000 /CAPTION "下载 Visual C++ 运行库" /BANNER "正在下载，请稍候..." \
        "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe" /END
      Pop $0
      
      ${If} $0 == "OK"
        DetailPrint "下载完成，正在安装..."
        ; 使用 ShellExecute 以管理员权限运行
        ExecShell "runas" '"$TEMP\vc_redist.x64.exe"' "/install /quiet /norestart" SW_HIDE
        ; 等待安装完成
        Sleep 5000
        ; 检查是否安装成功
        ReadRegStr $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
        ${If} $1 == "1"
          DetailPrint "Visual C++ Redistributable 安装成功"
          MessageBox MB_OK|MB_ICONINFORMATION "Visual C++ 运行库安装成功！"
        ${Else}
          MessageBox MB_OK|MB_ICONEXCLAMATION "Visual C++ 运行库安装失败，你可能需要手动安装。"
        ${EndIf}
        Delete "$TEMP\vc_redist.x64.exe"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "下载失败：$0$\n$\n你可以稍后手动下载安装 Visual C++ Redistributable。"
      ${EndIf}
      Goto doneVC
    
    skipVC:
      DetailPrint "用户跳过 Visual C++ Redistributable 安装"
    
    doneVC:
  ${Else}
    DetailPrint "Visual C++ Redistributable 已安装"
  ${EndIf}
!macroend
