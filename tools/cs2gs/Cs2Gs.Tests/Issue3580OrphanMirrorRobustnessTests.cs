// <copyright file="Issue3580OrphanMirrorRobustnessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.Pipeline;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3580: the orphan-mirror step runs after every app already
/// succeeded, so it must not abort the run. Failures are returned (the
/// pipeline marks the run failed and still writes the report), and files
/// under a project directory removed via <c>--exclude</c> are out of scope,
/// not orphans — they are skipped entirely.
/// </summary>
public class Issue3580OrphanMirrorRobustnessTests : IDisposable
{
    private readonly string root;

    public Issue3580OrphanMirrorRobustnessTests()
    {
        this.root = Path.Combine(Path.GetTempPath(), "cs2gs-3580-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(this.root, "src"));
        Directory.CreateDirectory(Path.Combine(this.root, "out"));
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.root, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    [Fact]
    public void TranslatableOrphan_IsMirrored()
    {
        this.WriteSource("src/Lone.cs", "namespace Demo { public static class Lone { public static int Answer() => 42; } }");

        var failures = RepositoryOrphanSourceTranslator.TranslateMissing(
            Path.Combine(this.root, "src"),
            Path.Combine(this.root, "out"),
            new[] { "Lone.cs" });

        Assert.Empty(failures);
        Assert.True(File.Exists(Path.Combine(this.root, "out", "Lone.gs")));
    }

    [Fact]
    public void UntranslatableOrphan_IsRecordedNotThrown_AndOthersStillMirror()
    {
        // References a type no single-file in-memory load can resolve, so the
        // translator emits the placeholder type and an Unsupported diagnostic.
        this.WriteSource(
            "src/Broken.cs",
            "namespace Demo { public class Broken { public Some.Missing.Type Field; } }");
        this.WriteSource("src/Fine.cs", "namespace Demo { public static class Fine { public static int One() => 1; } }");

        var failures = RepositoryOrphanSourceTranslator.TranslateMissing(
            Path.Combine(this.root, "src"),
            Path.Combine(this.root, "out"),
            new[] { "Broken.cs", "Fine.cs" });

        Assert.Single(failures);
        Assert.Contains("Broken.cs", failures[0]);
        Assert.False(File.Exists(Path.Combine(this.root, "out", "Broken.gs")));
        Assert.True(File.Exists(Path.Combine(this.root, "out", "Fine.gs")));
    }

    [Fact]
    public void FileUnderExcludedProjectDirectory_IsSkipped()
    {
        // The file is untranslatable standalone — but its project was
        // --exclude'd, so the orphan step must not touch it at all.
        this.WriteSource(
            "src/Analyzers/Testing/Verifier.cs",
            "namespace Demo { public class Verifier { public Some.Missing.Type Field; } }");
        this.WriteSource(
            "src/Analyzers/Testing/Testing.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");

        RepositoryExcludedScope scope = RepositoryExcludedScope.Compute(
            Path.Combine(this.root, "src"),
            new[] { Path.Combine(this.root, "src", "Analyzers", "Testing", "Testing.csproj") });
        var failures = RepositoryOrphanSourceTranslator.TranslateMissing(
            Path.Combine(this.root, "src"),
            Path.Combine(this.root, "out"),
            new[] { "Analyzers/Testing/Verifier.cs" },
            scope);

        Assert.Empty(failures);
        Assert.False(File.Exists(Path.Combine(this.root, "out", "Analyzers", "Testing", "Verifier.gs")));
    }

    [Fact]
    public void SharedFileLinkedByExcludedProject_IsSkipped()
    {
        // Issue #3580 round 2: a shared source (test/Shared/*) linked via an
        // explicit <Compile Include> lives outside every project directory —
        // the excluded project's declared items must carry it out of scope.
        this.WriteSource(
            "src/Shared/Oracle.cs",
            "namespace Demo { public class Oracle { public Some.Missing.Type Field; } }");
        this.WriteSource(
            "src/Tests/Tests.csproj",
            "<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>" +
            "<Compile Include=\"..\\Shared\\Oracle.cs\" Link=\"Oracle.cs\" />" +
            "</ItemGroup></Project>");

        RepositoryExcludedScope scope = RepositoryExcludedScope.Compute(
            Path.Combine(this.root, "src"),
            new[] { Path.Combine(this.root, "src", "Tests", "Tests.csproj") });
        var failures = RepositoryOrphanSourceTranslator.TranslateMissing(
            Path.Combine(this.root, "src"),
            Path.Combine(this.root, "out"),
            new[] { "Shared/Oracle.cs" },
            scope);

        Assert.Empty(failures);
        Assert.False(File.Exists(Path.Combine(this.root, "out", "Shared", "Oracle.gs")));
    }

    private void WriteSource(string relativePath, string content)
    {
        string path = Path.Combine(this.root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        File.WriteAllText(path, content);
    }
}
