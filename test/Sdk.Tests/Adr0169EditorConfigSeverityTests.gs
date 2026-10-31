// <copyright file="Adr0169EditorConfigSeverityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0169: the SDK lowers `.editorconfig`
/// `dotnet_diagnostic.<ID>.severity` entries to `/gsdiag:`
/// switches — chain semantics (deeper overrides), Roslyn severity-name
/// mapping, and section filtering to patterns that can match `.gs`.
open class Adr0169EditorConfigSeverityTests : IDisposable {
    private let root DirectoryInfo

    init() {
        root = Directory.CreateTempSubdirectory("gs-editorconfig-tests")
    }

    func Dispose() {
        try {
            root.Delete(recursive: true)
        } catch (IOException) { }
    }

    @Fact
    func ReadsSeverities_MapsRoslynNames_AndFiltersSections() {
        Write("proj/.editorconfig", `
root = true

[*]
dotnet_diagnostic.GSA0001.severity = error
dotnet_diagnostic.GSA0002.severity = suggestion
dotnet_diagnostic.GSA0003.severity = silent

[*.gs]
dotnet_diagnostic.GSA0004.severity = none

[*.cs]
dotnet_diagnostic.GSA0005.severity = error
`)
        let severities = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "proj"))
        Assert.Equal("error", severities["GSA0001"])
        Assert.Equal("info", severities["GSA0002"])
        Assert.Equal("hidden", severities["GSA0003"])
        Assert.Equal("none", severities["GSA0004"])
        Assert.False(severities.ContainsKey("GSA0005"))
    }

    @Fact
    func DeeperEditorConfig_OverridesAncestor_AndRootStopsTheChain() {
        Write(".editorconfig", `
[*]
dotnet_diagnostic.GSA0001.severity = warning
dotnet_diagnostic.GSA0002.severity = warning
`)
        Write("sub/.editorconfig", `
[*.{cs,gs}]
dotnet_diagnostic.GSA0001.severity = error
`)
        let severities = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "sub"))
        Assert.Equal("error", severities["GSA0001"])
        Assert.Equal("warning", severities["GSA0002"])
        // With root=true in the deeper file, the ancestor is not consulted.
        Write("sub/.editorconfig", `
root = true

[*]
dotnet_diagnostic.GSA0001.severity = error
`)
        let rooted = EditorConfigSeverityReader.ReadSeverities(Path.Combine(root.FullName, "sub"))
        Assert.False(rooted.ContainsKey("GSA0002"))
    }

    /// Issue #5413: a null line from the oblivious File.ReadAllLines result is not
    /// an ordinary NullReferenceException. It stops the read with its own failure.
    @Fact
    func NullLine_StopsTheReadWithADistinctFailure() {
        let severities = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        let lines = []string? {
            "[*] # comment",
            "dotnet_diagnostic.GSA0001.severity = error",
            nil,
            "dotnet_diagnostic.GSA0002.severity = error"
        }
        let failure = Assert.Throws[InvalidDataException](
            () -> EditorConfigSeverityReader.ParseLines("proj/.editorconfig", lines, severities)
        )
        Assert.Equal("The .editorconfig file 'proj/.editorconfig' supplied a null line.", failure.Message)
        Assert.Equal("error", severities["GSA0001"])
        Assert.False(severities.ContainsKey("GSA0002"))
    }

    @Fact
    func BuildTask_EmitsGsDiagArguments() {
        Write("proj/.editorconfig", `
root = true

[*.gs]
dotnet_diagnostic.TESTGSA01.severity = error
`)
        let projectDir = Path.Combine(root.FullName, "proj")
        let task = BuildTask{
            GsharpCompilerFullPath: "missing-gsc.dll",
            OutputPath: ".",
            OutputName: "EditorConfig",
            TempOutputPath: ".",
            TargetFramework: "net10.0",
            BasePath: projectDir,
            OutputType: "Library",
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem](Array.Empty[TaskItem]()),
            ResponseFilePath: Path.Combine(projectDir, "x.rsp"),
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        let arguments = task.CommandLineArgs.Select((item ITaskItem) -> item.ItemSpec!!).ToArray()
        Assert.Contains("/gsdiag:TESTGSA01=error", arguments)
    }

    private func Write(relativePath string, content string) {
        let fullPath = Path.Combine(root.FullName, relativePath)
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!!)
        File.WriteAllText(fullPath, content)
    }
}
