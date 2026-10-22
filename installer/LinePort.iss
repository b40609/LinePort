#ifndef PayloadRoot
  #error PayloadRoot is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef ReleaseDirectory
  #error ReleaseDirectory is required
#endif

[Setup]
AppId={{DA31D331-3AE0-4F53-A12A-E89EEB54DF49}
AppName=LinePort
AppVersion={#AppVersion}
AppPublisher=Ryan Cheng
AppPublisherURL=https://github.com/b40609/LinePort
AppSupportURL=https://github.com/b40609/LinePort/issues
DefaultDirName={localappdata}\Programs\LinePort
DefaultGroupName=LinePort
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir={#ReleaseDirectory}
OutputBaseFilename=LinePort-v{#AppVersion}-Windows-x64-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
SetupMutex=Local\LinePort.Setup
CloseApplications=no
RestartApplications=no
Uninstallable=not IsSmokeTest
CreateUninstallRegKey=not IsSmokeTest
UninstallDisplayIcon={code:GetPayloadDirectory}\LinePort.exe
VersionInfoVersion=1.0.0.0
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "zhTW"; MessagesFile: "compiler:Languages\ChineseTraditional.isl"

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{code:GetPayloadDirectory}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadRoot}\yomi-probe\package.json"; DestDir: "{app}"; DestName: "installed-package.json"; Flags: ignoreversion
Source: "{#ReleaseDirectory}\installed-version.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\LinePort"; Filename: "{code:GetPayloadDirectory}\LinePort.exe"; WorkingDir: "{code:GetPayloadDirectory}"; Check: not IsSmokeTest
Name: "{autodesktop}\LinePort"; Filename: "{code:GetPayloadDirectory}\LinePort.exe"; WorkingDir: "{code:GetPayloadDirectory}"; Check: not IsSmokeTest

[Run]
Filename: "{code:GetPayloadDirectory}\LinePort.exe"; Description: "啟動 LinePort"; Flags: nowait postinstall skipifsilent; Check: not IsSmokeTest

[Code]
var
  PayloadDirectory: String;

function IsSmokeTest: Boolean;
begin
  { Isolated extraction checks never register, create shortcuts or launch LINE. }
  Result := ExpandConstant('{param:LINEPORTSMOKE|0}') = '1';
end;

function GetPayloadDirectory(Param: String): String;
var
  Base: String;
  Index: Integer;
begin
  if PayloadDirectory = '' then begin
    Base := ExpandConstant('{app}\versions\{#AppVersion}-') + GetDateTimeString('yyyymmddhhnnss', #0, #0);
    Index := 0;
    PayloadDirectory := Base;
    while DirExists(PayloadDirectory) or FileExists(PayloadDirectory) do begin
      Index := Index + 1;
      PayloadDirectory := Base + '-' + IntToStr(Index);
    end;
  end;
  Result := PayloadDirectory;
end;

function TakePart(var Value: String; Separator: String): String;
var
  Position: Integer;
begin
  Position := Pos(Separator, Value);
  if Position = 0 then begin
    Result := Value;
    Value := '';
  end else begin
    Result := Copy(Value, 1, Position - 1);
    Delete(Value, 1, Position + Length(Separator) - 1);
  end;
end;

function ParseVersion(Value: String; var Parts: TArrayOfInteger): Boolean;
var
  Core, Candidate, Part: String;
  Index: Integer;
begin
  Result := False;
  SetArrayLength(Parts, 5);
  Core := TakePart(Value, '-');
  Candidate := Value;
  for Index := 0 to 2 do begin
    Part := TakePart(Core, '.');
    Parts[Index] := StrToIntDef(Part, -1);
    if Parts[Index] < 0 then exit;
  end;
  if Core <> '' then exit;
  Parts[3] := 1;
  Parts[4] := 0;
  if Candidate <> '' then begin
    if TakePart(Candidate, '.') <> 'rc' then exit;
    Parts[3] := 0;
    Parts[4] := StrToIntDef(Candidate, -1);
    if Parts[4] < 0 then exit;
  end;
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Saved: AnsiString;
  OldParts, NewParts: TArrayOfInteger;
  Index: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\installed-version.txt')) then begin
    if not LoadStringFromFile(ExpandConstant('{app}\installed-version.txt'), Saved) then begin
      Result := '無法讀取既有安裝版本；尚未變更舊程式，請保留此訊息供排查。';
      exit;
    end;
    if not ParseVersion(Trim(String(Saved)), OldParts) or not ParseVersion('{#AppVersion}', NewParts) then begin
      Result := '無法辨識安裝版本；尚未變更舊程式，請保留此訊息供排查。';
      exit;
    end;
    for Index := 0 to 4 do begin
      if OldParts[Index] > NewParts[Index] then begin
        Result := '已安裝較新版本，已阻止降版。請使用桌面上的 LinePort 捷徑。';
        exit;
      end;
      if OldParts[Index] < NewParts[Index] then break;
    end;
  end;
  { Every install gets a fresh directory, including repairs of the same version. }
  GetPayloadDirectory('');
end;
