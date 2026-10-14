// <copyright file="Issue1988NarrowedStructFieldAssignmentBinderTests.cs" company="GSharp">
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

/// Issue #1988 (follow-up to #1917/#1982): confirms that a smart-cast-narrowed
/// struct local (ADR-0069 — an `object`-declared variable narrowed by an
/// `is` type-test) can never reach `EmitFieldAssignment`'s
/// struct-field-write path as a field-assignment TARGET. `BoundFieldAssignmentExpression.Receiver`
/// is a bare (cref:VariableSymbol) with no narrowing information, and
/// `BindFieldAssignmentExpression` dispatches to the struct branch using
/// the receiver's raw declared type, not any narrowed type — so a narrowed
/// `object` local is rejected as "member not found" (GS0158) before emission
/// ever sees it. This proves the `TryLoadVariableAddress` call sites in
/// `EmitFieldAssignment` (unmigrated to `TryLoadStructVariableAddress`
/// per the #1988 audit) are unreachable for narrowed receivers and therefore
/// safe as-is.
open class Issue1988NarrowedStructFieldAssignmentBinderTests {
    @Fact
    func NarrowedStructLocal_FieldAssignmentTarget_ReportsGS0158() {
        let source = `
struct Money {
    var Cents int32
}

var a = Money{ Cents: 100 }
var oa object = a
if oa is Money {
    oa.Cents = 200
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0158")
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
