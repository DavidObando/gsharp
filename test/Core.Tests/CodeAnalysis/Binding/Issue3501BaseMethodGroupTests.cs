// <copyright file="Issue3501BaseMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3501: <c>base.M</c> used as a method GROUP (not an immediate call)
/// binds over <c>this</c> with non-virtual dispatch, so the resulting function
/// value captures the BASE implementation — exactly like C#'s <c>base.M</c>
/// delegate conversion. Previously only the immediate-call form was supported
/// (GS0384 otherwise).
/// </summary>
public class Issue3501BaseMethodGroupTests
{
    [Fact]
    public void BaseMethodGroup_CapturesTheBaseImplementation_NonVirtually()
    {
        // If the group dispatched virtually it would re-enter the override
        // (infinite recursion); the base body computes n + 1, so 4 → 5 → 50.
        var source = @"
open class Walker {
    public open func Visit(n int32) int32 {
        return n + 1
    }
}

class Anchored : Walker {
    public override func Visit(n int32) int32 {
        return Apply(n, base.Visit)
    }

    private func Apply(n int32, f (int32) -> int32) int32 {
        return f(n) * 10
    }
}

Anchored().Visit(4)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(50, result.Value);
    }

    [Fact]
    public void BaseAccess_UnknownMember_StillReportsGS0384()
    {
        var source = @"
open class Walker {
    public open func Visit(n int32) int32 {
        return n + 1
    }
}

class Anchored : Walker {
    public override func Visit(n int32) int32 {
        let f = base.Missing
        return n
    }
}

Anchored().Visit(4)
";
        var result = EmittedOracle.Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0384");
    }
}
