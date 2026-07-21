using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Xunit;

namespace GSharp.VisualStudio;

public sealed class SharedAssetParityTests
{
    [Fact]
    public void TextMateAssets_AreValidAndLinkedIntoBothExtensions()
    {
        string root = FindRepositoryRoot();
        using JsonDocument package = ReadJson(root, "src", "vscode-gsharp", "package.json");
        JsonElement contributes = package.RootElement.GetProperty("contributes");

        JsonElement language = contributes.GetProperty("languages").EnumerateArray()
            .Single(item => item.GetProperty("id").GetString() == "gsharp");
        Assert.Equal("./language-configuration.json", language.GetProperty("configuration").GetString());

        JsonElement grammarContribution = contributes.GetProperty("grammars").EnumerateArray()
            .Single(item => item.GetProperty("scopeName").GetString() == "source.gsharp");
        Assert.Equal("./syntaxes/gsharp.tmLanguage.json", grammarContribution.GetProperty("path").GetString());

        JsonElement injectionContribution = contributes.GetProperty("grammars").EnumerateArray()
            .Single(item => item.GetProperty("scopeName").GetString() == "markdown.gsharp.codeblock");
        Assert.Equal(
            "gsharp-markdown-injection",
            injectionContribution.GetProperty("language").GetString());
        Assert.Contains(
            contributes.GetProperty("languages").EnumerateArray(),
            item => item.GetProperty("id").GetString() == "gsharp-markdown-injection");
        Assert.Equal("./syntaxes/gsharp-markdown-injection.json", injectionContribution.GetProperty("path").GetString());
        Assert.Contains(
            "text.html.markdown",
            injectionContribution.GetProperty("injectTo").EnumerateArray().Select(item => item.GetString()));
        Assert.Equal(
            "gsharp",
            injectionContribution.GetProperty("embeddedLanguages")
                .GetProperty("meta.embedded.block.gsharp")
                .GetString());

        using JsonDocument grammar = ReadJson(
            root, "src", "vscode-gsharp", "syntaxes", "gsharp.tmLanguage.json");
        Assert.Equal("source.gsharp", grammar.RootElement.GetProperty("scopeName").GetString());
        Assert.Contains(
            "gs",
            grammar.RootElement.GetProperty("fileTypes").EnumerateArray().Select(item => item.GetString()));
        Assert.NotEqual(0, grammar.RootElement.GetProperty("patterns").GetArrayLength());

        using JsonDocument configuration = ReadJson(
            root, "src", "vscode-gsharp", "language-configuration.json");
        Assert.Equal(
            "//",
            configuration.RootElement.GetProperty("comments").GetProperty("lineComment").GetString());
        Assert.NotEqual(0, configuration.RootElement.GetProperty("brackets").GetArrayLength());
        Assert.NotEqual(0, configuration.RootElement.GetProperty("autoClosingPairs").GetArrayLength());

        using JsonDocument injection = ReadJson(
            root, "src", "vscode-gsharp", "syntaxes", "gsharp-markdown-injection.json");
        Assert.Equal("L:text.html.markdown", injection.RootElement.GetProperty("injectionSelector").GetString());
        JsonElement fencedBlock = injection.RootElement.GetProperty("repository")
            .GetProperty("gsharp-code-block");
        var fencePattern = new Regex(fencedBlock.GetProperty("begin").GetString()!, RegexOptions.Multiline);
        Assert.Matches(fencePattern, "```gsharp");
        Assert.Matches(fencePattern, "~~~gs title=sample");
        JsonElement embeddedBlock = fencedBlock.GetProperty("patterns")[0];
        Assert.Equal("meta.embedded.block.gsharp", embeddedBlock.GetProperty("contentName").GetString());
        Assert.Equal(
            "source.gsharp",
            embeddedBlock.GetProperty("patterns")[0].GetProperty("include").GetString());

        XDocument project = XDocument.Load(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "VsGsharp.csproj"));
        AssertSharedContent(
            project,
            @"..\..\..\vscode-gsharp\syntaxes\gsharp.tmLanguage.json",
            @"Grammars\gsharp.tmLanguage.json");
        AssertSharedContent(
            project,
            @"..\..\..\vscode-gsharp\syntaxes\gsharp-markdown-injection.json",
            @"Grammars\gsharp-markdown-injection.json");
        AssertSharedContent(
            project,
            @"..\..\..\vscode-gsharp\language-configuration.json",
            @"Grammars\language-configuration.json");

