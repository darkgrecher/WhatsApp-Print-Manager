
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace((Get-Location).Path)
$items = $folder.Items()
$items.InvokeVerbEx('Print')

