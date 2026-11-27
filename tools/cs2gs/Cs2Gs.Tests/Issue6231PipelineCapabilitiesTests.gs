// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.IO.Compression
import System.Linq
import System.Threading.Tasks
import Xunit

class Issue6231PipelineCapabilitiesTests {
    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    async func NativeTranslation_UsesResolvedCompilerForCallsAndSnippets(supported bool, snippet bool) {
        let root = NewRoot()
        try {
            let source = if snippet {
                AnalyzerSource.Replace(
                    "SNIPPET_LITERAL",
                    Microsoft.CodeAnalysis.CSharp.SymbolDisplay.FormatLiteral(ConditionalSource, quote: true)
                )
            } else {
                ConditionalSource
            }
            let projectDirectory = Path.Combine(root, "source")
            Directory.CreateDirectory(projectDirectory)
            let sourcePath = Path.Combine(projectDirectory, "Probe.cs")
            File.WriteAllText(sourcePath, source)
            let projectPath = Path.Combine(projectDirectory, "Probe.csproj")
            File.WriteAllText(projectPath, ProjectSource)
            let loaded = CSharpProjectLoader.LoadInMemory([](string, string){(sourcePath, source)})
            let cachedProject = LoadedCSharpProject(
                loaded.Compilation,
                loaded.Documents,
                loaded.LoadDiagnostics,
                projectDirectory: projectDirectory,
                projectPath: projectPath
            )
            Assert.Empty(
                loaded
                    .Compilation
                    .GetDiagnostics()
                    .Where(
                    (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity ==
                    Microsoft.CodeAnalysis.DiagnosticSeverity.Error
                )
            )
            let resolvedCompiler = WriteCompiler(root, "resolved", supported)
            let options = PipelineOptions{
                CompileViaSdk: false,
                GscPath: WriteCompiler(root, "unused-option", !supported),
                RepositoryLoadedProjects: Dictionary[string, LoadedCSharpProject](StringComparer.OrdinalIgnoreCase){
                    [projectPath] = cachedProject
                }
            }
            let app = CorpusApp("test/capabilities", projectPath, TargetKind.Library)
            let context = NewContext(root, app, options, resolvedCompiler)
            let outcome = await TranslateStage().ExecuteAsync(context)
            Assert.Equal(
                if supported {
                    StageStatus.Passed
                } else {
                    StageStatus.Failed
                },
                outcome.Status
            )
            if supported {
                let emitted = string.Join(
                    "\n",
                    Directory.GetFiles(context.ProjectOutputDir, "*.gs", SearchOption.AllDirectories).Select(
                        (path string) -> File.ReadAllText(path)
                    )
                )
                Assert.Matches("@file:\\s*DefineSymbol", emitted)
            } else {
                Assert.Contains(
                    outcome.Artifacts,
                    (artifact TriageArtifact) -> artifact.Diagnostic?.Id ==
                    CSharpToGSharpTranslator.ConditionalSymbolsDiagnosticId
                )
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func SdkCapability_UsesSelectedArchiveInsteadOfStaleGlobalExtraction(supported bool) {
        let root = NewRoot()
        let originalSourceRoot = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable
        )
        let originalPackagesRoot = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
        try {
            WriteSdkPackage(root, supported)
            let packages = Path.Combine(root, "global-packages")
            let compilerDirectory = Path.Combine(packages, "gsharp.net.sdk", "0.0.0-issue6231", "tools", "compiler")
            Directory.CreateDirectory(compilerDirectory)
            File.WriteAllBytes(Path.Combine(compilerDirectory, "GSharp.Core.dll"), CompilerImage(!supported))
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, root)
            Environment.SetEnvironmentVariable("NUGET_PACKAGES", packages)
            Assert.Equal(
                supported,
                SdkCompilerCapabilities.SupportsScopedConditionalSymbols("Release", "0.0.0-issue6231")
            )
        } finally {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                originalSourceRoot
            )
            Environment.SetEnvironmentVariable("NUGET_PACKAGES", originalPackagesRoot)
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func SdkCapability_DetectsScopedConditionalSymbolsInRealPackedSdk() {
        let repoRoot = GsharpTestProjectRunner.FindAssemblyRepoRoot()
        Assert.False(string.IsNullOrEmpty(repoRoot))
        let sdk = GsharpTestProjectRunner.ResolveLocalPackage(repoRoot, "Gsharp.NET.Sdk", "Release")
        if sdk == nil {
            Assert.Fail("Expected a locally packed Gsharp.NET.Sdk package.")
            return
        }
        Assert.True(SdkCompilerCapabilities.SupportsScopedConditionalSymbolsInPackage(sdk.Version, sdk.NupkgPath))
        Assert.True(SdkCompilerCapabilities.SupportsScopedConditionalSymbols("Release", sdk.Version))
    }

    @Theory
    @InlineData("tools/compiler//GSharp.Core.dll", true)
    @InlineData("tools/compiler//GSharp.Core.dll", false)
    @InlineData("tools\\compiler\\GSharp.Core.dll", true)
    @InlineData("tools\\compiler\\GSharp.Core.dll", false)
    func SdkCapability_HandlesNonNormalizedArchiveEntryPaths(entryPath string, supported bool) {
        let root = NewRoot()
        try {
            let packagePath = WriteSdkPackage(root, supported, entryPath)
            Assert.Equal(
                supported,
                SdkCompilerCapabilities.SupportsScopedConditionalSymbolsInPackage("0.0.0-issue6256", packagePath)
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func SdkCapability_MatchesNugetCacheVersionCaseInsensitively(supported bool) {
        let root = NewRoot()
        let originalPackagesRoot = Environment.GetEnvironmentVariable("NUGET_PACKAGES")
        try {
            let packages = Path.Combine(root, "global-packages")
            let compilerDirectory = Path.Combine(packages, "gsharp.net.sdk", "0.0.0-issue6256", "tools", "compiler")
            Directory.CreateDirectory(compilerDirectory)
            File.WriteAllBytes(Path.Combine(compilerDirectory, "GSharp.Core.dll"), CompilerImage(supported))
            Environment.SetEnvironmentVariable("NUGET_PACKAGES", packages)
            Assert.Equal(
                supported,
                SdkCompilerCapabilities.SupportsScopedConditionalSymbolsInPackage("0.0.0-Issue6256", nil)
            )
        } finally {
            Environment.SetEnvironmentVariable("NUGET_PACKAGES", originalPackagesRoot)
            Directory.Delete(root, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    async func LibraryParity_UsesSelectedSdkBeforeTranslatingTests(supported bool) {
        let root = NewRoot()
        try {
            let projectPath = Path.Combine(root, "Probe.Tests.csproj")
            File.WriteAllText(projectPath, ProjectSource)
            File.WriteAllText(Path.Combine(root, "Probe.cs"), ConditionalSource)
            let baselinePath = Path.Combine(root, "baseline.json")
            File.WriteAllText(
                baselinePath,
                "{\"schemaVersion\":\"1.0\",\"app\":\"Probe.Tests\",\"framework\":\"xunit\"," +
                    "\"total\":0,\"passed\":0,\"failed\":0,\"skipped\":0,\"tests\":[]}"
            )
            WriteSdkPackage(root, supported)
            let app = CorpusApp(
                "test/capabilities",
                projectPath,
                TargetKind.Library,
                testsProjectPath: projectPath,
                testsBaselinePath: baselinePath
            )
            let runner = CapturingTestRunner(root)
            let context = NewContext(root, app, PipelineOptions(), Path.Combine(root, "unused-gsc.dll"))
            let outcome = await TestParityStage(runner).ExecuteAsync(context)
            Assert.Equal(StageStatus.Skipped, outcome.Status)
            if supported {
                let project = Assert.IsType[GsharpTestProject](runner.Project)
                Assert.Equal("0.0.0-issue6231", project.SdkVersion)
                Assert.Contains(
                    project.TestFiles,
                    (file GsharpSourceFile) -> file.Source.Contains("@file:DefineSymbol", StringComparison.Ordinal)
                )
            } else {
                Assert.Null(runner.Project)
            }
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    private class CapturingTestRunner : GsharpTestProjectRunner {
        init(root string) : base(root) { }

        internal prop Project GsharpTestProject? {
            get;
            private set;
        }

        override func Run(project GsharpTestProject, workDir string) GsharpTestRunResult {
            this.Project = project
            return GsharpTestRunResult.Unavailable("Captured translation; no test execution claimed.")
        }
    }

    shared {
        private func NewRoot() string {
            let root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".cache",
                "gsharp-conditional-capabilities",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(root)
            return root
        }

        private func NewContext(
            root string,
            app CorpusApp,
            options PipelineOptions,
            compiler string
        ) StageExecutionContext {
            let output = Path.Combine(root, "translated")
            Directory.CreateDirectory(output)
            return StageExecutionContext(
                app,
                options,
                GscInvoker(compiler),
                output,
                TriageBuilder("capabilities", "2026-11-26T00:00:00Z", "fixture", app.Id)
            )
        }

        private func WriteCompiler(root string, name string, supported bool) string {
            let directory = Path.Combine(root, name)
            Directory.CreateDirectory(directory)
            File.WriteAllBytes(Path.Combine(directory, "GSharp.Core.dll"), CompilerImage(supported))
            return Path.Combine(directory, "gsc.dll")
        }

        private func WriteSdkPackage(
            root string,
            supported bool,
            entryPath string = "tools/compiler/GSharp.Core.dll"
        ) string {
            let packageDir = Path.Combine(root, "out", "bin", "Release", "nupkgs")
            Directory.CreateDirectory(packageDir)
            let packagePath = Path.Combine(packageDir, "Gsharp.NET.Sdk.0.0.0-issue6231.nupkg")
            using let archive = ZipFile.Open(packagePath, ZipArchiveMode.Create)
            using let stream = archive.CreateEntry(entryPath).Open()
            let image = CompilerImage(supported)
            stream.Write(image, 0, image.Length)
            return packagePath
        }

        private func CompilerImage(supported bool)[]uint8 {
            let visibility = if supported {
                "public"
            } else {
                "internal"
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){
                    (
                        "Marker.cs",
                        "namespace GSharp.Core.CodeAnalysis { " + visibility + " class ConditionalSymbols {} }"
                    )
                }
            )
            using let image = MemoryStream()
            let result = project.Compilation.Emit(image)
            Assert.True(result.Success, string.Join("\n", result.Diagnostics))
            return image.ToArray()
        }

        private const ProjectSource string = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
</Project>`

        private const ConditionalSource string = `#define ACTIVE
public static class Probe
{
    [System.Diagnostics.Conditional("ACTIVE")]
    private static void Log() { }
    public static void Run() { Log(); }
}`

        private const AnalyzerSource string = `using System.Collections.Immutable;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
namespace Sample.Tests;
[DiagnosticAnalyzer(LanguageNames.CSharp)]
public sealed class ProbeAnalyzer : DiagnosticAnalyzer
{
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics
        => ImmutableArray<DiagnosticDescriptor>.Empty;
    public override void Initialize(AnalysisContext context) { }
}
internal static class AnalyzerTestHelper
{
    public static Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source)
        => Task.CompletedTask;
}
public sealed class Tests
{
    public Task Reports()
    {
        const string Source = SNIPPET_LITERAL;
        return AnalyzerTestHelper.AssertDiagnosticsAsync(new ProbeAnalyzer(), Source);
    }
}`
    }
}
