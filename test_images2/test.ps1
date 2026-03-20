$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('D:\Application files - Do not delete\github\WhatsApp-Print-Manager\test_images2')
$folder.Items().InvokeVerbEx('Print')
Write-Host "Started..."
Start-Sleep -Seconds 10
Write-Host "Done"