// <copyright file="Issue2388NullableCustomEqualityBinderTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #2388: Emitted-oracle coverage for nullable custom equality.
/// Traceability: issue #2400; diagnostic GS0129.
open class Issue2388NullableCustomEqualityBinderTests {
    @Fact
    func DateTimeNullable_Equality_BindsClean() {
        let source = `
import System
func F(a DateTime?, b DateTime?) bool {
    return a == b
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func DateTimeNullable_Inequality_BindsClean() {
        let source = `
import System
func F(a DateTime?, b DateTime?) bool {
    return a != b
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Theory
    @InlineData("<")
    @InlineData("<=")
    @InlineData(">")
    @InlineData(">=")
    func DateTimeNullable_Ordering_BindsClean(op string) {
        let source = (`
import System
func F(a DateTime?, b DateTime?) bool {
    return a ` + "$op" + ` b
}
`)
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func DateTimeNullable_MixedModeAgainstNonNullable_BindsClean() {
        let source = `
import System
func F(a DateTime?, b DateTime) bool {
    return a == b
}
func G(a DateTime, b DateTime?) bool {
    return a == b
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func DateTimeNullable_AgainstNil_StillBindsCleanViaExistingIsNullCompareArm() {
        // Not touched by this fix (IsNullCompare fires before Stream C/D is
        // ever reached) — regression guard proving the new lifting logic
        // doesn't interfere with it.
        let source = `
import System
func F(a DateTime?) bool {
    return a == nil
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func GuidNullable_EqualityAndInequality_BindClean() {
        let source = `
import System
func F(a Guid?, b Guid?) bool {
    return a == b
}
func G(a Guid?, b Guid?) bool {
    return a != b
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func SameCompilationStruct_NullableEquality_StreamD_BindsClean() {
        // Issue #2388 "directly related deferred work" control: a
        // same-compilation struct's user-defined operator (Stream D) is
        // resolved via TypeMemberModel against the struct symbol; before
        // this fix, `T? == T?` never unwrapped the NullableTypeSymbol
        // before the `is StructSymbol` check and always reported GS0129
        // even though the struct DOES declare `operator ==`.
        let source = `
struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
func (a Meters) operator !=(b Meters) bool -> !(a == b)

func F(a Meters?, b Meters?) bool {
    return a == b
}
func G(a Meters?, b Meters?) bool {
    return a != b
}
`
        AssertNoErrors(Evaluate(source))
    }

    @Fact
    func SameCompilationStruct_WithoutUserOperator_NullableEquality_StillReportsGS0129() {
        // Negative control: the fix only unwraps NullableTypeSymbol to find
        // an EXISTING user operator — it must not fabricate equality for a
        // struct that never declared one.
        let source = `
struct Plain(Value float64) {
}

func F(a Plain?, b Plain?) bool {
    return a == b
}
`
        let result = Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func SameCompilationStruct_NonNullableEquality_StillBindsClean_Regression() {
        // Regression guard: the non-nullable Stream D call path (plain
        // BoundCallExpression, untouched by this fix) still binds.
        let source = `
struct MetersB(Value float64) {
}

func (a MetersB) operator ==(b MetersB) bool -> a.Value == b.Value

func F(a MetersB, b MetersB) bool {
    return a == b
}
`
        AssertNoErrors(Evaluate(source))
    }

    shared {
        private func AssertNoErrors(result EmittedOracleResult) {
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
        }

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
