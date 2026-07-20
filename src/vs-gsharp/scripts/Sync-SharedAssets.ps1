[CmdletBinding()]
param(
    [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$vsRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..\..'))
$vscodeRoot = Join-Path $repoRoot 'src\vscode-gsharp'
$snippetSourcePath = Join-Path $vscodeRoot 'snippets\gsharp.json'
$themeSourceDir = Join-Path $vscodeRoot 'themes'
$snippetOutputDir = Join-Path $vsRoot 'snippets'
$themeOutputDir = Join-Path $vsRoot 'themes'

$builtInThemeFallbacks = @{
    dark = '1ded0138-47ce-435e-84ef-9ec1f439b749'
    light = 'de3dbbcd-f642-433c-8353-8f1df4370aba'
}

$themeCategoryDefinitions = [ordered]@{
    'Text Editor Language Service Items' = 'e0187991-b458-4f7e-8ca9-42c9a573b56c'
    'Roslyn Text Editor MEF Items' = '75a05685-00a8-4ded-bae5-e7a50bfa929a'
    'Text Editor Text Marker Items' = 'ff349800-ea43-46c1-8c98-878e78f46501'
    'Text Editor Text Manager Items' = '58e96763-1d3b-4e05-b6ba-ff7115fd0b7b'
}

function New-StableGuid {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes("gsharp-vs-shared-assets:$Name")
    $hash = [System.Security.Cryptography.MD5]::Create().ComputeHash($bytes)
    $hash[6] = ($hash[6] -band 0x0F) -bor 0x30
    $hash[8] = ($hash[8] -band 0x3F) -bor 0x80
    return [Guid]::new($hash).ToString()
}

function ConvertTo-Slug {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    $slug = $Text.ToLowerInvariant() -replace '[^a-z0-9]+', '-' -replace '^-+', '' -replace '-+$', ''
    if ([string]::IsNullOrWhiteSpace($slug)) {
        return 'asset'
    }

    return $slug
}

function Escape-Xml {
    param(
        [AllowNull()]
        [string]$Value
    )

    return [System.Security.SecurityElement]::Escape($Value)
}

function Normalize-HexColor {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -isnot [string]) {
        throw "Expected a string hex color but found '$($Value.GetType().FullName)'."
    }

    if ($Value -notmatch '^#?(?<hex>[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$') {
        throw "Unsupported color value '$Value'."
    }

    return '#' + $Matches.hex.ToUpperInvariant()
}

function ConvertTo-VsArgb {
    param(
        [AllowNull()]
        [string]$Color
    )

    if ($null -eq $Color) {
        return $null
    }

    $hex = $Color.TrimStart('#')
    if ($hex.Length -eq 6) {
        return 'FF' + $hex
    }

    return $hex.Substring(6, 2) + $hex.Substring(0, 6)
}

function ConvertTo-PkgDefColorBytes {
    param(
        [AllowNull()]
        [string]$Color
    )

    if ($null -eq $Color -or [string]::IsNullOrWhiteSpace($Color)) {
        return [byte[]](0x00)
    }

    $hex = $Color.TrimStart('#')
    if ($hex.Length -notin 6, 8) {
        throw "Unsupported pkgdef color '$Color'."
    }
    $r = [Convert]::ToByte($hex.Substring(0, 2), 16)
    $g = [Convert]::ToByte($hex.Substring(2, 2), 16)
    $b = [Convert]::ToByte($hex.Substring(4, 2), 16)
    $a = if ($hex.Length -eq 8) { [Convert]::ToByte($hex.Substring(6, 2), 16) } else { [byte]255 }

    $bytes = [System.Collections.Generic.List[byte]]::new()
    $bytes.Add([byte]0x01)
    $bytes.Add($r)
    $bytes.Add($g)
    $bytes.Add($b)
    $bytes.Add($a)
    return $bytes.ToArray()
}

function Convert-GuidToBytes {
    param(
        [Parameter(Mandatory)]
        [string]$GuidText
    )
    return ([Guid]::Parse($GuidText)).ToByteArray()
}

function Encode-AsciiNameBytes {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $nameBytes = [System.Text.Encoding]::ASCII.GetBytes($Name)
    $lengthBytes = [BitConverter]::GetBytes([int]$nameBytes.Length)
    $bytes = [System.Collections.Generic.List[byte]]::new()
    $bytes.AddRange($lengthBytes)
    $bytes.AddRange($nameBytes)
    return $bytes.ToArray()
}

function Resolve-ColorValue {
    param(
        [Parameter(Mandatory)]
        [hashtable[]]$Maps,
        [Parameter(Mandatory)]
        [string[]]$Keys,
        [AllowNull()]
        [string]$Fallback = $null
    )

    foreach ($map in $Maps) {
        foreach ($key in $Keys) {
            if ($map.ContainsKey($key) -and $null -ne $map[$key]) {
                return $map[$key]
            }
        }
    }

    return $Fallback
}

function Get-ObjectMap {
    param(
        [AllowNull()]
        [object]$InputObject
    )

    $map = @{}
    if ($null -eq $InputObject) {
        return $map
    }

    foreach ($property in $InputObject.PSObject.Properties) {
        $map[$property.Name] = $property.Value
    }

    return $map
}

function Get-TokenForegroundMap {
    param(
        [AllowNull()]
        [object[]]$TokenColors
    )

    $map = @{}
    foreach ($entry in @($TokenColors)) {
        if ($null -eq $entry -or $null -eq $entry.settings) {
            continue
        }

        $foreground = Normalize-HexColor $entry.settings.foreground
        if ($null -eq $foreground) {
            continue
        }

        $scopeValues = [System.Collections.Generic.List[string]]::new()
        if ($entry.scope -is [string]) {
            foreach ($scope in ($entry.scope -split ',')) {
                $trimmed = $scope.Trim()
                if ($trimmed) {
                    $scopeValues.Add($trimmed)
                }
            }
        }
        elseif ($entry.scope -is [System.Collections.IEnumerable]) {
            foreach ($scope in $entry.scope) {
                $trimmed = [string]$scope
                if ($trimmed) {
                    $scopeValues.Add($trimmed.Trim())
                }
            }
        }

        foreach ($scope in $scopeValues) {
            if (-not $map.ContainsKey($scope)) {
                $map[$scope] = $foreground
            }
        }
    }

    return $map
}

function Get-SemanticForegroundMap {
    param(
        [AllowNull()]
        [object]$SemanticTokenColors
    )

    $map = @{}
    foreach ($property in @($SemanticTokenColors.PSObject.Properties)) {
        $value = $property.Value
        $foreground = if ($value -is [string]) {
            Normalize-HexColor $value
        }
        else {
            Normalize-HexColor $value.foreground
        }

        if ($null -ne $foreground) {
            $map[$property.Name] = $foreground
        }
    }

    return $map
}

function New-ThemeCategories {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Theme
    )

    $ui = @{}
    foreach ($property in $Theme.colors.PSObject.Properties) {
        $ui[$property.Name] = Normalize-HexColor $property.Value
    }

    $token = Get-TokenForegroundMap -TokenColors $Theme.tokenColors
    $semantic = Get-SemanticForegroundMap -SemanticTokenColors $Theme.semanticTokenColors

    $palette = [ordered]@{
        Background = Resolve-ColorValue @($ui) @('editor.background')
        Foreground = Resolve-ColorValue @($ui) @('editor.foreground')
        Selection = Resolve-ColorValue @($ui) @('editor.selectionBackground')
        InactiveSelection = Resolve-ColorValue @($ui) @('editor.inactiveSelectionBackground', 'editor.selectionBackground')
        CurrentLine = Resolve-ColorValue @($ui) @('editor.lineHighlightBackground', 'editor.background')
        Whitespace = Resolve-ColorValue @($ui) @('editorWhitespace.foreground', 'editorIndentGuide.background1', 'editorLineNumber.foreground')
        LineNumber = Resolve-ColorValue @($ui) @('editorLineNumber.foreground', 'editor.foreground')
        Cursor = Resolve-ColorValue @($ui) @('editorCursor.foreground', 'focusBorder', 'editor.foreground')
        Indent = Resolve-ColorValue @($ui) @('editorIndentGuide.background1', 'editorWhitespace.foreground', 'editorLineNumber.foreground')
        Focus = Resolve-ColorValue @($ui) @('focusBorder', 'button.background', 'editorCursor.foreground')
        BracketBackground = Resolve-ColorValue @($ui) @('editorBracketMatch.background', 'editor.selectionBackground')
        Comment = Resolve-ColorValue @($semantic, $token) @('comment') (Resolve-ColorValue @($ui) @('editorLineNumber.foreground'))
        Number = Resolve-ColorValue @($semantic, $token) @('number', 'constant.numeric') (Resolve-ColorValue @($token) @('constant.language'))
        Keyword = Resolve-ColorValue @($semantic, $token) @('keyword', 'keyword.declaration', 'keyword.modifier', 'keyword.control')
        KeywordControl = Resolve-ColorValue @($semantic, $token) @('keyword.control', 'keyword.control.async', 'keyword') (Resolve-ColorValue @($token) @('keyword'))
        String = Resolve-ColorValue @($semantic, $token) @('string') (Resolve-ColorValue @($token) @('string'))
        Type = Resolve-ColorValue @($semantic, $token) @('type', 'support.type.primitive', 'entity.name.type') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Interface = Resolve-ColorValue @($semantic) @('interface') (Resolve-ColorValue @($semantic, $token) @('type', 'entity.name.type'))
        Struct = Resolve-ColorValue @($semantic) @('struct') (Resolve-ColorValue @($semantic, $token) @('type', 'entity.name.type'))
        Enum = Resolve-ColorValue @($semantic) @('enum') (Resolve-ColorValue @($semantic, $token) @('type', 'entity.name.type'))
        EnumMember = Resolve-ColorValue @($semantic, $token) @('enumMember', 'constant.language') (Resolve-ColorValue @($semantic, $token) @('variable'))
        Namespace = Resolve-ColorValue @($semantic) @('namespace') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Function = Resolve-ColorValue @($semantic, $token) @('function', 'method', 'entity.name.function') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Method = Resolve-ColorValue @($semantic, $token) @('method', 'function', 'entity.name.function') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Parameter = Resolve-ColorValue @($semantic, $token) @('parameter', 'variable') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Variable = Resolve-ColorValue @($semantic, $token) @('variable') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Property = Resolve-ColorValue @($semantic) @('property') (Resolve-ColorValue @($semantic, $token) @('variable'))
        Operator = Resolve-ColorValue @($semantic, $token) @('operator', 'keyword.operator') (Resolve-ColorValue @($ui) @('editor.foreground'))
        Punctuation = Resolve-ColorValue @($token) @('punctuation') (Resolve-ColorValue @($semantic, $token) @('operator'))
    }

    return [ordered]@{
        'Text Editor Language Service Items' = [ordered]@{
            'Comment' = @{ Background = $null; Foreground = $palette.Comment }
            'Number' = @{ Background = $null; Foreground = $palette.Number }
            'Keyword' = @{ Background = $null; Foreground = $palette.Keyword }
            'String' = @{ Background = $null; Foreground = $palette.String }
            'Identifier' = @{ Background = $null; Foreground = $palette.Foreground }
        }
        'Roslyn Text Editor MEF Items' = [ordered]@{
            'xml doc comment - delimiter' = @{ Background = $null; Foreground = $palette.Comment }
            'xml doc comment - text' = @{ Background = $null; Foreground = $palette.Comment }
            'method name' = @{ Background = $null; Foreground = $palette.Method }
            'xml doc comment - name' = @{ Background = $null; Foreground = $palette.Type }
            'class name' = @{ Background = $null; Foreground = $palette.Type }
            'event name' = @{ Background = $null; Foreground = $palette.Function }
            'namespace name' = @{ Background = $null; Foreground = $palette.Namespace }
            'local name' = @{ Background = $null; Foreground = $palette.Variable }
            'field name' = @{ Background = $null; Foreground = $palette.Variable }
            'constant name' = @{ Background = $null; Foreground = $palette.EnumMember }
            'xml doc comment - attribute name' = @{ Background = $null; Foreground = $palette.Parameter }
            'delegate name' = @{ Background = $null; Foreground = $palette.Type }
            'enum name' = @{ Background = $null; Foreground = $palette.Enum }
            'interface name' = @{ Background = $null; Foreground = $palette.Interface }
            'struct name' = @{ Background = $null; Foreground = $palette.Struct }
            'type parameter name' = @{ Background = $null; Foreground = $palette.Type }
            'enum member name' = @{ Background = $null; Foreground = $palette.EnumMember }
            'parameter name' = @{ Background = $null; Foreground = $palette.Parameter }
            'label name' = @{ Background = $null; Foreground = $palette.Variable }
            'keyword - control' = @{ Background = $null; Foreground = $palette.KeywordControl }
            'string - verbatim' = @{ Background = $null; Foreground = $palette.String }
            'xml doc comment - attribute value' = @{ Background = $null; Foreground = $palette.String }
            'property name' = @{ Background = $null; Foreground = $palette.Property }
            'punctuation' = @{ Background = $null; Foreground = $palette.Punctuation }
            'brace matching' = @{ Background = $palette.BracketBackground; Foreground = $palette.Background }
            'HTML Comment' = @{ Background = $null; Foreground = $palette.Comment }
            'Literal' = @{ Background = $null; Foreground = $palette.Number }
            'Number' = @{ Background = $null; Foreground = $palette.Number }
            'HTML Element Name' = @{ Background = $null; Foreground = $palette.Type }
            'HTML Attribute Name' = @{ Background = $null; Foreground = $palette.Parameter }
            'CSS Property Name' = @{ Background = $null; Foreground = $palette.Parameter }
            'CSS Selector' = @{ Background = $null; Foreground = $palette.Type }
            'Operator' = @{ Background = $null; Foreground = $palette.Operator }
            'Preprocessor Keyword' = @{ Background = $null; Foreground = $palette.Keyword }
            'preprocessor text' = @{ Background = $null; Foreground = $palette.String }
            'HTML Attribute Value' = @{ Background = $null; Foreground = $palette.String }
            'CSS Property Value' = @{ Background = $null; Foreground = $palette.Number }
            'outlining.square' = @{ Background = $palette.Background; Foreground = $palette.Indent }
            'outlining.collapsehintadornment' = @{ Background = $palette.CurrentLine; Foreground = $palette.Foreground }
            'CurrentLineActiveFormat' = @{ Background = $palette.CurrentLine; Foreground = $palette.Foreground }
            'Selected Text' = @{ Background = $palette.Selection; Foreground = $null }
            'MarkerFormatDefinition/HighlightedReference' = @{ Background = $palette.Background; Foreground = $palette.Focus }
            'MarkerFormatDefinition/HighlightedDefinition' = @{ Background = $palette.Background; Foreground = $palette.Focus }
            'MarkerFormatDefinition/HighlightedWrittenReference' = @{ Background = $palette.Background; Foreground = $palette.Focus }
            'Line Number' = @{ Background = $null; Foreground = $palette.LineNumber }
            'outlining.verticalrule' = @{ Background = $palette.Indent; Foreground = $palette.Indent }
            'OverviewMarginCaret' = @{ Background = $null; Foreground = $palette.Cursor }
            'OverviewMarginScrollButtonsMouseDown' = @{ Background = $palette.Background; Foreground = $palette.Whitespace }
            'OverviewMarginVisible' = @{ Background = $palette.CurrentLine; Foreground = $palette.CurrentLine }
            'OverviewMarginScrollButtons' = @{ Background = $palette.Background; Foreground = $palette.CurrentLine }
            'OverviewMarginScrollButtonsMouseOver' = @{ Background = $palette.Background; Foreground = $palette.Selection }
            'OverviewMarginBackground' = @{ Background = $palette.Background; Foreground = $null }
            'RazorTagHelperElement' = @{ Background = $null; Foreground = $palette.Type }
            'RazorComponentElement' = @{ Background = $null; Foreground = $palette.Type }
            'RazorTagHelperAttribute' = @{ Background = $null; Foreground = $palette.Parameter }
            'RazorComponentAttribute' = @{ Background = $null; Foreground = $palette.Parameter }
        }
        'Text Editor Text Marker Items' = [ordered]@{
            'Collapsible Text (Collapsed)' = @{ Background = $null; Foreground = $palette.String }
        }
        'Text Editor Text Manager Items' = [ordered]@{
            'Visible Whitespace' = @{ Background = $palette.Background; Foreground = $palette.Whitespace }
            'Plain Text' = @{ Background = $palette.Background; Foreground = $palette.Foreground }
            'Inactive Selected Text' = @{ Background = $palette.InactiveSelection; Foreground = $null }
            'Selected Text' = @{ Background = $palette.Selection; Foreground = $null }
            'Indicator Margin' = @{ Background = $palette.Background; Foreground = $null }
        }
    }
}