        string pkgdef = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "GSharp.TextMate.pkgdef"));
        Assert.Contains(@"$RootKey$\TextMate\Repositories]", pkgdef);
        Assert.Contains(@"""source.gsharp""=""$PackageFolder$\Grammars\language-configuration.json""", pkgdef);
        Assert.Contains(@"""gsharp""=""$PackageFolder$\Grammars\language-configuration.json""", pkgdef);
    }

    [Fact]
    public void GeneratedSnippetsAndThemes_MatchVsCodeSources()
    {
        string root = FindRepositoryRoot();

        using JsonDocument snippets = ReadJson(root, "src", "vscode-gsharp", "snippets", "gsharp.json");
        string[] sourceShortcuts = snippets.RootElement.EnumerateObject()
            .Select(property => FirstString(property.Value.GetProperty("prefix")))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] visualStudioShortcuts = Directory.GetFiles(
                Path.Combine(root, "src", "vs-gsharp", "snippets"),
                "*.snippet")
            .Select(path => XDocument.Load(path).Descendants()
                .Single(element => element.Name.LocalName == "Shortcut").Value)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(sourceShortcuts, visualStudioShortcuts);

        using JsonDocument package = ReadJson(root, "src", "vscode-gsharp", "package.json");
        JsonElement contributes = package.RootElement.GetProperty("contributes");
        JsonElement snippetContribution = contributes.GetProperty("snippets").EnumerateArray().Single();
        Assert.Equal("gsharp", snippetContribution.GetProperty("language").GetString());
        Assert.Equal("./snippets/gsharp.json", snippetContribution.GetProperty("path").GetString());

        JsonElement[] themeContributions = contributes.GetProperty("themes").EnumerateArray().ToArray();
        Assert.Equal(6, themeContributions.Length);
        foreach (JsonElement contribution in themeContributions)
        {
            string relativePath = contribution.GetProperty("path").GetString()!
                .TrimStart('.')
                .Replace('/', Path.DirectorySeparatorChar)
                .TrimStart(Path.DirectorySeparatorChar);
            string sourcePath = Path.Combine(root, "src", "vscode-gsharp", relativePath);
            Assert.True(File.Exists(sourcePath), $"Missing contributed theme '{relativePath}'.");
            using JsonDocument sourceTheme = JsonDocument.Parse(File.ReadAllText(sourcePath));
            string expectedUiTheme = sourceTheme.RootElement.GetProperty("type").GetString() == "dark"
                ? "vs-dark"
                : "vs";
            Assert.Equal(expectedUiTheme, contribution.GetProperty("uiTheme").GetString());
        }

        string[] sourceThemePaths = Directory.GetFiles(
            Path.Combine(root, "src", "vscode-gsharp", "themes"),
            "*.json");
        Assert.Equal(6, sourceThemePaths.Length);

        string[] sourceThemeNames = sourceThemePaths
            .Select(path => ReadJsonString(path, "name"))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] contributedThemeNames = themeContributions
            .Select(theme => theme.GetProperty("label").GetString()!)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(sourceThemeNames, contributedThemeNames);

        string[] visualStudioThemeNames = Directory.GetFiles(
                Path.Combine(root, "src", "vs-gsharp", "themes"),
                "*.vstheme")
            .Select(path => XDocument.Load(path).Descendants()
                .Single(element => element.Name.LocalName == "Theme")
                .Attribute("Name")!.Value)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(sourceThemeNames, visualStudioThemeNames);

        XDocument project = XDocument.Load(Path.Combine(
            root, "src", "vs-gsharp", "src", "VsGsharp", "VsGsharp.csproj"));
        AssertSharedContent(
            project,
            @"..\..\snippets\*.snippet",
            @"Snippets\%(Filename)%(Extension)");
        AssertSharedContent(
            project,
            @"..\..\snippets\snippets.pkgdef",
            @"Snippets\snippets.pkgdef");
        AssertSharedContent(
            project,
            @"..\..\themes\GSharp.Themes.pkgdef",
            @"Themes\GSharp.Themes.pkgdef");

        string themePkgdef = File.ReadAllText(Path.Combine(
            root, "src", "vs-gsharp", "themes", "GSharp.Themes.pkgdef"));
        Assert.Equal(
            6,
            Regex.Matches(
                themePkgdef,
                @"(?m)^\[\$RootKey\$\\Themes\\\{[0-9a-f-]+\}\]\r?$").Count);
    }

    [Fact]
    public void SyncSharedAssets_CheckPasses()
    {
        string script = Path.Combine(
            FindRepositoryRoot(), "src", "vs-gsharp", "scripts", "Sync-SharedAssets.ps1");
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-NoLogo");
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-NonInteractive");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("-Check");

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Could not start PowerShell.");
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.True(process.ExitCode == 0, output + Environment.NewLine + error);
        Assert.Contains("Validated ", output);
        Assert.Contains(" snippets and 6 themes.", output);
    }

    [Fact]
    public void TemplatesCommandsAndStatus_AreDeclared()
    {
        string root = FindRepositoryRoot();
        string vsRoot = Path.Combine(root, "src", "vs-gsharp");
        XDocument manifest = XDocument.Load(Path.Combine(
            vsRoot, "src", "VsGsharp", "source.extension.vsixmanifest"));
        Assert.All(
            manifest.Descendants().Where(element => element.Name.LocalName == "InstallationTarget"),
            target => Assert.Equal("[18.0,)", target.Attribute("Version")?.Value));
        string[] assets = manifest.Descendants()
            .Where(element => element.Name.LocalName == "Asset")
            .Select(element => (string)element.Attribute("Type")!)
            .ToArray();
        Assert.Contains("Microsoft.VisualStudio.ProjectTemplate", assets);
        Assert.Contains("Microsoft.VisualStudio.ItemTemplate", assets);
        string[] packageAssets = manifest.Descendants()
            .Where(element =>
                element.Name.LocalName == "Asset" &&
                (string?)element.Attribute("Type") == "Microsoft.VisualStudio.VsPackage")
            .Select(element => (string?)element.Attribute("Path"))
            .Where(path => path != null)
            .Cast<string>()
            .ToArray();
        Assert.Contains(@"Snippets\snippets.pkgdef", packageAssets);
        Assert.Contains(@"Themes\GSharp.Themes.pkgdef", packageAssets);

        XDocument project = XDocument.Load(Path.Combine(vsRoot, "src", "VsGsharp", "VsGsharp.csproj"));
        Assert.Equal(
            4,
            project.Descendants().Count(element =>
                element.Name.LocalName == "Content" &&
                ChildValue(element, "Link")?.StartsWith(@"ProjectTemplates\", StringComparison.Ordinal) == true));
        Assert.Equal(
            4,
            project.Descendants().Count(element =>
                element.Name.LocalName == "Content" &&
                ChildValue(element, "Link")?.StartsWith(@"ItemTemplates\", StringComparison.Ordinal) == true));

        using JsonDocument package = ReadJson(root, "src", "vscode-gsharp", "package.json");
        string[] vscodeCommands = package.RootElement.GetProperty("contributes")
            .GetProperty("commands")
            .EnumerateArray()
            .Select(command => command.GetProperty("command").GetString()!)
            .ToArray();
        Assert.Contains("gsharp.restartServer", vscodeCommands);
        Assert.Contains("gsharp.openOutput", vscodeCommands);
        Assert.Contains("gsharp.reportIssue", vscodeCommands);

        XDocument menus = XDocument.Load(Path.Combine(vsRoot, "src", "VsGsharp", "Menus.vsct"));
        string[] visualStudioCommands = menus.Descendants()
            .Where(element => element.Name.LocalName == "IDSymbol")
            .Select(element => (string)element.Attribute("name")!)
            .ToArray();
        Assert.Contains("RestartServer", visualStudioCommands);
        Assert.Contains("ShowOutput", visualStudioCommands);
        Assert.Contains("ReportIssue", visualStudioCommands);

        string packageSource = File.ReadAllText(Path.Combine(
            vsRoot, "src", "VsGsharp", "GSharpPackage.cs"));
        Assert.Contains("ShowStatusAsync(", packageSource);
        Assert.Contains("typeof(SVsStatusbar)", packageSource);
        Assert.Contains("statusbar.SetText(", packageSource);
    }

    private static JsonDocument ReadJson(string root, params string[] parts)
        => JsonDocument.Parse(File.ReadAllText(
            parts.Aggregate(root, (path, part) => Path.Combine(path, part))));

    private static string ReadJsonString(string path, string property)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.GetProperty(property).GetString()!;
    }

    private static string FirstString(JsonElement value)
        => value.ValueKind == JsonValueKind.Array
            ? value[0].GetString()!
            : value.GetString()!;

    private static void AssertSharedContent(XDocument project, string include, string link)
    {
        XElement item = project.Descendants().Single(element =>
            element.Name.LocalName == "Content" &&
            (string?)element.Attribute("Include") == include);
        Assert.Equal(link, ChildValue(item, "Link"));
        Assert.Equal("true", ChildValue(item, "IncludeInVSIX"));
    }

    private static string? ChildValue(XElement element, string name)
        => element.Attribute(name)?.Value
            ?? element.Elements().SingleOrDefault(child => child.Name.LocalName == name)?.Value;

    private static string FindRepositoryRoot()
    {
        DirectoryInfo? directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        return directory?.FullName
            ?? throw new DirectoryNotFoundException("Could not locate the G# repository.");
    }
}
