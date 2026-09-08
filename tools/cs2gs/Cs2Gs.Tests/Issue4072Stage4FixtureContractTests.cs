// <copyright file="Issue4072Stage4FixtureContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Integration coverage for the stage-4 original-source fixture contract.
/// </summary>
public class Issue4072Stage4FixtureContractTests
{
    [Fact]
    public void SourceRoot_ProvidesAnalyzerCorpusUnsupportedAndProjectLoadingFixtures()
    {
        string analyzer = TestFixtureSource.Resolve(
            "src", "Analyzers", "InternalAnalyzers", "StructFieldDefsReadAnalyzer.cs");
        Assert.Contains("StructFieldDefsReadAnalyzer", File.ReadAllText(analyzer), StringComparison.Ordinal);

        Assert.True(File.Exists(TestFixtureSource.Resolve(
            "tools", "cs2gs", "corpus", "L1-Console", "L1-Console.csproj")));
        Assert.True(File.Exists(TestFixtureSource.Resolve(
            "tools", "cs2gs", "corpus", "L4-Console", "L4-Console.csproj")));

        string unsupported = TestFixtureSource.Resolve(
            "tools", "cs2gs", "Cs2Gs.Tests", "Fixtures", "Grid", "Unsupported", "MakeRefExpression.cs");
        Assert.Contains("__makeref", File.ReadAllText(unsupported), StringComparison.Ordinal);

        string coreProjectPath = TestFixtureSource.Resolve("src", "Core", "Core.csproj");
        Assert.Contains(
            "<Project",
            File.ReadAllText(coreProjectPath),
            StringComparison.Ordinal);
    }

    [Fact]
    public void FixtureResolution_NormalizesRelativeSegmentsAndPreservesSpaces()
    {
        string root = Path.Combine(
            AppContext.BaseDirectory,
            "issue4072 fixture root with spaces",
            Guid.NewGuid().ToString("N"));
        string fixtureDirectory = Path.Combine(root, "fixtures");
        Directory.CreateDirectory(fixtureDirectory);
        string fixture = Path.Combine(fixtureDirectory, "input.cs");
        File.WriteAllText(fixture, "class C { }");

        try
        {
            string relativeRoot = Path.GetRelativePath(AppContext.BaseDirectory, root);
            Assert.Equal(
                CanonicalRootPath.Resolve(root),
                GsharpTestProjectRunner.ResolveConfiguredSourceRoot(
                    relativeRoot, AppContext.BaseDirectory));
            Assert.Equal(
                CanonicalRootPath.Resolve(fixture),
                TestFixtureSource.ResolveFromRoot(
                    root, "fixtures", "nested", "..", "input.cs"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MissingSourceRootAndFixture_FailWithActionableErrors()
    {
        string missingRoot = Path.Combine(
            AppContext.BaseDirectory, "missing-source-root-" + Guid.NewGuid().ToString("N"));
        DirectoryNotFoundException rootError = Assert.Throws<DirectoryNotFoundException>(() =>
            GsharpTestProjectRunner.ResolveConfiguredSourceRoot(
                Path.GetFileName(missingRoot), AppContext.BaseDirectory));
        Assert.Contains(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable,
            rootError.Message,
            StringComparison.Ordinal);

        string existingRoot = Path.Combine(
            AppContext.BaseDirectory, "fixture-root-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(existingRoot);
        try
        {
            FileNotFoundException fixtureError = Assert.Throws<FileNotFoundException>(() =>
                TestFixtureSource.ResolveFromRoot(existingRoot, "missing.cs"));
            Assert.Contains("missing.cs", fixtureError.Message, StringComparison.Ordinal);
            Assert.Contains(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                fixtureError.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(existingRoot, recursive: true);
        }
    }

    [Fact]
    public void FixtureResolution_RejectsPathsOutsideSourceRoot()
    {
        string root = Path.Combine(
            AppContext.BaseDirectory, "fixture-root-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string outside = Path.Combine(Path.GetDirectoryName(root), "outside-" + Guid.NewGuid().ToString("N") + ".cs");
        File.WriteAllText(outside, "class Outside { }");

        try
        {
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                TestFixtureSource.ResolveFromRoot(root, "..", Path.GetFileName(outside)));
            Assert.Contains("escapes", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(outside);
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void OriginalSourceRoot_IsExposedOnlyToTheTestProcess()
    {
        string artifactRoot = Path.Combine(
            AppContext.BaseDirectory, "issue4072-artifacts", Guid.NewGuid().ToString("N"));
        string sourceRoot = Path.Combine(
            AppContext.BaseDirectory, "issue4072 source root with spaces", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(artifactRoot);
        Directory.CreateDirectory(sourceRoot);
        string originalSourceRoot = Environment.GetEnvironmentVariable(
            GsharpTestProjectRunner.SourceRootEnvironmentVariable);

        try
        {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                sourceRoot);
            IReadOnlyDictionary<string, string> compileEnvironment =
                SdkCompileRunner.IsolatedNugetEnvironment(artifactRoot);
            IReadOnlyDictionary<string, string> testEnvironment =
                SdkCompileRunner.MirroredTestEnvironment(artifactRoot, sourceRoot);

            Assert.Equal(
                string.Empty,
                compileEnvironment[GsharpTestProjectRunner.SourceRootEnvironmentVariable]);
            Assert.Equal(
                CanonicalRootPath.Resolve(sourceRoot),
                testEnvironment[GsharpTestProjectRunner.SourceRootEnvironmentVariable]);

            ProcessRunResult inheritedProbe = ProcessRunner.Run(
                "printenv",
                new[] { GsharpTestProjectRunner.SourceRootEnvironmentVariable },
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, inheritedProbe.ExitCode);

            ProcessRunResult compileProbe = ProcessRunner.Run(
                "printenv",
                new[] { GsharpTestProjectRunner.SourceRootEnvironmentVariable },
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10),
                compileEnvironment);
            Assert.Equal(0, compileProbe.ExitCode);
            Assert.Equal(string.Empty, compileProbe.Stdout.Trim());

            ProcessRunResult testProbe = ProcessRunner.Run(
                "printenv",
                new[] { GsharpTestProjectRunner.SourceRootEnvironmentVariable },
                AppContext.BaseDirectory,
                TimeSpan.FromSeconds(10),
                testEnvironment);
            Assert.Equal(0, testProbe.ExitCode);
            Assert.Equal(
                CanonicalRootPath.Resolve(sourceRoot),
                testProbe.Stdout.Trim());
        }
        finally
        {
            Environment.SetEnvironmentVariable(
                GsharpTestProjectRunner.SourceRootEnvironmentVariable,
                originalSourceRoot);
            Directory.Delete(sourceRoot, recursive: true);
            Directory.Delete(artifactRoot, recursive: true);
        }
    }
}
