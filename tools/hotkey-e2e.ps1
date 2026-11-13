// 端到端验证全局快捷键：切换焦点到记事本，用真实按键触发唤起/隐藏。
// 前置：aura-search 正在运行，且已注册 Ctrl+Alt+Space。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Capture([string]$Path) {
    $s = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $s.Width, $s.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($s.Left, $s.Top, 0, 0, $bmp.Size)
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

function Send-Hotkey {
    [System.Windows.Forms.SendKeys]::SendWait('^% ')
}

$out = 'D:\AI_Work_Space\AURA Search\shots'

# 1) 用记事本取得前台焦点，确保不是搜索窗口自己有焦点
$notepad = Start-Process notepad -PassThru
Start-Sleep -Seconds 2
[System.Windows.Forms.SendKeys]::SendWait('AURA hotkey e2e test')
Start-Sleep -Milliseconds 400
Capture "$out\20-hotkey-notepad-focused.png"
"HOTKEY_1 state=$($notepad.MainWindowTitle)"

# 2) 触发全局快捷键：应该唤起窗口
Send-Hotkey
Start-Sleep -Milliseconds 700
Capture "$out\21-hotkey-shown.png"

# 3) 再按一次：应该隐藏窗口
Send-Hotkey
Start-Sleep -Milliseconds 700
Capture "$out\22-hotkey-hidden.png"

# 4) 第三次：再次唤起
Send-Hotkey
Start-Sleep -Milliseconds 700
Capture "$out\23-hotkey-shown-again.png"

Stop-Process -Id $notepad.Id -Force -ErrorAction SilentlyContinue
"DONE"
