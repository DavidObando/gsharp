// <copyright file="TestSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Core.Tests;

public class TestSourceTests
{
    [Fact]
    public void ConfiguredSourceRoot_IsUsedInsteadOfExecutionTree()
    {
        var root = TestSource.Root;
        Assert.Equal(root, TestSource.FindRoot(root, Path.Combine(root, "not-the-execution-tree")));
        Assert.NotEmpty(TestSource.SourceFiles(SearchOption.TopDirectoryOnly, "src/Core/CodeAnalysis/Emit"));
    }

    [Fact]
    public void MissingConfiguredSourceRoot_DoesNotFallBackToExecutionTree()
    {
        Assert.Throws<DirectoryNotFoundException>(() =>
            TestSource.FindRoot(Path.Combine(TestSource.Root, Guid.NewGuid().ToString("N")), AppContext.BaseDirectory));
    }

    [Fact]
    public void MigratedOnlyTree_CannotProduceVacuousSourceGuards()
    {
        var directory = NewTree();
        try
        {
            File.WriteAllText(Path.Combine(directory, "GSharp.sln"), string.Empty);
            Assert.Throws<DirectoryNotFoundException>(() => TestSource.FindRoot(directory, TestSource.Root));
            Assert.Throws<DirectoryNotFoundException>(() => TestSource.FindRoot(null, directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// Issue #4656: after the cut-over the compiler's sources are G#. A tree
    /// holding <c>Parser.gs</c> is a valid root and reports the G# extension,
    /// so guards read <c>.gs</c> instead of failing at root resolution.
    /// </summary>
    [Fact]
    public void GSharpSourceTree_IsAValidRoot_AndReportsItsExtension()
    {
        var directory = NewTree();
        try
        {
            File.WriteAllText(Path.Combine(directory, "GSharp.slnx"), string.Empty);
            WriteParser(directory, ".gs");

            Assert.Equal(directory, TestSource.FindRoot(directory, AppContext.BaseDirectory));
            Assert.Equal(TestSource.GSharpExtension, TestSource.SourceExtensionOf(directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// A tree holding the parser in BOTH languages is ambiguous and rejected,
    /// rather than letting a guard silently read the stale half.
    /// </summary>
    [Fact]
    public void MixedLanguageTree_IsRejected()
    {
        var directory = NewTree();
        try
        {
            File.WriteAllText(Path.Combine(directory, "GSharp.sln"), string.Empty);
            WriteParser(directory, ".cs");
            WriteParser(directory, ".gs");

            Assert.Throws<DirectoryNotFoundException>(() => TestSource.FindRoot(directory, AppContext.BaseDirectory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// Issue #4656: a scan that finds nothing, or names a directory that does
    /// not exist, throws instead of handing a guard an empty list to pass on.
    /// </summary>
    [Fact]
    public void EmptyOrMissingScan_Throws()
    {
        Assert.Throws<InvalidOperationException>(() =>
            TestSource.SourceFilesMatching("NoSuchFile_" + Guid.NewGuid().ToString("N"), SearchOption.AllDirectories, "src/Core"));
        Assert.Throws<DirectoryNotFoundException>(() =>
            TestSource.SourceFiles(SearchOption.AllDirectories, "src/Core/NoSuchDirectory"));
    }

    /// <summary>
    /// Issue #4656: a C# fixture that a test compiles with Roslyn reads the live
    /// file while it exists, refuses a stale snapshot, and falls back to the
    /// snapshot once the live file is G#.
    /// </summary>
    [Fact]
    public void CSharpFixtureSource_UsesLiveFile_RejectsDrift_AndFallsBackToSnapshot()
    {
        var directory = NewTree();
        try
        {
            var fixtures = Path.Combine(directory, "test", "Core.Tests", "Fixtures");
            var snapshots = Path.Combine(directory, "test", "Core.Tests", "TestData", "CSharpFixtureSources");
            Directory.CreateDirectory(fixtures);
            Directory.CreateDirectory(snapshots);
            const string source = "// <copyright file=\"F.cs\" company=\"GSharp\">\nnamespace GSharp.Core.Tests.Fixtures;\npublic class F { }\n";
            File.WriteAllText(Path.Combine(snapshots, "F.cs.txt"), source);

            File.WriteAllText(Path.Combine(fixtures, "F.cs"), source);
            Assert.Equal(source, TestSource.CSharpFixtureSource(directory, "F.cs"));

            File.WriteAllText(Path.Combine(fixtures, "F.cs"), source + "public class G { }\n");
            Assert.Throws<InvalidOperationException>(() => TestSource.CSharpFixtureSource(directory, "F.cs"));

            File.Delete(Path.Combine(fixtures, "F.cs"));
            Assert.Equal(source, TestSource.CSharpFixtureSource(directory, "F.cs"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// Every committed fixture snapshot is usable: while its live C# fixture
    /// exists it must match it exactly (drift fails); once the fixture is G#,
    /// the snapshot itself must hold the expected C# fixture namespace.
    /// </summary>
    [Fact]
    public void CSharpFixtureSnapshots_AreCurrent()
    {
        var snapshots = Directory.GetFiles(
            Path.Combine(TestSource.Root, "test", "Core.Tests", "TestData", "CSharpFixtureSources"), "*.cs.txt");
        Assert.NotEmpty(snapshots);
        foreach (var snapshot in snapshots)
        {
            Assert.NotEmpty(TestSource.CSharpFixtureSource(Path.GetFileNameWithoutExtension(snapshot)));
        }
    }

    private static string NewTree()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "source-root-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void WriteParser(string root, string extension)
    {
        var syntax = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax");
        Directory.CreateDirectory(syntax);
        File.WriteAllText(Path.Combine(syntax, "Parser" + extension), string.Empty);
    }
}
