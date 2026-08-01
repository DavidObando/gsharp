// <copyright file="Issue2987ByRefLikeBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2987: reflection cannot invoke members whose signatures contain
/// stack-only CLR values, so the interpreter reports an explicit boundary.
/// </summary>
public class Issue2987ByRefLikeBoundaryInterpreterTests
{
    public static TheoryData<string, string> UnsupportedCases => new()
    {
        {
            """
            import System

            func value(values []int32) int32 {
                var span = MemoryExtensions.AsSpan(values)
                return 11
            }

            value([]int32{11, 22, 33})
            """,
            "System.Span[int32]"
        },
        {
            """
            import System

            func value(values []int32) int32 {
                var span ReadOnlySpan[int32] = values
                return 22
            }

            value([]int32{11, 22, 33})
            """,
            "System.ReadOnlySpan[int32]"
        },
    };

    [Theory]
    [MemberData(nameof(UnsupportedCases))]
    public void ByRefLikeReflectionSignature_ReportsGs0516(string source, string typeName)
    {
        var cell = new SessionEngine().Evaluate(source);

        var diagnostic = Assert.Single(cell.Diagnostics);
        Assert.True(cell.HasError);
        Assert.Equal("GS0516", diagnostic.Id);
        Assert.Contains(typeName, diagnostic.Message);
        Assert.Contains("stack-only (ByRefLike)", diagnostic.Message);
        Assert.Contains("compile this program with 'gsc' instead", diagnostic.Message);
        Assert.DoesNotContain("Specified method is not supported", diagnostic.Message);
    }

    [Fact]
    public void ReflectiveInterpolationHandler_RemainsSupported()
    {
        const string Source = """
            import System.Text

            var builder = StringBuilder()
            builder.Append("value is ${42} and ${43}")
            builder.ToString()
            """;

        var cell = new SessionEngine().Evaluate(Source);

        Assert.False(cell.HasError, string.Join("\n", cell.Diagnostics));
        Assert.Equal("value is 42 and 43", cell.Value);
    }
}
