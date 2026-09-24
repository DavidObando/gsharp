// <copyright file="Issue4350IndexRangeFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Formatting.Tests;

/// <summary>
/// ADR-0187 / issue #4350: the formatter keeps prefix <c>^x</c> (from-end
/// Index), prefix <c>~x</c> (one's-complement), binary <c>x ^ y</c> (XOR),
/// and leading from-end ranges intact and idempotent.
/// </summary>
public sealed class Issue4350IndexRangeFormattingTests
{
    [Fact]
    public void FromEndTildeAndXorSpellingsFormatStably()
    {
        const string source = """
            let last=^1
            let r=^4..^1
            let tail=^n..
            let inverted=~mask
            let mixed=a^b
            let slot=xs[~i]
            func (a Bits) operator ~() Bits -> Bits{Value:~a.Value}
            """;
        var result = GSharpFormatter.Format(SourceText.From(source));
        Assert.Empty(result.Diagnostics);
        var text = result.Text!.ToString();
        Assert.Contains("let last = ^1", text);
        Assert.Contains("let r = ^4 .. ^1", text);
        Assert.Contains("let tail = ^n ..", text);
        Assert.Contains("let inverted = ~mask", text);
        Assert.Contains("let mixed = a ^ b", text);
        Assert.Contains("let slot = xs[~i]", text);
        Assert.Contains("operator ~ ()", text);
        Assert.Contains("Value: ~a.Value", text);
        Assert.Equal(text, GSharpFormatter.Format(result.Text!).Text!.ToString());
    }
}
