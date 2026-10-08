$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }
$dataRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'LineCallYomiProbe'))
[void][IO.Directory]::CreateDirectory($dataRoot)
$rootItem = Get-Item -LiteralPath $dataRoot -Force
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Data directory must not be a link.' }
$items = @($rootItem) + @(Get-ChildItem -LiteralPath $dataRoot -Force -Recurse)
foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Data directory contains a link.' }
}
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
foreach ($item in $items) {
    if ($item.PSIsContainer) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $systemSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
}
Write-Output 'Local data ACL protected.'
