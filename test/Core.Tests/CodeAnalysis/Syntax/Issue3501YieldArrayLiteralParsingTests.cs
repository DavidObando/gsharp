// <copyright file="Issue3501YieldArrayLiteralParsingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #3501: the contextual-<c>yield</c> dispatch rejects a following
/// <c>[</c> so that <c>yield[i]</c> stays an index into a variable named
/// <c>yield</c> — but an empty bracket pair can only begin an array-literal
/// type, so <c>yield []T{…}</c> must parse as a yield statement.
/// </summary>
public class Issue3501YieldArrayLiteralParsingTests
{
    [Fact]
    public void YieldArrayLiteral_ParsesAsYieldStatement()
    {
        var source = @"
func G() sequence[[]int32] {
    yield []int32{1, 2}
    yield []int32{3}
}

var total = 0
for xs in G() {
    for x in xs {
        total = total + x
    }
}
total
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void IndexingAVariableNamedYield_StaysAnExpressionStatement()
    {
        var source = @"
let yield = []int32{7, 8}
yield[1]
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(8, result.Value);
    }
}
