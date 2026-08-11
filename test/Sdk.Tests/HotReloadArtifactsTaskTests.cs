// <copyright file="HotReloadArtifactsTaskTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Gsharp.NET.Sdk.Tools;
using Microsoft.Build.Utilities;
using Xunit;

namespace GSharp.Sdk.Tests;

/// <summary>
/// Tests SDK-generated hot-reload bootstrap and manifest artifacts.
/// </summary>
public class HotReloadArtifactsTaskTests
{
    [Fact]
    public void Execute_WritesDeterministicRelativeBootstrapAndHashedManifest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "gsharp-hot-reload-task-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);

        try
        {
            var project = Path.Combine(directory, "App.gsproj");
            var source = Path.Combine(directory, "Program.gs");
            var manifest = Path.Combine(directory, "obj", "App$Debug.manifest");
            var bootstrap = Path.Combine(directory, "obj", "Bootstrap.g.gs");
            var runtime = Path.Combine(directory, "tools", "Gsharp.HotReload.Runtime.dll");
            File.WriteAllText(project, "<Project />");
            File.WriteAllText(source, "package App");
            Directory.CreateDirectory(Path.Combine(directory, "tools"));
            File.WriteAllText(runtime, "runtime");

            var task = new WriteGsharpHotReloadArtifactsTask
            {
                ProjectPath = project,
                TargetFramework = "net10.0",
                Configuration = "Debug",
                AssemblyName = "App",
                ManifestPath = manifest,
                BootstrapPath = bootstrap,
                UpdateDirectory = Path.Combine(directory, "obj", "updates"),
                RuntimeAssemblyPath = runtime,
                IntermediateDirectory = Path.Combine(directory, "obj"),
                OutputDirectory = Path.Combine(directory, "bin"),
                WatchFiles = new[] { new TaskItem(source) },
            };

            Assert.True(task.Execute());

            var bootstrapText = File.ReadAllText(bootstrap);
            Assert.Contains("@ModuleInitializer", bootstrapText, StringComparison.Ordinal);
            Assert.Contains("\"App$$Debug.manifest\"", bootstrapText, StringComparison.Ordinal);
            Assert.DoesNotContain(directory, bootstrapText, StringComparison.Ordinal);

            var manifestLines = File.ReadAllLines(manifest);
            Assert.Equal("GSHARP-HOT-RELOAD-1", manifestLines[0]);
            Assert.Contains(manifestLines, line => line.StartsWith("project\t", StringComparison.Ordinal));
            Assert.Contains(manifestLines, line => line.StartsWith("watch\t", StringComparison.Ordinal));
            Assert.DoesNotContain(manifestLines, line => line.EndsWith("\tmissing", StringComparison.Ordinal));
            Assert.Equal(
                "runtime",
                File.ReadAllText(Path.Combine(directory, "bin", "Gsharp.HotReload.Runtime.dll")));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
