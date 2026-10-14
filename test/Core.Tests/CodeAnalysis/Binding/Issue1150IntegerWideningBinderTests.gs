// <copyright file="Issue1150IntegerWideningBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1150: implicit, lossless integer widening is applied when matching a
/// typed integer value (including a lambda body) to an expected integer type
/// during overload resolution, argument/lambda-return conversion, and binary
/// operators. This mirrors C#'s implicit-conversion lattice
/// (`byte→int`, `uint→long`, `int→long`, …). Narrowing and
/// non-widening mixed pairs still require an explicit cast.
open class Issue1150IntegerWideningBinderTests {
    // ── PRIMARY repro: LINQ Sum over a uint32 selector ─────────────────
    @Fact
    func SumOverUInt32Selector_ResolvesToInt64Overload_NoDiagnostics() {
        // The selector `(i Item) -> i.Size` has natural type Func<Item,uint32>.
        // uint32 widens to int64, selecting Enumerable.Sum(Func<T,long>) — so
        // the Sum result is int64 and `int32(...)` of it is valid. If the
        // widening did not apply, Sum would appear "not found" (GS0159) and
        // the lambda parameter `i` would never be typed, cascading GS0158
        // "cannot find member" on `i.Size`.
        let source = `
package p
import System.Collections.Generic
import System.Linq
class Item { var Size uint32 }
class C {
    func TotalU(items List[Item]) int32 {
        return int32(items.Sum((i Item) -> i.Size))
    }
}
`
        let errors = Errors(source)
        Assert.Empty(errors)
    }

    @Fact
    func SumOverUInt32Selector_NoMemberCascade() {
        // Specifically assert the lambda parameter gets typed (no GS0158
        // "cannot find member" cascade) and Sum is found (no GS0159).
        let source = `
package p
import System.Collections.Generic
import System.Linq
class Item { var Size uint32 }
class C {
    func TotalU(items List[Item]) int32 {
        return int32(items.Sum((i Item) -> i.Size))
    }
}
`
        let errors = Errors(source)
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS0159")
        Assert.DoesNotContain(errors, (d Diagnostic) -> d.Id == "GS0158")
    }

    // ── Lambda return widening to a delegate parameter ─────────────────
    @Fact
    func LambdaReturnWidening_ToUserFunctionDelegateParam_Compiles() {
        // `(x int32) -> uint16(x)` has natural type Func<int32,uint16>; uint16
        // widens to int64, so it is applicable to Func<int32,int64>.
        let source = `
package p
import System
class C {
    func Apply(f Func[int32,int64]) int64 { return f(10) }
    func Use() int64 { return this.Apply((x int32) -> uint16(x)) }
}
`
        Assert.Empty(Errors(source))
    }

    // ── Binary mixed-width integer operators ───────────────────────────
    @Theory
    @InlineData("a uint32, b int64", "a + b", "int64")
    @InlineData("a uint8, b int32", "a + b", "int32")
    @InlineData("a int32, b int64", "a + b", "int64")
    @InlineData("a uint32, b int64", "a - b", "int64")
    @InlineData("a uint32, b int64", "a * b", "int64")
    @InlineData("a uint8, b int32", "a | b", "int32")
    @InlineData("a uint8, b int32", "a & b", "int32")
    @InlineData("a uint8, b int32", "a ^ b", "int32")
    func BinaryMixedWidth_WidensAndBinds(parms string, expr string, ret string) {
        let source = Wrap("func F($parms) $ret { return $expr }")
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("a < b")
    @InlineData("a > b")
    @InlineData("a == b")
    @InlineData("a != b")
    @InlineData("a <= b")
    @InlineData("a >= b")
    func BinaryMixedWidth_Comparisons_ProduceBool(expr string) {
        let source = Wrap("func F(a uint32, b int64) bool { return $expr }")
        Assert.Empty(Errors(source))
    }

    // ── Guardrails: non-widening / narrowing / lossy still error ───────
    @Fact
    func BinaryNonWideningPair_Int32VsUInt32_StillErrorsGS0129() {
        // Neither int32 nor uint32 implicitly converts to the other, so the
        // operator stays unbound (no C# int+uint→long promotion in G#).
        let source = Wrap("func F(a int32, b uint32) int64 { return int64(a + b) }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func BinaryNarrowing_RequiresCast_StillErrors() {
        // int64 var assigned into an int32 local is a narrowing — still GS0156.
        let source = Wrap("func F(a int64) int32 { let x int32 = a return x }")
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0156")
    }

    @Fact
    func LambdaReturnNarrowing_ToDelegateParam_StillErrors() {
        // int64 does NOT widen to int32, so the literal is inapplicable.
        let source = `
package p
import System
class C {
    func Apply(f Func[int32,int32]) int32 { return f(10) }
    func Use() int32 { return this.Apply((x int32) -> int64(x)) }
}
`
        Assert.NotEmpty(Errors(source))
    }

    @Fact
    func LambdaReturnFloat_ToIntDelegateParam_StillErrors() {
        // float→int is lossy and must NOT be applied implicitly.
        let source = `
package p
import System
class C {
    func Apply(f Func[int32,int64]) int64 { return f(10) }
    func Use() int64 { return this.Apply((x int32) -> 1.5) }
}
`
        Assert.NotEmpty(Errors(source))
    }

    shared {
        private func Wrap(member string) string {
            return `
package p
class C {
    ` + member + `
}
`
        }

        private func Errors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
        }
    }
}
