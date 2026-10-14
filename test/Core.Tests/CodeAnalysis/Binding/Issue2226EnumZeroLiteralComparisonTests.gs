// <copyright file="Issue2226EnumZeroLiteralComparisonTests.cs" company="GSharp">
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

/// Issue #2226: `==` / `!=` between an enum type and the integer literal `0`
/// previously reported GS0129 ("Binary operator '!=' is not defined for
/// types 'System.IO.UnixFileMode' and 'int32'"), blocking the common
/// bitwise-flag-test idiom `(flags & Bit) != 0` — the `&` of two
/// same-typed flags enums already produced an enum-typed result (per the
/// existing (cref:GSharp.Core.CodeAnalysis.Binding.EnumOperatorTable)
/// bitwise arm), but comparing that result against `0` had no adaptation.
/// Per C# §10.2.4, the literal `0` (and only `0`) implicitly converts to any
/// enum type without a cast, so `enum == 0` / `enum != 0` (either operand
/// order) is now accepted for both source-declared G# enums and imported CLR
/// (including `[Flags]`) enums; any other integer literal/constant against an
/// enum is still rejected, matching C#.
open class Issue2226EnumZeroLiteralComparisonTests {
    // ── source-declared G# enum ────────────────────────────────────────
    @Fact
    func SourceEnum_NotEqualsZero_Binds() {
        let source = `
enum Color { Red, Green, Blue }
let c = Color.Red
c != 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value) // Red == 0

    }

    @Fact
    func SourceEnum_EqualsZero_Binds() {
        let source = `
enum Color { Red, Green, Blue }
let c = Color.Green
c == 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value) // Green == 1

    }

    @Fact
    func ZeroEqualsSourceEnum_ReversedOperandOrder_Binds() {
        let source = `
enum Color { Red, Green, Blue }
let c = Color.Red
0 == c
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ZeroNotEqualsSourceEnum_ReversedOperandOrder_Binds() {
        let source = `
enum Color { Red, Green, Blue }
let c = Color.Blue
0 != c
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    // ── imported CLR [Flags] enum ───────────────────────────────────────
    @Fact
    func ImportedFlagsEnum_NotEqualsZero_Binds() {
        let source = `
import System

let m = ConsoleModifiers.Alt
m != 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ImportedFlagsEnum_EqualsZero_Binds() {
        let source = `
import System

let m = ConsoleModifiers.None
m == 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ImportedUnixFileMode_NotEqualsZero_Binds() {
        let source = `
import System.IO

let mode = UnixFileMode.UserRead
mode != 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    // ── the actual flags-check idiom: `(flags & Bit) != 0` ──────────────
    @Fact
    func FlagsMaskIdiom_BitSet_EvaluatesTrue() {
        let source = `
import System

let m = ConsoleModifiers.Alt | ConsoleModifiers.Shift
let bit = m & ConsoleModifiers.Alt
bit != 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func FlagsMaskIdiom_BitNotSet_EvaluatesFalse() {
        let source = `
import System

let m = ConsoleModifiers.Alt | ConsoleModifiers.Shift
let bit = m & ConsoleModifiers.Control
bit != 0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(false, result.Value)
    }

    // ── non-zero integer literals against an enum still error ──────────
    @Fact
    func SourceEnum_EqualsNonZeroLiteral_StillReportsGS0129() {
        let source = `
enum Color { Red, Green, Blue }
let c = Color.Red
c == 1
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("GS0129", StringComparison.Ordinal) || d.Message.Contains(
                "is not defined for types",
                StringComparison.Ordinal
            )
        )
    }

    // ── compiled + executed idiom, using the natural `(flags & Bit) != 0`
    //    shape as written inside a function body (parenthesized inline,
    //    matching the exact idiom migrated from C#) ──────────────────────
    @Fact
    func CompiledAndExecuted_FlagsMaskIdiom_MatchesRuntimeBehavior() {
        let source = `
import System

func hasAlt(m ConsoleModifiers) bool {
    return (m & ConsoleModifiers.Alt) != 0
}

Console.WriteLine(hasAlt(ConsoleModifiers.Alt | ConsoleModifiers.Shift))
Console.WriteLine(hasAlt(ConsoleModifiers.Shift | ConsoleModifiers.Control))
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
            "CompiledAndExecuted_FlagsMaskIdiom_MatchesRuntimeBehavior",
            isCollectible: true
        )
        try {
            let asm = loadContext.LoadFromStream(peStream)
            let programType = asm.GetTypes().First((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = programType.GetMethod(
                "<Main>$$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(entry)
            let stdout = Console.Out
            let captured = StringWriter()
            Console.SetOut(captured)
            try {
                entry!!.Invoke(
                    nil,
                    if entry!!.GetParameters().Length == 0 {
                        default([]?object)
                    } else {
                        []object{Array.Empty[string]()}
                    }
                )
            } finally {
                Console.SetOut(stdout)
            }
            let lines = captured.ToString().Split([]string{"\r\n", "\n"}, StringSplitOptions.RemoveEmptyEntries)
            Assert.Equal([]string{"True", "False"}, lines)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
