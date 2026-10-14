// <copyright file="Issue2534BaseClassCallBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System.Collections.Generic
import Xunit

/// Issue #2534: binding and evaluation coverage for canonical base calls.
open class Issue2534BaseClassCallBinderTests {
    @Fact
    func DerivedOverride_BaseCallResultChain_BindsAndRuns() {
        const source = `open class Formatter {
    open func Format(value int32) string { return "number" }
}

class LoudFormatter() : Formatter {
    override func Format(value int32) string {
        return base.Format(value).ToUpperInvariant()
    }
}

LoudFormatter().Format(1)`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("NUMBER", result.Value)
    }

    @Fact
    func DerivedOverride_BaseCall_SelectsMatchingOverload() {
        const source = `open class Formatter {
    open func Format(value int32) string { return "number" }
    open func Format(value string) string { return "text" }
}

class DerivedFormatter() : Formatter {
    override func Format(value int32) string {
        return base.Format(value)
    }
}

DerivedFormatter().Format(1)`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("number", result.Value)
    }

    @Fact
    func ValueNamedBase_MemberCall_RemainsOrdinaryCall() {
        const source = `class Helper {
    func Value() int32 { return 42 }
}

var base = Helper()
base.Value()`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
