param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UiFixtureDpi {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
if ([UiFixtureDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { throw 'The fixture needs physical window coordinates.' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:EventFile = Join-Path $Directory 'native-events.jsonl'
$script:Clicks = 0
function Record-Event([string]$Kind, $Value) {
  $line = @{kind=$Kind;value=$Value;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($script:EventFile, $line + "`n", [Text.UTF8Encoding]::new($false))
}
function Button([string]$Label, [int]$X, [int]$Y, [int]$Width=120) {
  $b = [Windows.Forms.Button]::new(); $b.Text=$Label; $b.AccessibleName=$Label
  $b.SetBounds($X,$Y,$Width,35); return $b
}
$form = [Windows.Forms.Form]::new(); $form.Text='Pi UI native fixture'; $form.Size=[Drawing.Size]::new(900,760)
$form.StartPosition='CenterScreen'; $form.Font=[Drawing.Font]::new('Segoe UI',12)
$count = [Windows.Forms.Label]::new(); $count.Text='Clicks: 0'; $count.AccessibleName='Click count'; $count.SetBounds(25,15,300,30); $form.Controls.Add($count)
$left = [Windows.Forms.GroupBox]::new(); $left.Text='Left panel'; $left.AccessibleName='Left panel'; $left.SetBounds(20,50,410,210); $form.Controls.Add($left)
$save = Button 'Save' 20 35; $left.Controls.Add($save)
$save.add_Click({$script:Clicks++; $count.Text='Clicks: '+$script:Clicks; Record-Event 'click' 'left'})
$disabled = Button 'Unavailable' 180 35; $disabled.Enabled=$false; $left.Controls.Add($disabled)
$message = [Windows.Forms.TextBox]::new(); $message.AccessibleName='Message'; $message.Text='empty'; $message.SetBounds(20,100,320,32); $left.Controls.Add($message)
$message.add_TextChanged({Record-Event 'value' $message.Text})
$toggle = [Windows.Forms.CheckBox]::new(); $toggle.Text='Toggle'; $toggle.AccessibleName='Toggle'; $toggle.SetBounds(20,150,110,35); $left.Controls.Add($toggle)
$toggle.add_CheckedChanged({Record-Event 'toggle' $toggle.Checked})
$choice = [Windows.Forms.ComboBox]::new(); $choice.AccessibleName='Choice'; $choice.SetBounds(160,150,170,35); $choice.DropDownStyle='DropDownList'
[void]$choice.Items.AddRange([object[]]@('One','Two')); $choice.SelectedIndex=0; $left.Controls.Add($choice)
$choice.add_SelectedIndexChanged({Record-Event 'choice' $choice.Text})
$right = [Windows.Forms.GroupBox]::new(); $right.Text='Right panel'; $right.AccessibleName='Right panel'; $right.SetBounds(450,50,400,210); $form.Controls.Add($right)
$second = Button 'Save' 20 35; $right.Controls.Add($second)
$second.add_Click({$script:Clicks++; $count.Text='Clicks: '+$script:Clicks; Record-Event 'click' 'right'})
$replace = Button 'Replace first control' 20 100 320; $right.Controls.Add($replace)
$replace.add_Click({
  $left.Controls.Remove($save); $save.Dispose(); $script:save = Button 'Save' 55 35; $left.Controls.Add($script:save)
  $script:save.add_Click({$script:Clicks++; $count.Text='Clicks: '+$script:Clicks; Record-Event 'click' 'replacement'})
  Record-Event 'replace' $true
})
$dense = [Windows.Forms.GroupBox]::new(); $dense.Text='Dense controls'; $dense.AccessibleName='Dense controls'; $dense.SetBounds(20,285,830,220); $form.Controls.Add($dense)
for($i=0;$i -lt 24;$i++) {$b = Button ('Item '+($i+1)) (15+($i%6)*132) (35+[Math]::Floor($i/6)*40) 120; $dense.Controls.Add($b)}
$notes = [Windows.Forms.RichTextBox]::new(); $notes.AccessibleName='Scrollable notes'; $notes.ReadOnly=$true; $notes.SetBounds(20,525,395,145)
$notes.Text=((1..80 | ForEach-Object {'Note '+$_}) -join "`n"); $form.Controls.Add($notes)
$notes.add_VScroll({Record-Event 'scroll' $notes.GetCharIndexFromPosition([Drawing.Point]::new(5,5))})
$canvas = [Windows.Forms.Panel]::new(); $canvas.AccessibleName='Canvas'; $canvas.BackColor=[Drawing.Color]::LightBlue; $canvas.SetBounds(450,525,400,145); $form.Controls.Add($canvas)
$target = [Windows.Forms.TextBox]::new(); $target.Text='Coordinate target'; $target.AccessibleName='Coordinate target'; $target.Multiline=$true; $target.ReadOnly=$true; $target.SetBounds(10,10,350,110); $canvas.Controls.Add($target)
$target.add_MouseUp({param($sender,$e)
  $p=$sender.PointToScreen([Drawing.Point]::new($e.X,$e.Y)); $r=$sender.RectangleToScreen($sender.ClientRectangle)
  Record-Event 'pointer' @{label='Coordinate target';x=$p.X;y=$p.Y;center_x=$r.X+$r.Width/2;center_y=$r.Y+$r.Height/2;dpi=$sender.DeviceDpi}
})
$target.add_Click({$script:Clicks++; $count.Text='Clicks: '+$script:Clicks; Record-Event 'click' 'coordinate_target'})
$other = [Windows.Forms.Form]::new(); $other.Text='Pi UI native second fixture'; $other.Size=[Drawing.Size]::new(400,220)
$otherSave = Button 'Save' 25 40; $other.Controls.Add($otherSave)
$otherSave.add_Click({Record-Event 'click' 'other'})
$other.Show(); [void]$form.Handle
@{pid=$PID;window_id=$form.Handle.ToInt64();other_window_id=$other.Handle.ToInt64()} | ConvertTo-Json | Set-Content (Join-Path $Directory 'native-ready.json') -Encoding UTF8
$form.add_FormClosed({$other.Close(); Record-Event 'closed' $true})
[Windows.Forms.Application]::Run($form)
$form.Dispose(); $other.Dispose()
