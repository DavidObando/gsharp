// <copyright file="Issue2731NaturalMethodGroupInterpolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2731NaturalMethodGroupInterpolationTests
{
    [Fact]
    public void AmbiguousMethodGroupInInterpolation_ReportsUserDiagnostic()
    {
        const string source = """
            package Issue2731Negative
            import System

            func Convert(value string) int32 -> value.Length
            func Convert(value int32) string -> value.ToString()

            func Render() string -> "value=${Convert}"
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var output = new MemoryStream();
        var result = compilation.Emit(output);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0218");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void ImportedOverloadSetInInterpolation_ReportsUserDiagnostic()
    {
        const string source = """
            package Issue2731ImportedNegative
            import System

            func Render() string -> "value=${Convert.ToString}"
            """;

        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var output = new MemoryStream();
        var result = compilation.Emit(output);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0218");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }
}
