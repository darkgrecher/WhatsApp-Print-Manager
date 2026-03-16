const { exec } = require("child_process");
const ps = `$shell = New-Object -ComObject Shell.Application; $folder = $shell.Namespace('${process.cwd().replace(/\\/g, "\\\\")}'); $items = $folder.Items(); $items.InvokeVerbEx('Print'); Start-Sleep -Seconds 10`;
console.log(ps);
exec(`powershell -NoProfile -Command "${ps}"`, (e) => {
  if (e) console.error(e);
  console.log("done");
});
