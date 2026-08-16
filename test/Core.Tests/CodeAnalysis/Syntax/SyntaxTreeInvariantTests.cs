// <copyright file="SyntaxTreeInvariantTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Reflection;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

public class SyntaxTreeInvariantTests
{
    [Fact]
    public void Root_BeforeParseResult_FailsLoudly()
    {
        var constructor = typeof(SyntaxTree).GetConstructor(
            BindingFlags.Instance | BindingFlags.NonPublic,
            binder: null,
            [typeof(SourceText)],
            modifiers: null);
        Assert.NotNull(constructor);
        var tree = Assert.IsType<SyntaxTree>(
            constructor.Invoke([SourceText.From(string.Empty)]));

        Assert.Throws<InvalidOperationException>(() => tree.Root);
    }
}
