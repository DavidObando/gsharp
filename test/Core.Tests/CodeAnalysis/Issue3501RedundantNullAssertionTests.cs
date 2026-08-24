// <copyright file="Issue3501RedundantNullAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 (!! reduction): GS0536 warns when a user-written <c>!!</c>
/// asserts a value whose bound type — smart-cast narrowing included — is
/// already non-nullable, making the assertion a no-op. cs2gs's polish pass
/// strips exactly these spans, so the warning is the single source of truth
/// for redundancy.
/// </summary>
public class Issue3501RedundantNullAssertionTests
{
    [Fact]
    public void AssertionOnStaticallyNonNullable_Warns()
    {
        var source = @"
func F(s string) string {
    return s!!
}

F(""x"")
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void AssertionOnNarrowedNullable_Warns()
    {
        var source = @"
func F(s string?) string {
    if s != nil {
        return s!!
    }
    return ""nil""
}

F(""x"")
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void NecessaryAssertion_DoesNotWarn()
    {
        var source = @"
func F(s string?) string {
    return s!!
}

F(""x"")
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal("x", result.Value);
    }

    [Fact]
    public void ReceiverPositionAssertion_OnNonNullable_Warns()
    {
        var source = @"
class Box {
    var Value int32 = 42
}

func F(b Box) int32 {
    return b!!.Value
}

F(Box())
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullConditionalThenAssertion_DoesNotWarn()
    {
        // `x?.Y` produces a nullable; the trailing assertion does real work.
        var source = @"
class Box {
    var Value int32 = 42
}

func F(b Box?) int32 {
    return b?.Value!!
}

F(Box())
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ValueTypeNullable_NecessaryAssertion_DoesNotWarn()
    {
        var source = @"
func F(v int32?) int32 {
    return v!!
}

F(7)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0536");
        Assert.Equal(7, result.Value);
    }
}
