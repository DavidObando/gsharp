// <copyright file="Issue3782WarningsNotAsErrorsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.IO
import System.Linq
import System.Xml.Linq
import GSharp.Tests
import Gsharp.NET.Sdk.Tools
import Microsoft.Build.Utilities
import Xunit
import Microsoft.Build.Framework

/// Issue #3782: `WarningsNotAsErrors` is the standard MSBuild property for
/// "keep this id a warning even under `TreatWarningsAsErrors`", and gsc has
/// always understood the switch it maps to (`/warnaserror-:`) — only the
/// SDK never plumbed the two together. cs2gs's redundant-`!!` polish loop
/// needs it: a warnings-as-errors build reports nothing past the first project
/// it fails on, so without a way to demote GS0536 for a survey build the loop
/// advances one project per round and cannot converge on a deep graph.
class Issue3782WarningsNotAsErrorsTests : IDisposable {
    private let root DirectoryInfo = Directory.CreateDirectory(
        Path.Combine(Path.GetTempPath(), "gs-3782-" + Guid.NewGuid().ToString("N"))
    )

    @Fact
    func BuildTask_ForwardsWarningsNotAsErrors_AsWarnAsErrorMinus() {
        let arguments = this.Arguments(warningsNotAsErrors: "GS0536")
        Assert.Contains("/warnaserror", arguments)
        Assert.Contains("/warnaserror-:GS0536", arguments)
    }

    @Fact
    func BuildTask_OmitsTheSwitchWhenNothingIsDemoted() {
        let arguments = this.Arguments(warningsNotAsErrors: nil)
        Assert.Contains("/warnaserror", arguments)
        Assert.DoesNotContain(arguments, (a string) -> a.StartsWith("/warnaserror-:", StringComparison.Ordinal))
    }

    @Theory
    @InlineData("src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets")
    @InlineData("src/Sdk/Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets")
    func Targets_PassTheProperty_AndHashItIntoTheCompileInputs(relativePath string) {
        let targets = XDocument.Load(Path.Combine(Issue3782WarningsNotAsErrorsTests.RepoRoot(), relativePath))
        // Passed to the task, or the switch never reaches gsc...
        Assert.Contains(
            targets.Descendants().Where((e XElement) -> e.Name.LocalName == "BuildTask"),
            (task XElement) -> string(task.Attribute(XName?("WarningsNotAsErrors")!!)) == "$$(WarningsNotAsErrors)"
        )
        // ...and hashed into the CoreCompile inputs, or toggling it between two
        // builds of the same tree is a property-only change that MSBuild's
        // up-to-date check skips (issue #1666) — the strict confirmation build
        // would then silently reuse the survey build's output and report
        // nothing at all.
        Assert.Contains(
            targets.Descendants().Where((e XElement) -> e.Name.LocalName == "_GsharpCoreCompileInputsToHash"),
            (item XElement) -> string(item.Attribute(XName?("Include")!!)) == "$$(WarningsNotAsErrors)"
        )
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        if this.root.Exists {
            this.root.Delete(recursive: true)
        }
    }

    private func Arguments(warningsNotAsErrors string?)[]string? {
        let task = BuildTask{
            GsharpCompilerFullPath: "missing-gsc.dll",
            OutputPath: ".",
            OutputName: "Demote",
            TempOutputPath: ".",
            TargetFramework: "net10.0",
            BasePath: this.root.FullName,
            OutputType: "Library",
            TreatWarningsAsErrors: "true",
            WarningsNotAsErrors: warningsNotAsErrors,
            Compile: cast[[]ITaskItem]([]TaskItem{TaskItem("Program.gs")}),
            References: cast[[]ITaskItem](Array.Empty[TaskItem]()),
            ResponseFilePath: Path.Combine(this.root.FullName, "demote.rsp"),
            SkipCompilerExecution: "true",
            ProvideCommandLineArgs: "true"
        }
        Assert.True(task.Execute())
        return task.CommandLineArgs.Select((item ITaskItem) -> item.ItemSpec).ToArray()
    }

    shared {
        private func RepoRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return directory!!.FullName
        }
    }
}
