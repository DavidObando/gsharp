// <copyright file="Issue3501YieldBreakTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #3501 Track A1: <c>yield break</c> terminates an iterator from any
/// nesting depth (C# alignment). Plain <c>break</c> keeps its loop binding;
/// the iterator MoveNext builders already lowered an expressionless return
/// to the shared end label, so <c>yield break</c> binds to exactly that.
/// </summary>
public class Issue3501YieldBreakTests
{
    [Fact]
    public void YieldBreak_AtBodyLevel_StopsIteration()
    {
        var source = @"
func Items(stop bool) sequence[int32] {
    yield 1
    if stop {
        yield break
    }
    yield 2
}

var total = 0
for _, v in Items(true) {
    total += v
}
for _, v in Items(false) {
    total += v
}
total
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(4, result.Value);
    }

    [Fact]
    public void YieldBreak_InsideLoop_TerminatesWholeIterator()
    {
        var source = @"
func Items(limit int32) sequence[int32] {
    for var i = 0; i < 10; i += 1 {
        if i >= limit {
            yield break
        }
        yield i
    }
    yield 99
}

var total = 0
for _, v in Items(3) {
    total += v
}
total
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void PlainBreak_InsideLoop_KeepsLoopBinding()
    {
        var source = @"
func Items(limit int32) sequence[int32] {
    for var i = 0; i < 10; i += 1 {
        if i >= limit {
            break
        }
        yield i
    }
    yield 99
}

var total = 0
for _, v in Items(3) {
    total += v
}
total
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(102, result.Value);
    }

    [Fact]
    public void YieldBreak_InsideTryFinally_RunsFinally()
    {
        var source = @"
class Probe {
    shared {
        var Cleaned bool = false
    }
}

func Items() sequence[int32] {
    try {
        yield 1
        yield break
    } finally {
        Probe.Cleaned = true
    }
}

var total = 0
for _, v in Items() {
    total += v
}
if Probe.Cleaned {
    total += 10
}
total
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(11, result.Value);
    }

    [Fact]
    public void YieldBreak_OutsideIterator_ReportsDiagnostic()
    {
        var source = @"
func NotIterator() int32 {
    yield break
    return 1
}
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.IsError);
    }
}
