// <copyright file="TranslateStageLibraryImportWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4370: a <c>[LibraryImport]</c> translated with a caveat — a
/// <c>string</c> return (C# frees the buffer; gsc treats it as non-owning) or
/// a cdecl-only <c>[UnmanagedCallConv]</c> (differs from gsc's default on
/// 32-bit Windows) — raises a translator WARNING. The Translate stage must
/// forward it to the run (the per-app <c>translate.log</c> and stderr) while
/// the app still passes; before, only Unsupported diagnostics and
/// analyzer-snippet warnings left the translator.
/// </summary>
public class TranslateStageLibraryImportWarningTests
{
    [Fact]
    public async Task TranslateStage_LibraryImportWarnings_AreForwardedAndTheAppPasses()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-libraryimport-warnings");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Warned.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Native.cs"), @"
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

public static partial class Native
{
    [LibraryImport(""libc"", EntryPoint = ""getenv"", StringMarshalling = StringMarshalling.Utf8)]
    public static partial string GetEnv(string name);

    [LibraryImport(""libc"", EntryPoint = ""getpid"")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(CallConvCdecl) })]
    public static partial int GetPid();
}");

        string outRoot = NewOutputRoot("translate-libraryimport-warnings");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });
        var app = new CorpusApp("test/LibraryImportWarnings", projectPath, TargetKind.Library);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(appResult.Succeeded, "A translation warning must not fail the app.");

        string translateLog = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)));
        Assert.Contains(CSharpToGSharpTranslator.LibraryImportStringReturnDiagnosticId, translateLog);
        Assert.Contains("GetEnv", translateLog);
        Assert.Contains(CSharpToGSharpTranslator.LibraryImportCallConvDiagnosticId, translateLog);
        Assert.Contains("GetPid", translateLog);
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