function New-ThemePkgDefSection {
    param(
        [Parameter(Mandatory)]
        [string]$ThemeGuid,
        [Parameter(Mandatory)]
        [string]$SectionName,
        [Parameter(Mandatory)]
        [string]$SectionGuid,
        [Parameter(Mandatory)]
        [System.Collections.Specialized.OrderedDictionary]$Colors
    )

    $buffer = [System.Collections.Generic.List[byte]]::new()
    $buffer.AddRange([byte[]](0, 0, 0, 0))
    $buffer.AddRange([byte[]][BitConverter]::GetBytes([int]11))
    $buffer.AddRange([byte[]][BitConverter]::GetBytes([int]1))
    $buffer.AddRange([byte[]](Convert-GuidToBytes $SectionGuid))
    $buffer.AddRange([byte[]][BitConverter]::GetBytes([int]$Colors.Count))

    foreach ($entry in $Colors.GetEnumerator()) {
        $buffer.AddRange([byte[]](Encode-AsciiNameBytes $entry.Key))
        $buffer.AddRange([byte[]](ConvertTo-PkgDefColorBytes $entry.Value.Background))
        $buffer.AddRange([byte[]](ConvertTo-PkgDefColorBytes $entry.Value.Foreground))
    }

    $lengthBytes = [BitConverter]::GetBytes([int]$buffer.Count)
    for ($i = 0; $i -lt 4; $i++) {
        $buffer[$i] = $lengthBytes[$i]
    }

    $hexBytes = $buffer | ForEach-Object { '{0:x2}' -f $_ }
    return "[`$RootKey`$\Themes\{$ThemeGuid}\$SectionName]`r`n`"Data`"=hex:$($hexBytes -join ',')"
}

function New-ThemePkgDef {
    param(
        [Parameter(Mandatory)]
        [object[]]$ThemeDefinitions
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($theme in $ThemeDefinitions) {
        $lines.Add("[`$RootKey`$\Themes\{$($theme.Guid)}]")
        $lines.Add("@=`"$($theme.Name)`"")
        $lines.Add("`"Name`"=`"$($theme.Name)`"")
        $lines.Add("`"Package`"=`"{$($theme.Guid)}`"")
        $lines.Add("`"FallbackId`"=`"{$($theme.FallbackGuid)}`"")

        foreach ($category in $theme.Categories.GetEnumerator()) {
            $lines.Add('')
            $lines.Add((New-ThemePkgDefSection -ThemeGuid $theme.Guid -SectionName $category.Key -SectionGuid $themeCategoryDefinitions[$category.Key] -Colors $category.Value))
        }

        $lines.Add('')
    }

    return ($lines -join "`r`n").Trim() + "`r`n"
}

function New-ThemeXml {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$ThemeDefinition
    )

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.AppendLine('<Themes>')
    [void]$builder.AppendLine("  <Theme Name=`"$(Escape-Xml $ThemeDefinition.Name)`" GUID=`"{$($ThemeDefinition.Guid)}`" FallbackId=`"{$($ThemeDefinition.FallbackGuid)}`">")

    foreach ($category in $ThemeDefinition.Categories.GetEnumerator()) {
        [void]$builder.AppendLine("    <Category Name=`"$(Escape-Xml $category.Key)`" GUID=`"{$($themeCategoryDefinitions[$category.Key])}`">")
        foreach ($color in $category.Value.GetEnumerator()) {
            [void]$builder.AppendLine("      <Color Name=`"$(Escape-Xml $color.Key)`">")
            if ($null -ne $color.Value.Background) {
                [void]$builder.AppendLine("        <Background Type=`"CT_RAW`" Source=`"$(ConvertTo-VsArgb $color.Value.Background)`" />")
            }

            if ($null -ne $color.Value.Foreground) {
                [void]$builder.AppendLine("        <Foreground Type=`"CT_RAW`" Source=`"$(ConvertTo-VsArgb $color.Value.Foreground)`" />")
            }

            [void]$builder.AppendLine('      </Color>')
        }

        [void]$builder.AppendLine('    </Category>')
    }

    [void]$builder.AppendLine('  </Theme>')
    [void]$builder.AppendLine('</Themes>')
    return $builder.ToString()
}

function Convert-VsCodeSnippet {
    param(
        [Parameter(Mandatory)]
        [string]$Title,
        [Parameter(Mandatory)]
        [pscustomobject]$Snippet
    )

    $prefixes = @(
        if ($Snippet.prefix -is [string]) {
            $Snippet.prefix
        }
        elseif ($Snippet.prefix -is [System.Collections.IEnumerable]) {
            $Snippet.prefix | ForEach-Object { [string]$_ }
        }
        else {
            throw "Snippet '$Title' has an unsupported prefix type."
        }
    )

    $shortcut = $prefixes[0]
    $description = [string]$Snippet.description
    if (@($prefixes).Count -gt 1) {
        $description = "$description Alternate shortcuts: $($prefixes -join ', ')."
    }

    $bodyText = if ($Snippet.body -is [string]) {
        [string]$Snippet.body
    }
    else {
        (@($Snippet.body) | ForEach-Object { [string]$_ }) -join "`r`n"
    }

    $placeholders = @{}
    $pattern = '\$\{(?<index>\d+):(?<default>[^}]*)\}|\$(?<simple>\d+)'
    $snippetCode = [System.Text.RegularExpressions.Regex]::Replace(
        $bodyText,
        $pattern,
        [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)

            $index = if ($match.Groups['simple'].Success) {
                [int]$match.Groups['simple'].Value
            }
            else {
                [int]$match.Groups['index'].Value
            }

            if ($index -eq 0) {
                return '$end$'
            }

            $defaultValue = if ($match.Groups['default'].Success) {
                $match.Groups['default'].Value
            }
            else {
                ''
            }

            if ($placeholders.ContainsKey($index)) {
                if ($defaultValue -and $placeholders[$index].Default -and $placeholders[$index].Default -ne $defaultValue) {
                    throw "Snippet '$Title' reuses placeholder '$index' with conflicting defaults."
                }
            }
            else {
                $placeholders[$index] = [pscustomobject]@{
                    Id = "p$index"
                    Default = $defaultValue
                }
            }

            return '$' + $placeholders[$index].Id + '$'
        }
    )
    $snippetCode = $snippetCode -replace '(?m)[ \t]+$', ''

    $declarationsXml = if ($placeholders.Count -eq 0) {
        ''
    }
    else {
        $builder = [System.Text.StringBuilder]::new()
        [void]$builder.AppendLine('      <Declarations>')
        foreach ($index in ($placeholders.Keys | Sort-Object)) {
            $placeholder = $placeholders[$index]
            [void]$builder.AppendLine('        <Literal Editable="true">')
            [void]$builder.AppendLine("          <ID>$($placeholder.Id)</ID>")
            [void]$builder.AppendLine("          <ToolTip>$(Escape-Xml $placeholder.Default)</ToolTip>")
            [void]$builder.AppendLine("          <Default>$(Escape-Xml $placeholder.Default)</Default>")
            [void]$builder.AppendLine('        </Literal>')
        }
        [void]$builder.AppendLine('      </Declarations>')
        $builder.ToString()
    }

    $snippetXml = @"
<?xml version="1.0" encoding="utf-8"?>
<CodeSnippets xmlns="http://schemas.microsoft.com/VisualStudio/2005/CodeSnippet">
  <CodeSnippet Format="1.0.0">
    <Header>
      <Title>$(Escape-Xml $Title)</Title>
      <Shortcut>$(Escape-Xml $shortcut)</Shortcut>
      <Description>$(Escape-Xml $description)</Description>
      <Author>GSharp</Author>
      <SnippetTypes>
        <SnippetType>Expansion</SnippetType>
      </SnippetTypes>
    </Header>
    <Snippet>
$declarationsXml      <Code Language="GSharp"><![CDATA[$snippetCode]]></Code>
    </Snippet>
  </CodeSnippet>
</CodeSnippets>
"@

    return [pscustomobject]@{
        Shortcut = $shortcut
        FileName = "$(ConvertTo-Slug $shortcut)-$(ConvertTo-Slug $Title).snippet"
        Content = $snippetXml
    }
}

function New-SnippetPkgDef {
    return @'
; Register G# code expansion snippets.
[$RootKey$\Languages\CodeExpansions\GSharp\Paths]
"GSharpSnippets"="$PackageFolder$"
'@
}

function Get-ExpectedFiles {
    $expected = [ordered]@{}

    $snippetSource = Get-Content -LiteralPath $snippetSourcePath -Raw | ConvertFrom-Json
    foreach ($property in ($snippetSource.PSObject.Properties | Sort-Object Name)) {
        $generatedSnippet = Convert-VsCodeSnippet -Title $property.Name -Snippet $property.Value
        $expected[(Join-Path $snippetOutputDir $generatedSnippet.FileName)] = $generatedSnippet.Content
    }
    $expected[(Join-Path $snippetOutputDir 'snippets.pkgdef')] = New-SnippetPkgDef

    $themeDefinitions = [System.Collections.Generic.List[object]]::new()
    foreach ($themeFile in (Get-ChildItem -LiteralPath $themeSourceDir -Filter '*.json' | Sort-Object Name)) {
        $theme = Get-Content -LiteralPath $themeFile.FullName -Raw | ConvertFrom-Json
        $themeType = [string]$theme.type
        if (-not $builtInThemeFallbacks.ContainsKey($themeType)) {
            throw "Theme '$($themeFile.Name)' has an unsupported Visual Studio fallback type '$themeType'."
        }

        $themeDefinition = [pscustomobject]@{
            Name = [string]$theme.name
            Guid = New-StableGuid $themeFile.BaseName
            FallbackGuid = $builtInThemeFallbacks[$themeType]
            Categories = New-ThemeCategories -Theme $theme
        }

        $themeDefinitions.Add($themeDefinition)
        $expected[(Join-Path $themeOutputDir ($themeFile.BaseName + '.vstheme'))] = New-ThemeXml -ThemeDefinition $themeDefinition
    }

    $expected[(Join-Path $themeOutputDir 'GSharp.Themes.pkgdef')] = New-ThemePkgDef -ThemeDefinitions $themeDefinitions.ToArray()
    return $expected
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Test-GeneratedFiles {
    param(
        [Parameter(Mandatory)]
        [hashtable]$ExpectedFiles
    )

    $actualGeneratedFiles = @(
        Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.snippet' -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.pkgdef' -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.vstheme' -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.pkgdef' -ErrorAction SilentlyContinue
    ) | ForEach-Object { $_.FullName }

    $expectedPaths = @($ExpectedFiles.Keys)
    $extraFiles = @($actualGeneratedFiles | Where-Object { $expectedPaths -notcontains $_ })
    if (@($extraFiles).Count -gt 0) {
        throw "Unexpected generated files:`r`n$($extraFiles -join "`r`n")"
    }

    foreach ($path in $expectedPaths) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Missing generated file '$path'."
        }

        $actual = [System.IO.File]::ReadAllText($path, $utf8NoBom)
        if ($actual -cne $ExpectedFiles[$path]) {
            throw "Generated file '$path' is out of date. Run Sync-SharedAssets.ps1."
        }
    }
}

function Write-GeneratedFiles {
    param(
        [Parameter(Mandatory)]
        [hashtable]$ExpectedFiles
    )

    foreach ($directory in @($snippetOutputDir, $themeOutputDir)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }

    Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.snippet' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.pkgdef' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.vstheme' -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.pkgdef' -ErrorAction SilentlyContinue | Remove-Item -Force

    foreach ($path in $ExpectedFiles.Keys) {
        Write-Utf8File -Path $path -Content $ExpectedFiles[$path]
    }
}

$expectedFiles = Get-ExpectedFiles
if ($Check) {
    Test-GeneratedFiles -ExpectedFiles $expectedFiles
    Write-Host "Validated $((Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.snippet' -ErrorAction SilentlyContinue).Count) snippets and $((Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.vstheme' -ErrorAction SilentlyContinue).Count) themes."
}
else {
    Write-GeneratedFiles -ExpectedFiles $expectedFiles
    Write-Host "Wrote $((Get-ChildItem -LiteralPath $snippetOutputDir -File -Filter '*.snippet').Count) snippets and $((Get-ChildItem -LiteralPath $themeOutputDir -File -Filter '*.vstheme').Count) themes."
}
