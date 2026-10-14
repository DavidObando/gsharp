// <copyright file="Issue4072Stage4FixtureContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.Collections.Generic
import System.IO
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
}
