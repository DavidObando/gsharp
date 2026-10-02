// <copyright file="Issue4656CommittedCompilerSourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4656: the self-migration inventories read the committed tree in its
/// own language, and a count over nothing is a failure, not a zero.
/// </summary>
public sealed class Issue4656CommittedCompilerSourceTests
{
    [Fact]
    public void Language_IsDecidedByTheParserFile_AndAMixedTreeIsRejected()
    {
        string csharp = Tree(".cs");
        string gsharp = Tree(".gs");
        string mixed = Tree(".cs", ".gs");

        Assert.False(CommittedCompilerSource.IsGSharp(csharp));
        Assert.True(CommittedCompilerSource.IsGSharp(gsharp));
        Assert.Throws<InvalidOperationException>(() => CommittedCompilerSource.IsGSharp(mixed));
        Assert.Throws<InvalidOperationException>(() => CommittedCompilerSource.IsGSharp(Tree()));
    }

    [Fact]
    public void GSharpFiles_FailsOnAnEmptyOrMissingDirectory()
    {
        string root = Tree(".gs");

        Assert.Single(CommittedCompilerSource.GSharpFiles(root, "src/Core"));
        Directory.CreateDirectory(Path.Combine(root, "tools", "empty"));
        Assert.Throws<InvalidOperationException>(() => CommittedCompilerSource.GSharpFiles(root, "tools/empty"));
        Assert.Throws<DirectoryNotFoundException>(() => CommittedCompilerSource.GSharpFiles(root, "tools/missing"));
    }

    private static string Tree(params string[] parserExtensions)
    {
        string root = Path.Combine(
            AppContext.BaseDirectory, "issue-4656-committed-source", Guid.NewGuid().ToString("N"));
        string syntax = Path.Combine(root, "src", "Core", "CodeAnalysis", "Syntax");
        Directory.CreateDirectory(syntax);
        foreach (string extension in parserExtensions)
        {
            File.WriteAllText(Path.Combine(syntax, "Parser" + extension), string.Empty);
        }

        return root;
    }
}
