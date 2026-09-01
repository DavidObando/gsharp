// <copyright file="Issue3782WarningsNotAsErrorsTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Issue #3782: <c>WarningsNotAsErrors</c> is the standard MSBuild property for
/// "keep this id a warning even under <c>TreatWarningsAsErrors</c>", and gsc has
/// always understood the switch it maps to (<c>/warnaserror-:</c>) — only the
/// SDK never plumbed the two together. cs2gs's redundant-<c>!!</c> polish loop
/// needs it: a warnings-as-errors build reports nothing past the first project
/// it fails on, so without a way to demote GS0536 for a survey build the loop
/// advances one project per round and cannot converge on a deep graph.
/// </summary>
public sealed class Issue3782WarningsNotAsErrorsTests : IDisposable
{
    private readonly DirectoryInfo root = Directory.CreateDirectory(
        Path.Combine(Path.GetTempPath(), "gs-3782-" + Guid.NewGuid().ToString("N")));

    [Fact]
    public void BuildTask_ForwardsWarningsNotAsErrors_AsWarnAsErrorMinus()
    {
        string[] arguments = this.Arguments(warningsNotAsErrors: "GS0536");

        Assert.Contains("/warnaserror", arguments);
        Assert.Contains("/warnaserror-:GS0536", arguments);
    }

    [Fact]
    public void BuildTask_OmitsTheSwitchWhenNothingIsDemoted()
    {
        string[] arguments = this.Arguments(warningsNotAsErrors: null);

        Assert.Contains("/warnaserror", arguments);
        Assert.DoesNotContain(arguments, a => a.StartsWith("/warnaserror-:", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("src/Sdk/Gsharp.NET.Sdk/build/Gsharp.NET.Core.Sdk.targets")]
    [InlineData("src/Sdk/Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets")]
    public void Targets_PassTheProperty_AndHashItIntoTheCompileInputs(string relativePath)
    {
        XDocument targets = XDocument.Load(Path.Combine(RepoRoot(), relativePath));

        // Passed to the task, or the switch never reaches gsc...
        Assert.Contains(
            targets.Descendants().Where(e => e.Name.LocalName == "BuildTask"),
            task => (string)task.Attribute("WarningsNotAsErrors") == "$(WarningsNotAsErrors)");

        // ...and hashed into the CoreCompile inputs, or toggling it between two
        // builds of the same tree is a property-only change that MSBuild's
        // up-to-date check skips (issue #1666) — the strict confirmation build
        // would then silently reuse the survey build's output and report
        // nothing at all.
        Assert.Contains(
            targets.Descendants().Where(e => e.Name.LocalName == "_GsharpCoreCompileInputsToHash"),
            item => (string)item.Attribute("Include") == "$(WarningsNotAsErrors)");
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (this.root.Exists)
        {
            this.root.Delete(recursive: true);
        }
    }

    private static string RepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "GSharp.sln")))
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);
        return directory!.FullName;
    }

    private string[] Arguments(string warningsNotAsErrors)
    {
        var task = new BuildTask
        {
            GsharpCompilerFullPath = "missing-gsc.dll",
            OutputPath = ".",
            OutputName = "Demote",
            TempOutputPath = ".",
            TargetFramework = "net10.0",
            BasePath = this.root.FullName,
            OutputType = "Library",
            TreatWarningsAsErrors = "true",
            WarningsNotAsErrors = warningsNotAsErrors,
            Compile = new[] { new TaskItem("Program.gs") },
            References = Array.Empty<TaskItem>(),
            ResponseFilePath = Path.Combine(this.root.FullName, "demote.rsp"),
            SkipCompilerExecution = "true",
            ProvideCommandLineArgs = "true",
        };

        Assert.True(task.Execute());
        return task.CommandLineArgs.Select(item => item.ItemSpec).ToArray();
    }
}
