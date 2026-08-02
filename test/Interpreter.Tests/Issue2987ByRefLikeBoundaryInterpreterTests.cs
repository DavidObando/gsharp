// <copyright file="Issue2987ByRefLikeBoundaryInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using GSharp.Core.CodeAnalysis;
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

            MemoryExtensions.AsSpan([]int32{11, 22, 33})
            """,
            "System.Span[int32]"
        },
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
    public void ByRefLikeParameter_IsDetected()
    {
        var member = typeof(Issue2987ByRefLikeBoundaryInterpreterTests).GetMethod(
            nameof(AcceptSpan),
            BindingFlags.Static | BindingFlags.NonPublic);

        Assert.Equal(typeof(Span<int>), FindByRefLikeSignatureType(member));
    }

    [Fact]
    public void ByRefLikeDeclaringType_IsDetected()
    {
        var member = typeof(ByRefLikeProbe).GetMethod(nameof(ByRefLikeProbe.GetValue));

        Assert.Equal(typeof(ByRefLikeProbe), FindByRefLikeSignatureType(member));
    }

    [Fact]
    public void ReflectiveInterpolationHandler_RemainsSupported()
    {
        const string Source = """
            import GSharp.Interpreter.Tests

            Issue2987InterpolationProbe.Format("value is ${42} and ${43}")
            """;

        var cell = new SessionEngine().Evaluate(Source);

        Assert.False(cell.HasError, string.Join("\n", cell.Diagnostics));
        Assert.Equal("value is 42 and 43", cell.Value);
    }

    [Fact]
    public void ReflectiveClrOperators_RemainSupported()
    {
        const string Source = """
            import System

            var sum = TimeSpan.FromHours(11) + TimeSpan.FromHours(22)
            var negative = -TimeSpan.FromHours(11)
            Console.WriteLine(sum.TotalHours)
            Console.WriteLine(negative.TotalHours)
            """;

        var cell = new SessionEngine { CaptureConsole = true }.Evaluate(Source);

        Assert.False(cell.HasError, string.Join("\n", cell.Diagnostics));
        Assert.Equal("33\n-11\n", cell.Output);
    }

    private static Type FindByRefLikeSignatureType(MemberInfo member)
    {
        var find = typeof(Evaluator).GetMethod(
            "FindByRefLikeSignatureType",
            BindingFlags.Static | BindingFlags.NonPublic);

        Assert.NotNull(find);
        return Assert.IsAssignableFrom<Type>(find.Invoke(null, [member]));
    }

    private static int AcceptSpan(Span<int> value) => value.Length;

    private ref struct ByRefLikeProbe
    {
        public readonly int GetValue() => 42;
    }
}

/// <summary>Interpreter fixture for reflective interpolated-string-handler dispatch.</summary>
[InterpolatedStringHandler]
public struct Issue2987InterpolationHandler
{
    private readonly StringBuilder builder;

    /// <summary>Initializes a new handler.</summary>
    public Issue2987InterpolationHandler(int literalLength, int formattedCount)
    {
        this.builder = new StringBuilder(literalLength + formattedCount);
    }

    /// <summary>Appends literal text.</summary>
    public readonly void AppendLiteral(string value) => this.builder.Append(value);

    /// <summary>Appends a formatted value.</summary>
    public readonly void AppendFormatted<T>(T value) => this.builder.Append(value);

    /// <inheritdoc/>
    public override readonly string ToString() => this.builder.ToString();
}

/// <summary>Consumes the interpreter handler fixture.</summary>
public static class Issue2987InterpolationProbe
{
    /// <summary>Formats a handler.</summary>
    public static string Format(Issue2987InterpolationHandler handler) => handler.ToString();
}
