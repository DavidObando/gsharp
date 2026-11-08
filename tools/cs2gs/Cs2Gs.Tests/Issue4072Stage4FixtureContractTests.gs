// <copyright file="Issue4072Stage4FixtureContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Integration coverage for the stage-4 original-source fixture contract.
open class Issue4072Stage4FixtureContractTests {
    @Fact
    func SourceRoot_ProvidesAnalyzerCorpusUnsupportedAndProjectLoadingFixtures() {
        let analyzer string? = TestFixtureSource.Resolve(
            "src",
            "Analyzers",
            "InternalAnalyzers",
            "StructFieldDefsReadAnalyzer.cs"
        )
        Assert.Contains("StructFieldDefsReadAnalyzer", File.ReadAllText(analyzer!!), StringComparison.Ordinal)
        Assert.True(
            File.Exists(TestFixtureSource.Resolve("tools", "cs2gs", "corpus", "L1-Console", "L1-Console.csproj"))
        )
        Assert.True(
            File.Exists(TestFixtureSource.Resolve("tools", "cs2gs", "corpus", "L4-Console", "L4-Console.csproj"))
        )
        let unsupported string? = TestFixtureSource.Resolve(
            "tools",
            "cs2gs",
            "Cs2Gs.Tests",
            "Fixtures",
            "Grid",
            "Unsupported",
            "MakeRefExpression.cs.txt"
        )
        Assert.Contains("__makeref", File.ReadAllText(unsupported!!), StringComparison.Ordinal)
        let coreProjectPath string? = TestFixtureSource.Resolve("src", "Core", "Core.csproj")
        Assert.Contains("<Project", File.ReadAllText(coreProjectPath!!), StringComparison.Ordinal)
    }

