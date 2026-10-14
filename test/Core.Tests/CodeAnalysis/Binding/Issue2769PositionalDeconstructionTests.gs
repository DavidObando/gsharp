// <copyright file="Issue2769PositionalDeconstructionTests.cs" company="GSharp">
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

class Issue2769PositionalDeconstructionTests {
    @Fact
    func PositionalDataClass_WrongArity_ReportsPositionalPropertyCount() {
        let result = Evaluate(`data class Pair(A int32, B int32) {
    prop Ignored int32 { get; init; }
}
let (only) = Pair(1, 2)`)
        let diagnostic = Assert.Single(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0163")
        Assert.Contains("requires 2 fields but was given 1", diagnostic.Message)
    }

    @Fact
    func OrdinaryClassProperties_DoNotEnableRecordDeconstruction() {
        let result = Evaluate(`class Pair {
    prop A int32 { get; init; }
    prop B int32 { get; init; }
}
let (a, b) = Pair()`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0164")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
