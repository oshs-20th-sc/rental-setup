param([Parameter(Mandatory=$true)][string]$Target,[switch]$Initialize)
$ErrorActionPreference = 'Stop'
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($me.Value,'S-1-5-18','S-1-5-32-544')
if ($Initialize) {
  if (-not (Test-Path -LiteralPath $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
  $item = Get-Item -LiteralPath $Target -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe private directory' }
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($me)
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($sid in $allowed) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,[System.Security.AccessControl.FileSystemRights]::FullControl,([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Target -AclObject $acl
}
$item = Get-Item -LiteralPath $Target -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
$acl = Get-Acl -LiteralPath $Target
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'Unexpected owner' }
if ($item.PSIsContainer -and -not $acl.AreAccessRulesProtected) { throw 'Private folder must have protected ACL' }
$mine = $false
foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Unexpected ACL principal' }
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -eq $me.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $mine = $true }
}
if (-not $mine) { throw 'Current user requires FullControl' }
