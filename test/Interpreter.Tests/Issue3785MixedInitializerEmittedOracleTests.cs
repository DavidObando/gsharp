// <copyright file="Issue3785MixedInitializerEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class Issue3785MixedInitializerEmittedOracleTests
{
    [Fact]
    public void MixedMembersAndSpreads_MatchCompiledLexicalOrder()
        => AssertOutput(Issue3785MixedInitializerCases.LexicalOrder, Issue3785MixedInitializerCases.LexicalOrderOutput);

    [Fact]
    public void ExplicitMembersAndUnmarkedKeys_KeepDistinctOperations()
        => AssertOutput(Issue3785MixedInitializerCases.DistinctMemberAndKey, Issue3785MixedInitializerCases.DistinctMemberAndKeyOutput);

    private static void AssertOutput(string source, string expected)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.True(
            !result.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Output.ReplaceLineEndings(Environment.NewLine));
    }
}
