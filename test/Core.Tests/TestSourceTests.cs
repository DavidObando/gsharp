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
        Assert.NotEmpty(Directory.GetFiles(Path.Combine(root, "src", "Core", "CodeAnalysis", "Emit"), "*.cs"));
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
        var directory = Path.Combine(AppContext.BaseDirectory, "source-root-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
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
}
