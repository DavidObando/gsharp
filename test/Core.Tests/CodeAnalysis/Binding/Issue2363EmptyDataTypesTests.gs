// <copyright file="Issue2363EmptyDataTypesTests.cs" company="GSharp">
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

/// Issue #2363: Emitted-oracle coverage for empty data types.
/// Traceability: ADR-0029; diagnostic GS0104.
open class Issue2363EmptyDataTypesTests {
    @Fact
    func DataStruct_ZeroFields_NoParens_BindsWithoutGs0104() {
        let result = Evaluate(`
data struct Empty {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataStruct_ZeroFields_ExplicitEmptyParens_BindsWithoutGs0104() {
        let result = Evaluate(`
data struct Empty() {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_ZeroFields_NoParens_BindsWithoutGs0104() {
        let result = Evaluate(`
data class Empty {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_ZeroFields_ExplicitEmptyParens_BindsWithoutGs0104() {
        let result = Evaluate(`
data class Empty() {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_ZeroFields_Sealed_BindsWithoutGs0104() {
        let result = Evaluate(`
open data class Base {
}
data class Derived() : Base {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataClass_ZeroFields_Open_BindsWithoutGs0104() {
        let result = Evaluate(`
open data class Base {
}
open data class Derived() : Base {
}
0
`)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DataStruct_ZeroFields_TwoInstances_AreEqual() {
        let result = Evaluate(`
data struct Empty {
}
var a = Empty{}
var b = Empty{}
a == b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataClass_ZeroFields_TwoInstances_AreEqualByValue() {
        let result = Evaluate(`
data class Empty() {
}
var a = Empty()
var b = Empty()
a == b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataClass_ZeroFields_SiblingTypes_AreNotEqual() {
        // Sibling zero-field data classes derived from a common open base
        // are never equal to one another — matching C# record semantics
        // (Equals(Name) dispatches on the declared type of the typed
        // overload; a different sibling type never satisfies it). This is a
        // pre-existing, deliberate leaf-type-only limitation, not a
        // regression introduced by #2363's zero-field relaxation.
        let result = Evaluate(`
open data class Base {
}
data class Mfa() : Base {
}
data class Cvf() : Base {
}
var a = Mfa()
var b Base = Cvf()
a.Equals(b)
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    @Fact
    func DataClass_ZeroFields_Copy_ReturnsEqualInstance() {
        // Emitted-oracle pin for structural (value) equality of the copy.
        // Reference-distinctness is verified separately in Compiler.Tests
        // (Issue2363EmptyDataTypesEmitTests).
        let result = Evaluate(`
data class Empty() {
}
var a = Empty()
var b = a.copy()
a == b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataClass_ZeroFields_With_ReturnsEqualInstance() {
        // `with { }` (zero overrides — there is nothing to override on a
        // zero-field type) must still parse/bind and produce a value-equal
        // copy.
        let result = Evaluate(`
data class Empty() {
}
var a = Empty()
var b = a with { }
a == b
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func DataStruct_ZeroFields_ToString_RendersRecordFormatWithEmptyBraces() {
        let result = Evaluate(`
data struct Empty {
}
var a = Empty{}
a.ToString()
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("Empty { }", result.Value)
    }

    @Fact
    func DataStruct_ZeroFields_ExplicitDeconstruct_StillReportsGs0232() {
        // GS0104 no longer fires for the zero-field declaration itself, but
        // the "no hand-written synthesized members" rule is unaffected: a
        // user-declared Deconstruct on a zero-field data struct is still
        // rejected (GS0232), same as it would be for a nonempty one.
        let result = Evaluate(`
data struct Empty {
    func Deconstruct() {
    }
}
0
`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0232")
    }

    @Fact
    func DataClass_ZeroFields_PropertyOverride_MatchesOahuCallbackChallengeShape() {
        // Verbatim shape of Oahu.Cli.App/Auth/CallbackBroker.cs: an open
        // base record with only an abstract computed property (no
        // positional data of its own) plus zero-field derived sealed
        // records that each override that property. Confirms the
        // GetSynthesisFields backing-field-null-filter fix: a computed
        // override property with no backing field must not be treated as a
        // synthesis field (which previously crashed field-token
        // resolution).
        let result = Evaluate(`
open data class CallbackChallenge {
    open prop Kind string {
        get -> "base"
    }
}
data class MfaChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "mfa"
    }
}
data class CvfChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "cvf"
    }
}
data class ApprovalChallenge() : CallbackChallenge {
    override prop Kind string {
        get -> "approval"
    }
}
var mfa = MfaChallenge()
var cvf = CvfChallenge()
var approval = ApprovalChallenge()
mfa.Kind + " " + cvf.Kind + " " + approval.Kind
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("mfa cvf approval", result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
