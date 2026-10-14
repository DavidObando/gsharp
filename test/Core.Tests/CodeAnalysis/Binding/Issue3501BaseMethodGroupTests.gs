// <copyright file="Issue3501BaseMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System.Linq
import Xunit

/// Issue #3501: `base.M` used as a method GROUP (not an immediate call)
/// binds over `this` with non-virtual dispatch, so the resulting function
/// value captures the BASE implementation — exactly like C#'s `base.M`
/// delegate conversion. Previously only the immediate-call form was supported
/// (GS0384 otherwise).
open class Issue3501BaseMethodGroupTests {
    @Fact
    func BaseMethodGroup_CapturesTheBaseImplementation_NonVirtually() {
        // If the group dispatched virtually it would re-enter the override
        // (infinite recursion); the base body computes n + 1, so 4 → 5 → 50.
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        Assert.Equal(50, result.Value)
    }

    @Fact
    func BaseAccess_UnknownMember_StillReportsGS0384() {
        let source = `
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
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0384")
    }
}
