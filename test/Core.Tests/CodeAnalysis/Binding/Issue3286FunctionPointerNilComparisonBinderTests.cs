// <copyright file="Issue3286FunctionPointerNilComparisonBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #3286: function-pointer comparisons only accept native-pointer operands.</summary>
public class Issue3286FunctionPointerNilComparisonBinderTests
{
    [Theory]
    [InlineData("fp == \"x\"", "==")]
    [InlineData("\"x\" != fp", "!=")]
    public void FunctionPointerComparedWithNonPointer_ReportsGS0129(string expression, string operatorText)
    {
        var tree = SyntaxTree.Parse(SourceText.From(
            $$"""
            package P

            unsafe func run() {
                var fp *func(int32) int32 = nil
                var bad = {{expression}}
            }
            """));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();

        var diagnostic = Assert.Single(compilation.Emit(peStream).Diagnostics.Where(d => d.Id == "GS0129"));

        Assert.Equal(operatorText, diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }
}
