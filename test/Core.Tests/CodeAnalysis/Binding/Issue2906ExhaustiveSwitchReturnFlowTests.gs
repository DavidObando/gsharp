// <copyright file="Issue2906ExhaustiveSwitchReturnFlowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #2906: closed-discriminant exhaustiveness must feed definite-return
/// analysis without treating guarded, nullable, or incomplete switches as total.
open class Issue2906ExhaustiveSwitchReturnFlowTests {
    @Theory
    @MemberData("ExhaustiveCases")
    func ExhaustiveClosedSwitch_DoesNotReportGs0100(name string, source string) {
        let (diagnostics, emittedLength) = Compile(source)
        Assert.DoesNotContain(diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.True(emittedLength > int64(0))
    }

    @Theory
    @MemberData("NonExhaustiveCases")
    func NonTotalSwitch_ReportsGs0100(name string, source string) {
        let (diagnostics, emittedLength) = Compile(source)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0100")
        Assert.Equal(int64(0), emittedLength)
    }

    @Fact
    func ImportedFlagsEnums_RetainStatementAndExpressionExhaustivenessDiagnostics() {
        const StatementSource = `package Issue2906.FlagsStatement
import System
func F(x StringSplitOptions) {
    switch x {
        case StringSplitOptions.None { }
    }
}`
        const ExpressionSource = `package Issue2906.FlagsExpression
import System
func F(x StringSplitOptions) int32 {
    return switch x {
        case StringSplitOptions.None: 0
    }
}`
        let (statementDiagnostics, _) = Compile(StatementSource)
        let (expressionDiagnostics, _) = Compile(ExpressionSource)
        Assert.Contains(statementDiagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0178")
        Assert.Contains(expressionDiagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0177")
        Assert.DoesNotContain(expressionDiagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0176")
    }

    shared {
        /// Gets exhaustive switches that must not report GS0100.
        func ExhaustiveCases() sequence[[]object] {
            yield Case("OneMember", `enum E { A }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
    }
}`)
            yield Case("TwoMembers", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
    }
}`)
            yield Case("ManyMembers", `enum E { A, B, C, D }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
        case E.C { return 3 }
        case E.D { return 4 }
    }
}`)
            yield Case("RedundantDefault", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
        default { return 3 }
    }
}`)
            yield Case("DuplicateCompleteArms", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.A { return 2 }
        case E.B { return 3 }
    }
}`)
            yield Case("OrPattern", `enum E { A, B, C }
func F(x E) int32 {
    switch x {
        case E.A or E.B { return 1 }
        case E.C { return 2 }
    }
}`)
            yield Case("SealedInterface", `sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func F(x Expr) int32 {
    switch x {
        case _ is Add { return 1 }
        case _ is Mul { return 2 }
    }
}`)
            yield Case("SealedClass", `sealed class Shape { }
class Circle : Shape { }
class Square : Shape { }
func F(x Shape) int32 {
    switch x {
        case _ is Circle { return 1 }
        case _ is Square { return 2 }
    }
}`)
            yield Case("SwitchInsideTry", `enum E { A, B }
func F(x E) int32 {
    try {
        switch x {
            case E.A { return 1 }
            case E.B { return 2 }
        }
    } finally {
    }
}`)
            yield Case("TryInsideArms", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A {
            try {
                return 1
            } finally {
            }
        }
        case E.B {
            try {
                return 2
            } finally {
            }
        }
    }
}`)
            yield Case("SwitchInsideSelect", `enum E { A, B }
func F(x E) int32 {
    select {
        default {
            switch x {
                case E.A { return 1 }
                case E.B { return 2 }
            }
        }
    }
}`)
        }

        /// Gets non-total switches that must still report GS0100.
        func NonExhaustiveCases() sequence[[]object] {
            yield Case("MissingMember", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
    }
}`)
            yield Case("DuplicateMissingMember", `enum E { A, B }
func F(x E) int32 {
    switch x {
        case E.A { return 1 }
        case E.A { return 2 }
    }
}`)
            yield Case("GuardedMember", `enum E { A, B }
func F(x E, allow bool) int32 {
    switch x {
        case E.A { return 1 }
        case E.B when allow { return 2 }
    }
}`)
            yield Case("NullableEnum", `enum E { A, B }
func F(x E?) int32 {
    switch x {
        case E.A { return 1 }
        case E.B { return 2 }
    }
}`)
            yield Case("OrdinaryInt", `func F(x int32) int32 {
    switch x {
        case 0 { return 1 }
        case 1 { return 2 }
    }
}`)
        }

        private func Case(name string, body string)[]object -> []object{
            name,
            "package Issue2906.$name${Environment.NewLine}$body"
        }

        private func Compile(source string)(Diagnostics ImmutableArray[Diagnostic], EmittedLength int64) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return (compilation.Emit(peStream).Diagnostics, peStream.Length)
        }
    }
}
