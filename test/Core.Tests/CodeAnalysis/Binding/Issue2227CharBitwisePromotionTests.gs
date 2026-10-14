// <copyright file="Issue2227CharBitwisePromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2227: the bitwise (`^`, `&`, `|`) and shift
/// (`<<`, `>>`) operators must be defined for
/// `char` operands, matching C# §12.4.7 binary numeric promotion:
/// both operands promote to `int32` and the result is `int32`.
/// Discovered migrating a constant-time-comparison idiom
/// (`diff |= a[i] ^ b[i]`, `a`/`b` strings) from C#.
open class Issue2227CharBitwisePromotionTests {
    @Fact
    func CharXorChar_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var b char = 'b'
var c = a ^ b
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') ^ int32('b'), vars["c"])
    }

    @Fact
    func CharAndChar_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var b char = 'b'
var c = a & b
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') & int32('b'), vars["c"])
    }

    @Fact
    func CharOrChar_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var b char = 'b'
var c = a | b
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') | int32('b'), vars["c"])
    }

    /// Exercises `char &^ char` (BitClear, lowered to `a & ~b`),
    /// through the emitted oracle and verifies the promoted `int32` result.
    @Fact
    func CharBitClearChar_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var b char = 'b'
var c = a &^ b
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') & ~int32('b'), vars["c"])
    }

    @Fact
    func CharShiftLeftInt32_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var c = a << 2
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') << 2, vars["c"])
    }

    @Fact
    func CharShiftRightInt32_PromotesToInt32() {
        let (eval, vars) = EvaluateWithVariables(`
var a char = 'a'
var c = a >> 2
`)
        Assert.Empty(eval.Diagnostics)
        Assert.IsType[int32](vars["c"])
        Assert.Equal(int32('a') >> 2, vars["c"])
    }

    /// The exact idiom from the issue: `diff |= a[i] ^ b[i]` where
    /// `a`/`b` are strings (so `a[i]`/`b[i]` are
    /// `char`), accumulating a constant-time comparison across two
    /// equal-length strings. Verifies both that it compiles and that the
    /// runtime XOR/OR-accumulation value is correct: equal strings leave
    /// `diff == 0`, a single differing character makes it non-zero.
    @Theory
    @InlineData("abcd", "abcd", int32(0))
    @InlineData("abcd", "abcE", int32(33))
    func ConstantTimeCompareIdiom_EvaluatesCorrectDiff(left string, right string, expectedDiff int32) {
        let (eval, vars) = EvaluateWithVariables((`
var a string = "` + "$left" + `"
var b string = "` + "$right" + `"
var diff int32 = 0
var i int32 = 0
while i < 4 {
    diff |= a[i] ^ b[i]
    i += 1
}
`))
        Assert.Empty(eval.Diagnostics)
        Assert.Equal(expectedDiff, vars["diff"])
    }

    /// Compiles the exact repro from issue #2227 to IL, loads it, and calls
    /// the compiled `constantTimeCompare` function directly (no
    /// top-level statements, no (cref:Console) capture) — verifying
    /// the emitter produces the correct `int32` XOR-accumulated result for
    /// `char` operands sourced
    /// from string indexing. Asserting on the returned value directly
    /// avoids the process-global `Console.SetOut` state that would
    /// otherwise race with other tests under xUnit's default parallelization.
    @Fact
    func CompiledAndExecuted_ConstantTimeCompareIdiom_MatchesRuntimeBehavior() {
        let source = `
func constantTimeCompare(a string, b string) int32 {
    var diff int32 = 0
    var i int32 = 0
    while i < 4 {
        diff |= a[i] ^ b[i]
        i += 1
    }
    return diff
}
`
        using let peStream = MemoryStream()
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let emitResult = compilation.Emit(peStream)
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join(
                "; ",
                emitResult.Diagnostics.Select((d Diagnostic) -> d.Message)
            )
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext(
            "CompiledAndExecuted_ConstantTimeCompareIdiom_MatchesRuntimeBehavior",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType = asm.GetTypes().First((t Type) -> t.Name == "<Program>")
            let constantTimeCompare MethodInfo? = programType.GetMethod(
                "constantTimeCompare",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(constantTimeCompare)
            let equal object? = constantTimeCompare!!.Invoke(nil, []object{"abcd", "abcd"})
            let differing object? = constantTimeCompare!!.Invoke(nil, []object{"abcd", "abcE"})
            Assert.Equal(0, equal)
            Assert.Equal('d' ^ 'E', differing)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func EvaluateWithVariables(source string)(
            Result EmittedOracleResult,
            Variables IReadOnlyDictionary[string, object?]
        ) {
            // Post-run globals read back through the oracle (issue #3176 Phase
            // 3b.2): the emitted equivalent of the evaluator's variables
            // dictionary.
            let result = EmittedOracle.Evaluate(source)
            return (result, result.ReadGlobals())
        }
    }
}
