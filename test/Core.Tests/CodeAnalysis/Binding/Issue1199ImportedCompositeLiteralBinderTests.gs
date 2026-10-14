// <copyright file="Issue1199ImportedCompositeLiteralBinderTests.cs" company="GSharp">
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

/// Issue #1199: a composite literal `T{Member: value}` must also resolve
/// and assign settable members on an IMPORTED reference-type class (a BCL
/// class such as `System.Text.StringBuilder`) — exactly the cases that
/// already work in constructor-call position. A read-only / get-only member is
/// still not settable, and an unknown member is still diagnosed.
open class Issue1199ImportedCompositeLiteralBinderTests {
    @Fact
    func ImportedClassLiteral_SettableProperty_BindsAndEvaluates() {
        let source = `
import System.Text

let sb = StringBuilder{Capacity: 128}
sb.Capacity
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(128, result.Value)
    }

    @Fact
    func ImportedClassLiteral_NoInitializers_Binds() {
        let source = `
import System.Text

let sb = StringBuilder{}
sb.Capacity
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ImportedClassLiteral_GetOnlyMember_IsDiagnosed() {
        let source = `
import System.Text

let sb = StringBuilder{MaxCapacity: 5}
sb.MaxCapacity
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("read-only"))
    }

    @Fact
    func ImportedClassLiteral_UnknownMember_IsDiagnosed() {
        let source = `
import System.Text

let sb = StringBuilder{Missing: 5}
sb.Capacity
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Message.Contains("Cannot find member"))
    }

    @Fact
    func ImportedClassLiteral_DuplicateMember_IsDiagnosed() {
        let source = `
import System.Text

let sb = StringBuilder{Capacity: 16, Capacity: 32}
sb.Capacity
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
