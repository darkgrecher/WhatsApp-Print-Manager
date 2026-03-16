
$paths = 'D:\Application files - Do not delete\github\WhatsApp-Print-Manager\test_images\test1.png','D:\Application files - Do not delete\github\WhatsApp-Print-Manager\test_images\test2.png'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('D:\Application files - Do not delete\github\WhatsApp-Print-Manager\test_images')
foreach ($i in $folder.Items()) {
    if ($paths -contains $i.Path) {
        $i.InvokeVerb('Print')
    }
}

