; Inno Setup script — wraps dist/studio into ShortsAutopilotStudio-Setup.exe (built by .github/workflows/studio.yml)
#define AppVer GetEnv("STUDIO_VERSION")
[Setup]
AppId={{8F1C6E2A-5B4D-4E6B-9C1A-7D3E2F1B0A99}
AppName=Shorts Autopilot Studio
AppVersion={#AppVer}
AppPublisher=Shorts Autopilot
DefaultDirName={localappdata}\Programs\ShortsAutopilotStudio
DefaultGroupName=Shorts Autopilot Studio
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ShortsAutopilotStudio-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\dist\studio\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Shorts Autopilot Studio"; Filename: "{app}\ShortsStudio.exe"
Name: "{userdesktop}\Shorts Autopilot Studio"; Filename: "{app}\ShortsStudio.exe"; Tasks: desktopicon
Name: "{userstartup}\Shorts Autopilot Studio"; Filename: "{app}\ShortsStudio.exe"; Parameters: "--background"; Tasks: startup; Flags: runminimized

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start with Windows (runs your schedules in the background — turn on 'Start automatically' inside Studio)"; GroupDescription: "Automation:"

[Run]
Filename: "{app}\ShortsStudio.exe"; Description: "Launch Shorts Autopilot Studio"; Flags: nowait postinstall skipifsilent
