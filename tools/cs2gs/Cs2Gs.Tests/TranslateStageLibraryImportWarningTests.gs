// <copyright file="TranslateStageLibraryImportWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import System
import System.IO
import System.Threading.Tasks
import Xunit

/// Pipeline coverage for `[LibraryImport]`: issue #4370 warnings reach
/// the run without failing it, and issue #4410's forwarded native-transition
/// attributes translate and compile instead of producing Unsupported gaps.
open class TranslateStageLibraryImportWarningTests {
    @Fact
    async func TranslateAndCompile_LibraryImportForwardedAttributes_Passes() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-libraryimport-forwarded-attributes")
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
        let projectPath = Path.Combine(projectDir, "Forwarded.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`)
        File.WriteAllText(Path.Combine(projectDir, "Native.cs"), `
using System.Runtime.InteropServices;

public static partial class Native
{
    [LibraryImport("libc", EntryPoint = "getpid")]
    [SuppressGCTransition]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories)]
    public static partial int GetPid();
}`)
        let outRoot = NewOutputRoot("translate-libraryimport-forwarded-attributes")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage(), CompileStage()})
        let app = CorpusApp("test/LibraryImportForwardedAttributes", projectPath, TargetKind.Library)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(appResult.Succeeded, appResult.FailureCategory)
        let translated = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "*.gs", SearchOption.AllDirectories))
        )
        Assert.Contains("@SuppressGCTransition", translated, StringComparison.Ordinal)
        Assert.Contains("@DefaultDllImportSearchPaths", translated, StringComparison.Ordinal)
    }

    @Fact
    async func TranslateStage_LibraryImportWarnings_AreForwardedAndTheAppPasses() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("translate-libraryimport-warnings")
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
        let projectPath = Path.Combine(projectDir, "Warned.csproj")
        File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
  </PropertyGroup>
</Project>
`)
        File.WriteAllText(Path.Combine(projectDir, "Native.cs"), `
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

public static partial class Native
{
    [LibraryImport("libc", EntryPoint = "getenv", StringMarshalling = StringMarshalling.Utf8)]
    public static partial string GetEnv(string name);

    [LibraryImport("libc", EntryPoint = "getpid")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(CallConvCdecl) })]
    public static partial int GetPid();
}`)
        let outRoot = NewOutputRoot("translate-libraryimport-warnings")
        let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
        let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
        let app = CorpusApp("test/LibraryImportWarnings", projectPath, TargetKind.Library)
        let result = await pipeline.RunAsync([]CorpusApp{app})
        let appResult = Assert.Single(result.Apps)
        Assert.True(appResult.Succeeded, "A translation warning must not fail the app.")
        let translateLog = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
        )
        Assert.Contains(CSharpToGSharpTranslator.LibraryImportStringReturnDiagnosticId, translateLog)
        Assert.Contains("GetEnv", translateLog)
        Assert.Contains(CSharpToGSharpTranslator.LibraryImportCallConvDiagnosticId, translateLog)
        Assert.Contains("GetPid", translateLog)
    }

    shared {
        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
