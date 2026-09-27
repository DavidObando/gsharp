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
/// Pipeline coverage for <c>[LibraryImport]</c>: issue #4370 warnings reach
/// the run without failing it, and issue #4410's forwarded native-transition
/// attributes translate and compile instead of producing Unsupported gaps.
/// </summary>
public class TranslateStageLibraryImportWarningTests
{
    [Fact]
    public async Task TranslateAndCompile_LibraryImportForwardedAttributes_Passes()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("translate-libraryimport-forwarded-attributes");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Forwarded.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Native.cs"), @"
using System.Runtime.InteropServices;

public static partial class Native
{
    [LibraryImport(""libc"", EntryPoint = ""getpid"")]
    [SuppressGCTransition]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories)]
    public static partial int GetPid();
}");

        string outRoot = NewOutputRoot("translate-libraryimport-forwarded-attributes");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(
            options,
            new IMigrationStage[] { new TranslateStage(), new CompileStage() });
        var app = new CorpusApp("test/LibraryImportForwardedAttributes", projectPath, TargetKind.Library);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(appResult.Succeeded, appResult.FailureCategory);

        string translated = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "*.gs", SearchOption.AllDirectories)));
        Assert.Contains("@SuppressGCTransition", translated, StringComparison.Ordinal);
        Assert.Contains("@DefaultDllImportSearchPaths", translated, StringComparison.Ordinal);
    }

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
