// <copyright file="Issue4240RetiredExplicitExtensionReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0182 / issue #4240: the ADR-0165 <c>func extension (recv Type)
/// Name(...)</c> marker is a retired spelling. The parser reports
/// <c>GS0587</c> and recovers by parsing the declaration exactly as if
/// <c>extension</c> had not been written, so the rest of the pipeline sees
/// a well-formed extension with one clean diagnostic.
/// </summary>
public class Issue4240RetiredExplicitExtensionReceiverTests
{
    [Fact]
    public void RetiredExplicitExtensionMarker_OnOwnedEnum_ReportsGS0587WithRecovery()
    {
        var source = @"
enum Color { Red, Green }

func extension (c Color) Rank() int32 {
    if c == Color.Green {
        return 2
    }

    return 1
}

Color.Green.Rank()
";
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(d => d.IsError).ToList();

        // Recovery: exactly one error — the retired-marker diagnostic — with
        // no cascade from the rest of the declaration or its call site.
        var single = Assert.Single(errors);
        Assert.Equal("GS0587", single.Id);
    }

    [Fact]
    public void RetiredExplicitExtensionMarker_OnOwnedClass_ReportsGS0587WithRecovery()
    {
        var source = @"
class Counter {
    var Value int32
}

func extension (c Counter) Bump() int32 { return c.Value + 1 }

let c = Counter{Value: 41}
c.Bump()
";
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        var single = Assert.Single(errors);
        Assert.Equal("GS0587", single.Id);
    }

    [Fact]
    public void ExtensionKeyword_AsPlainFunctionName_DoesNotReportGS0587()
    {
        var source = @"
func extension(value int32) int32 { return value + 1 }
extension(41)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0587");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ExtensionKeyword_AsExtensionMethodName_DoesNotReportGS0587()
    {
        var source = @"
func (s string) extension() int32 { return s.Length }
""hi"".extension()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0587");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void OrdinaryReceiverClause_WithoutMarker_DoesNotReportGS0587()
    {
        var source = @"
struct Point {
    var X int32
}

func (p Point) X2() int32 { return p.X * 2 }

let p = Point{X: 21}
p.X2()
";
        var result = EmittedOracle.Evaluate(source);
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0587");
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(42, result.Value);
    }
}
