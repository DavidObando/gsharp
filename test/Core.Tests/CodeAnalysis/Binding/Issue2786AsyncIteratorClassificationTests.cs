// <copyright file="Issue2786AsyncIteratorClassificationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2786AsyncIteratorClassificationTests
{
    [Fact]
    public void ExplicitAsyncIteratorFunctionLiteral_ReportsGS0497()
    {
        var compilation = Compile("""
            package Issue2786.Literal
            import System.Collections.Generic
            import System.Threading.Tasks

            let values = async func() IAsyncEnumerable[int32] {
                await Task.CompletedTask
            }
            """);

        Assert.Contains(compilation.GlobalScope.Diagnostics, diagnostic => diagnostic.Id == "GS0497");
    }

    [Fact]
    public void ExplicitAsyncIteratorArrowLiteral_ReportsGS0497()
    {
        var compilation = Compile("""
            package Issue2786.Arrow
            import System.Collections.Generic

            async func Values() IAsyncEnumerable[int32] {
                yield 1
            }

            let values = async () -> Values()
            """);

        Assert.Contains(compilation.GlobalScope.Diagnostics, diagnostic => diagnostic.Id == "GS0497");
    }

    private static Compilation Compile(string source)
        => new(SyntaxTree.Parse(SourceText.From(source)));
}
