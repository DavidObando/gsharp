// <copyright file="Issue2899ThrowDeadCodeFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2899: definite-return may split at throw, but shared out-parameter
/// analysis must keep its existing opaque exception-flow behavior.
/// </summary>
public class Issue2899ThrowDeadCodeFlowTests
{
    [Fact]
    public void ThrowFollowedByDeadCode_DoesNotReportGs0100OrGs0238()
    {
        const string Source = """
            package Issue2899.ThrowDeadCode
            import System

            func Value() int32 {
                throw Exception("boom")
                var dead = 1
            }

            func Assign(out value int32) {
                throw Exception("boom")
                value = 1
            }
            """;

        AssertNoErrors(Source);
    }

    [Fact]
    public void ConditionalReturnAndThrowFollowedByDeadCode_DoesNotReportGs0100()
    {
        const string Source = """
            package Issue2899.ConditionalThrowDeadCode
            import System

            func F(condition bool) int32 {
                if condition {
                    return 1
                }
                throw Exception("boom")
                var dead = 2
            }
            """;

        AssertNoErrors(Source);
    }

    private static void AssertNoErrors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.True(peStream.Length > 0);
    }
}
