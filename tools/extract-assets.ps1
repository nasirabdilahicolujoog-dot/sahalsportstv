Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'assets\reference-layout.png'))
$crops = @(
    @{Name='brand_mark'; X=53; Y=17; W=185; H=184},
    @{Name='brand_lockup'; X=323; Y=294; W=134; H=126},
    @{Name='featured_match'; X=528; Y=334; W=204; H=139},
    @{Name='splash_art'; X=30; Y=285; W=211; H=411},
    @{Name='trophy'; X=1032; Y=749; W=180; H=161},
    @{Name='zaad'; X=995; Y=204; W=103; H=46},
    @{Name='edahab'; X=1116; Y=203; W=109; H=47}
)
foreach ($crop in $crops) {
    $bitmap = New-Object System.Drawing.Bitmap($crop.W, $crop.H)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0,0,$crop.W,$crop.H), [System.Drawing.Rectangle]::new($crop.X,$crop.Y,$crop.W,$crop.H), [System.Drawing.GraphicsUnit]::Pixel)
    $path = Join-Path $root ('assets\' + $crop.Name + '.png')
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Copy-Item $path (Join-Path $root ('android\app\src\main\res\drawable-nodpi\' + $crop.Name + '.png'))
    $graphics.Dispose()
    $bitmap.Dispose()
}
$source.Dispose()
