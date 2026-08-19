// <copyright file="Adr0169EditorConfigSeverityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// ADR-0169: the SDK lowers <c>.editorconfig</c>
/// <c>dotnet_diagnostic.&lt;ID&gt;.severity</c> entries to <c>/gsdiag:</c>
/// switches — chain semantics (deeper overrides), Roslyn severity-name
/// mapping, and section filtering to patterns that can match <c>.gs</c>.
/// </summary>
public class Adr0169EditorConfigSeverityTests : IDisposable
{
    private readonly DirectoryInfo root;

    public Adr0169EditorConfigSeverityTests()
    {
        root = Directory.CreateTempSubdirectory("gs-editorconfig-tests");
    }

    public void Dispose()
    {
        try
        {
            root.Delete(recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void ReadsSeverities_MapsRoslynNames_AndFiltersSections()
    {
        Write("proj/.editorconfig", @"
root = true

[*]
dotnet_diagnostic.GSA0001.severity = error
dotnet_diagnostic.GSA0002.severity = suggestion
dotnet_diagnostic.GSA0003.severity = silent

[*.gs]
dotnet_diagnostic.GSA0004.severity = none

[*.cs]
dotnet_diagnostic.GSA0005.severity = error
");

        var severities = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "proj"));

        Assert.Equal("error", severities["GSA0001"]);
        Assert.Equal("info", severities["GSA0002"]);
        Assert.Equal("hidden", severities["GSA0003"]);
        Assert.Equal("none", severities["GSA0004"]);
        Assert.False(severities.ContainsKey("GSA0005"));
    }

    [Fact]
    public void DeeperEditorConfig_OverridesAncestor_AndRootStopsTheChain()
    {
        Write(".editorconfig", @"
[*]
dotnet_diagnostic.GSA0001.severity = warning
dotnet_diagnostic.GSA0002.severity = warning
");
        Write("sub/.editorconfig", @"
[*.{cs,gs}]
dotnet_diagnostic.GSA0001.severity = error
");

        var severities = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "sub"));

        Assert.Equal("error", severities["GSA0001"]);
        Assert.Equal("warning", severities["GSA0002"]);

        // With root=true in the deeper file, the ancestor is not consulted.
        Write("sub/.editorconfig", @"
root = true

[*]
dotnet_diagnostic.GSA0001.severity = error
");
        var rooted = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "sub"));
        Assert.False(rooted.ContainsKey("GSA0002"));
    }

    [Fact]
    public void BuildTask_EmitsGsDiagArguments()
    {
        Write("proj/.editorconfig", @"
root = true

[*.gs]
dotnet_diagnostic.TESTGSA01.severity = error
");

        var projectDir = Path.Combine(root.FullName, "proj");
        var task = new BuildTask
        {
            GsharpCompilerFullPath = "missing-gsc.dll",
            OutputPath = ".",
            OutputName = "EditorConfig",
            TempOutputPath = ".",
            TargetFramework = "net10.0",
            BasePath = projectDir,
            OutputType = "Library",
            Compile = new[] { new TaskItem("Program.gs") },
            References = Array.Empty<TaskItem>(),
            ResponseFilePath = Path.Combine(projectDir, "x.rsp"),
            SkipCompilerExecution = "true",
            ProvideCommandLineArgs = "true",
        };

        Assert.True(task.Execute());

        var arguments = task.CommandLineArgs.Select(item => item.ItemSpec).ToArray();
        Assert.Contains("/gsdiag:TESTGSA01=error", arguments);
    }

    private void Write(string relativePath, string content)
    {
        var fullPath = Path.Combine(root.FullName, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, content);
    }
}
