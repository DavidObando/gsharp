// <copyright file="Issue2553RepeatedDiscardBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import Xunit

open class Issue2553RepeatedDiscardBinderTests {
    @Fact
    func RepeatedDiscards_BindInTupleLetAssignmentAndLoop() {
        const source = `var value = 0
let (kept, _, _) = (1, 2, 3)
value, _, _ = 4, 5, 6
for (item, _, _) in [1](int32, int32, int32){(7, 8, 9)} {
    value = value + item
}`
        Assert.Empty(Evaluate(source).Diagnostics)
    }

    @Theory
    @InlineData("let (name, name, _) = (1, 2, 3)")
    @InlineData("for (name, name, _) in [1](int32, int32, int32){(1, 2, 3)} { }")
    func RepeatedRealNames_StillReportGS0102(statement string) {
        let result = Evaluate(statement)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0102")
    }

    @Fact
    func TupleDiscard_DoesNotEnterLookupScope() {
        let result = Evaluate("let (value, _, _) = (1, 2, 3)\n_")
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0125")
    }

    @Fact
    func RepeatedDiscardDeclarations_BindAndDispose() {
        let result = Evaluate(`import System

class Resource : IDisposable {
    func Dispose() { }
}

func Run() {
    let _ = 1
    let _ = 2
    using let _ = Resource{}
    using let _ = Resource{}
}

Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