    @Fact
    func FixtureResolution_NormalizesRelativeSegmentsAndPreservesSpaces() {
        let root = Path.Combine(
            AppContext.BaseDirectory,
            "issue4072 fixture root with spaces",
            Guid.NewGuid().ToString("N")
        )
        let fixtureDirectory = Path.Combine(root, "fixtures")
        Directory.CreateDirectory(fixtureDirectory)
        let fixture = Path.Combine(fixtureDirectory, "input.cs")
        File.WriteAllText(fixture, "class C { }")
        try {
            let relativeRoot = Path.GetRelativePath(AppContext.BaseDirectory, root)
            Assert.Equal(
                CanonicalRootPath.Resolve(root),
                GsharpTestProjectRunner.ResolveConfiguredSourceRoot(relativeRoot, AppContext.BaseDirectory)
            )
            Assert.Equal(
                CanonicalRootPath.Resolve(fixture),
                TestFixtureSource.ResolveFromRoot(root, "fixtures", "nested", "..", "input.cs")
            )
        } finally {
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func MissingSourceRootAndFixture_FailWithActionableErrors() {
        let missingRoot = Path.Combine(AppContext.BaseDirectory, "missing-source-root-" + Guid.NewGuid().ToString("N"))
        let rootError = Assert.Throws[DirectoryNotFoundException](
            func () object? {
                return GsharpTestProjectRunner.ResolveConfiguredSourceRoot(
                    Path.GetFileName(missingRoot),
                    AppContext.BaseDirectory
                )
            }
        )
        Assert.Contains(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable,
            rootError.Message,
            StringComparison.Ordinal
        )
        let existingRoot = Path.Combine(AppContext.BaseDirectory, "fixture-root-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(existingRoot)
        try {
            let fixtureError = Assert.Throws[FileNotFoundException](
                func () object? {
                    return TestFixtureSource.ResolveFromRoot(existingRoot, "missing.cs")
                }
            )
            Assert.Contains("missing.cs", fixtureError.Message, StringComparison.Ordinal)
            Assert.Contains(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                fixtureError.Message,
                StringComparison.Ordinal
            )
        } finally {
            Directory.Delete(existingRoot, recursive: true)
        }
    }

    @Fact
    func FixtureResolution_RejectsPathsOutsideSourceRoot() {
        let root = Path.Combine(AppContext.BaseDirectory, "fixture-root-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        let outside = Path.Combine(Path.GetDirectoryName(root)!!, "outside-" + Guid.NewGuid().ToString("N") + ".cs")
        File.WriteAllText(outside, "class Outside { }")
        try {
            let error = Assert.Throws[InvalidOperationException](
                func () object? {
                    return TestFixtureSource.ResolveFromRoot(root, "..", Path.GetFileName(outside))
                }
            )
            Assert.Contains("escapes", error.Message, StringComparison.Ordinal)
        } finally {
            File.Delete(outside)
            Directory.Delete(root, recursive: true)
        }
    }

    @Fact
    func OriginalSourceRoot_IsExposedOnlyToTheTestProcess() {
        let artifactRoot = Path.Combine(AppContext.BaseDirectory, "issue4072-artifacts", Guid.NewGuid().ToString("N"))
        let sourceRoot = Path.Combine(
            AppContext.BaseDirectory,
            "issue4072 source root with spaces",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(artifactRoot)
        Directory.CreateDirectory(sourceRoot)
        let originalSourceRoot string? = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable
        )
        try {
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, sourceRoot)
            let compileEnvironment = SdkCompileRunner.IsolatedNugetEnvironment(artifactRoot)
            let testEnvironment = SdkCompileRunner.MirroredTestEnvironment(artifactRoot, sourceRoot)
            Assert.Equal(string.Empty, compileEnvironment[GsharpTestProjectRunner.SourceRootEnvironmentVariable])
            Assert.Equal(
                CanonicalRootPath.Resolve(sourceRoot),
                testEnvironment[GsharpTestProjectRunner.SourceRootEnvironmentVariable]
            )
            let inheritedProbe = ProcessRunner.Run(
                "printenv",
                []string{GsharpTestProjectRunner.SourceRootEnvironmentVariable},
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10)
            )
            Assert.NotEqual(0, inheritedProbe.ExitCode)
            let compileProbe = ProcessRunner.Run(
                "printenv",
                []string{GsharpTestProjectRunner.SourceRootEnvironmentVariable},
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10),
                compileEnvironment
            )
            Assert.Equal(0, compileProbe.ExitCode)
            Assert.Equal(string.Empty, compileProbe.Stdout.Trim())
            let testProbe = ProcessRunner.Run(
                "printenv",
                []string{GsharpTestProjectRunner.SourceRootEnvironmentVariable},
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10),
                testEnvironment
            )
            Assert.Equal(0, testProbe.ExitCode)
            Assert.Equal(CanonicalRootPath.Resolve(sourceRoot), testProbe.Stdout.Trim())
        } finally {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                originalSourceRoot
            )
            Directory.Delete(sourceRoot, recursive: true)
            Directory.Delete(artifactRoot, recursive: true)
        }
    }

    @Fact
    func UnbuiltConfiguredSourceRoot_FallsBackToAssemblyRepoRootForLocalPackages() {
        let assemblyRoot string? = GsharpTestProjectRunner.FindAssemblyRepoRoot()
        Assert.NotNull(assemblyRoot)
        let assemblySdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(assemblyRoot, "Release")
        if assemblySdk == nil {
            throw InvalidOperationException("Build the G# SDK packages before this fallback regression test.")
        }
        let sourceRoot = Path.Combine(
            AppContext.BaseDirectory,
            "issue4896-unbuilt-source-root",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(sourceRoot)
        let originalSourceRoot string? = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable
        )
        try {
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, sourceRoot)
            let resolvedRoot = GsharpTestProjectRunner.FindRepoRoot()
            Assert.Equal(CanonicalRootPath.Resolve(sourceRoot), resolvedRoot)
            let fallbackSdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(resolvedRoot, "Release")
            Assert.NotNull(fallbackSdk)
            Assert.Equal(assemblySdk.Version, fallbackSdk!!.Version)
            let exactPath = GsharpTestProjectRunner.FindLocalPackageVersion(
                resolvedRoot,
                "Gsharp.NET.Sdk",
                assemblySdk.Version,
                "Release"
            )
            Assert.Equal(assemblySdk.NupkgPath, exactPath)
        } finally {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                originalSourceRoot
            )
            Directory.Delete(sourceRoot, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ReadOnlyConfiguredSourceRoot_SdkCompileAndTestUseWritableFeeds(runTests bool) {
        let assemblyRoot = GsharpTestProjectRunner.FindAssemblyRepoRoot()
        let builtSdk = GsharpTestProjectRunner.ResolveLocalSdkPackage(assemblyRoot, "Release") ??
            throw InvalidOperationException("Build the G# SDK packages before this fallback regression test.")
        let root = Path.Combine(AppContext.BaseDirectory, "issue4896-readonly", Guid.NewGuid().ToString("N"))
        let sourceRoot = Path.Combine(root, "source")
        let workDir = Path.Combine(root, "work")
        Directory.CreateDirectory(sourceRoot)
        Directory.CreateDirectory(workDir)
        let fixture = Path.Combine(sourceRoot, "fixture.cs")
        let sourceConfig = Path.Combine(sourceRoot, "nuget.config")
        File.WriteAllText(fixture, "class Original { }")
        File.WriteAllText(sourceConfig, "<configuration><packageSources><clear /></packageSources></configuration>")
        let originalFixture = File.ReadAllBytes(fixture)
        let originalConfig = File.ReadAllBytes(sourceConfig)
        let readOnlyMode = UnixFileMode.UserRead | UnixFileMode.UserExecute |
        UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute
        let originalSourceRoot = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable
        )
        try {
            File.SetAttributes(fixture, FileAttributes.ReadOnly)
            File.SetAttributes(sourceConfig, FileAttributes.ReadOnly)
            if !OperatingSystem.IsWindows() {
                File.SetUnixFileMode(sourceRoot, readOnlyMode)
                Assert.Throws[UnauthorizedAccessException](
                    func () object? {
                        File.WriteAllText(Path.Combine(sourceRoot, "forbidden"), "must not be written")
                        return nil
                    }
                )
            }
            Environment.SetEnvironmentVariable(GsharpTestProjectRunner.SourceRootEnvironmentVariable, sourceRoot)
            if runTests {
                let project = GsharpTestProject{
                    LibraryName: "ReadOnlyLib",
                    LibraryRootNamespace: "ReadOnlyLib",
                    LibraryFiles: []GsharpSourceFile{
                        GsharpSourceFile(
                            "Value.gs",
                            "package ReadOnlyLib\nclass Value { shared { func Get() int32 -> 42 } }\n"
                        )
                    },
                    TestsName: "ReadOnlyLib.Tests",
                    TestsRootNamespace: "ReadOnlyLib.Tests",
                    TestFiles: []GsharpSourceFile{
                        GsharpSourceFile(
                            "ValueTests.gs",
                            "package ReadOnlyLib.Tests\nimport Xunit\nimport ReadOnlyLib\n" +
                                "class ValueTests { @Fact func Returns42() { Assert.Equal(42, Value.Get()) } }\n"
                        )
                    }
                }
                let run = GsharpTestProjectRunner().Run(project, workDir)
                Assert.True(run.Status == GsharpTestRunStatus.Ran, run.Output)
                Assert.Equal(0, run.ExitCode)
                let outcome = Assert.Single(run.Results)
                Assert.Equal("ReadOnlyLib.Tests.ValueTests.Returns42", outcome.Name)
                Assert.Equal("Passed", outcome.Outcome)
            } else {
                Assert.Equal(builtSdk.Version, SdkCompileRunner.ResolveSdkVersion("Release", explicitVersion: nil))
                Assert.Equal(builtSdk.Version, SdkCompileRunner.ResolveSdkVersion("Release", builtSdk.Version))
                let source = Path.Combine(workDir, "Program.gs")
                File.WriteAllText(
                    source,
                    "package ReadOnlyCompile\nimport System\n" +
                        "class Program { shared { func Main() { Console.WriteLine(\"readonly-4896\") } } }\n"
                )
                let compile = SdkCompileRunner().Compile(
                    workDir,
                    "ReadOnlyCompile",
                    []string{source},
                    TargetKind.Exe,
                    Array.Empty[string](),
                    Array.Empty[string](),
                    Array.Empty[string](),
                    "ReadOnlyCompile",
                    "Release"
                )
                Assert.True(compile.IsAvailable, compile.UnavailableReason)
                Assert.True(compile.ExitCode == 0, compile.Output)
                Assert.NotNull(compile.EmittedAssemblyPath)
                let execution = ProcessRunner.Run(
                    "dotnet",
                    []string{compile.EmittedAssemblyPath!!},
                    workDir,
                    TimeSpan.FromSeconds(30)
                )
                Assert.True(execution.ExitCode == 0, execution.Output)
                Assert.Equal("readonly-4896" + Environment.NewLine, execution.Stdout)
            }
            Assert.Equal(originalFixture, File.ReadAllBytes(fixture))
            Assert.Equal(originalConfig, File.ReadAllBytes(sourceConfig))
            Assert.Equal(
                []string{"fixture.cs", "nuget.config"},
                Directory.GetFileSystemEntries(sourceRoot).Select(Path.GetFileName).OrderBy((name string?) -> name)
            )
            if !OperatingSystem.IsWindows() {
                Assert.Equal(readOnlyMode, File.GetUnixFileMode(sourceRoot))
            }
        } finally {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                originalSourceRoot
            )
            if !OperatingSystem.IsWindows() {
                File.SetUnixFileMode(
                    sourceRoot,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                )
            }
            File.SetAttributes(fixture, FileAttributes.Normal)
            File.SetAttributes(sourceConfig, FileAttributes.Normal)
            Directory.Delete(root, recursive: true)
        }
    }
}
