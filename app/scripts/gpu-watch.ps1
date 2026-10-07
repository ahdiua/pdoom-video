# Prints, about once a second, the GPU's 3D-engine utilisation per process as "name=percent;name=percent".
# webgpu-perf.ts runs this beside a benchmark to see what else was using the GPU while it measured.
# (WMI class names are not localised; the performance counter paths Get-Counter takes are.)
$names = @{}
while ($true) {
  $by = @{}
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*engtype_3D' -and $_.UtilizationPercentage -gt 0 } | ForEach-Object {
      if ($_.Name -match 'pid_(\d+)_') {
        $id = [int]$Matches[1]
        if (-not $names.ContainsKey($id)) { $names[$id] = (Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName }
        $name = if ($names[$id]) { $names[$id] } else { "pid$id" }
        $by[$name] = [double]$by[$name] + [double]$_.UtilizationPercentage
      }
    }
  [Console]::Out.WriteLine((($by.GetEnumerator() | ForEach-Object { "$($_.Key)=$([math]::Round($_.Value, 1))" }) -join ';'))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 700
}
