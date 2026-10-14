// <copyright file="SwitchStatementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 2.6: `switch` statements over int / string / bool with required
/// brace-block case bodies and no implicit fallthrough (ADR-0013).
open class SwitchStatementTests {
    @Fact
    func Switch_Int_Binds() {
        let src = `func F() {
 var x = 1
 switch x {
 case 1 { var a = "one" }
 case 2 { var b = "two" }
 default { var c = "other" }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_String_Binds() {
        let src = `func F() {
 var s = "hi"
 switch s {
 case "hi" { var a = 1 }
 case "bye" { var b = 2 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_Bool_Binds() {
        let src = `func F() {
 var b = true
 switch b {
 case true { var x = 1 }
 case false { var y = 2 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_Without_Default_Binds() {
        let src = `func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_Case_Type_Mismatch_Reports_Error() {
        let src = `func F() {
 var x = 1
 switch x {
 case "hi" { var a = 1 }
 }
}
`
        let diagnostics = Bind(src)
        Assert.NotEmpty(diagnostics)
    }

    @Fact
    func Switch_Duplicate_Default_Reports_Error() {
        let src = `func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 default { var c = 3 }
 }
}
`
        let diagnostics = Bind(src)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("default", StringComparison.OrdinalIgnoreCase)
        )
    }

    @Fact
    func Fallthrough_ToPlainConstantArm_BindsClean() {
        // Issue #3501 A3: `fallthrough` gained Go semantics — a trailing
        // fallthrough into a binding-free arm is legal (the target's
        // body-local declarations still run normally). Misuse coverage lives
        // in Issue3501SwitchFamilyTests (GS0168/GS0533/GS0534).
        let src = `func F() {
 var x = 1
 switch x {
 case 1 { fallthrough }
 case 2 { var a = 1 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_Default_NotLast_Still_Routes_Correctly() {
        // Default in the middle still binds; semantic equivalence verified by
        // the chain construction in BindSwitchStatement.
        let src = `func F() {
 var x = 1
 switch x {
 case 1 { var a = 1 }
 default { var b = 2 }
 case 3 { var c = 3 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    // Issue #991: `when` guards on switch-statement arms.
    @Fact
    func Switch_WhenGuard_Binds() {
        let src = `func F() {
 var x = 5
 switch x {
 case > 0 when x < 10 { var a = "small" }
 case > 0 { var b = "big" }
 default { var c = "nonpositive" }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_NonBoolGuard_Diagnoses() {
        let src = `func F() {
 var x = 1
 switch x {
 case > 0 when x { var a = 1 }
 default { var b = 2 }
 }
}
`
        let diagnostics = Bind(src)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains("Cannot convert type", StringComparison.Ordinal) && d.Message.Contains(
                "'bool'",
                StringComparison.Ordinal
            )
        )
    }

    // Issue #992: a binding type pattern under `or` / `not` is rejected (GS0390),
    // because the variable would not be definitely assigned when the arm runs.
    @Fact
    func Switch_TypePatternBindingUnderOr_Diagnoses() {
        let src = `open class Animal { var Name string }
class Dog : Animal { }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case d is Dog or e is Cat { var x = 1 }
 default { var y = 2 }
 }
}
`
        let diagnostics = Bind(src)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Message.Contains(
                "may not be declared under an 'or' or 'not' pattern",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Switch_DiscardTypePatternUnderOr_IsAllowed() {
        // Discard (`_`) type patterns under `or` introduce no binding and are
        // permitted.
        let src = `open class Animal { var Name string }
class Dog : Animal { }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case _ is Dog or _ is Cat { var x = 1 }
 default { var y = 2 }
 }
}
`
        Assert.Empty(Bind(src))
    }

    // Issue #992: smart-cast under `and` narrows the discriminant in the arm
    // body; under `or` it does NOT (which keeps the narrowing sound).
    @Fact
    func Switch_TypePatternUnderAnd_NarrowsDiscriminant() {
        let src = `open class Animal { var Name string }
class Dog : Animal { func Bark() string { return "woof" } }
func F(a Animal) {
 switch a {
 case d is Dog and { Name: "Rex" } { var s = a.Bark() }
 default { }
 }
}
`
        Assert.Empty(Bind(src))
    }

    @Fact
    func Switch_TypePatternUnderOr_DoesNotNarrowDiscriminant() {
        // `a` is not narrowed across an `or`, so `a.Bark()` (defined only on Dog)
        // does not resolve.
        let src = `open class Animal { var Name string }
class Dog : Animal { func Bark() string { return "woof" } }
class Cat : Animal { }
func F(a Animal) {
 switch a {
 case _ is Dog or _ is Cat { var s = a.Bark() }
 default { }
 }
}
`
        let diagnostics = Bind(src)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("Bark", StringComparison.Ordinal))
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
