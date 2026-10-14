// <copyright file="Issue2185IndirectCalleeInvocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2185: `callee(args)` must be recognized as an invocation whenever
/// the bound callee expression has a function type, regardless of the callee's
/// syntactic shape. Previously only a bare identifier or member-access callee was
/// invoked; a parenthesized expression (`(h)(value)`), a null-forgiveness
/// (`handler!!(value)`), or a smart-cast-narrowed nullable function field
/// (`hn(value)` after an `== nil` guard) were not, producing a bogus
/// GS0155 conversion error or GS0131 "is not a function". These tests confirm all
/// three shapes bind AND execute with correct results (including the generic
/// substitution preserved for `(T) -> TResult` fields), while a callee that
/// is genuinely not function-typed still errors.
open class Issue2185IndirectCalleeInvocationEmitTests {
    @Fact
    func NullForgivenParenthesizedAndNarrowedCallees_Bind() {
        // The exact repros from issue #2185 (all three previously errored).
        const Source = `
package R

class C[T, TResult] {
    private let handler ((T) -> TResult)?
    func Use(value T) TResult {
        if handler == nil { return default(TResult) }
        return handler!!(value)
    }
}

class E[T, TResult] {
    private let h (T) -> TResult
    func A(value T) TResult { return (h)(value) }
}

class F[T, TResult] {
    private let hn ((T) -> TResult)?
    func B(value T) TResult {
        if hn == nil { return default(TResult) }
        return hn(value)
    }
}
`
        let diagnostics = GetDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func BareIdentifierAndAssignedLocalCallees_StillBind() {
        // The issue's controls: a bare non-null identifier callee and an
        // asserted-to-local callee already compiled and must not regress.
        const Source = `
package R

class D[T, TResult] {
    private let h (T) -> TResult
    func A(value T) TResult { return h(value) }
}

class G[T, TResult] {
    private let handler ((T) -> TResult)?
    func A(value T) TResult {
        let h = handler!!
        return h(value)
    }
}
`
        let diagnostics = GetDiagnostics(Source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func NonFunctionParenthesizedCallee_ReportsNotAFunction() {
        // Negative check: invoking a non-function-typed expression must still be
        // rejected (GS0131) — the generalization keys off the bound function type,
        // so an int32-typed `(value)` callee is not over-accepted.
        const Source = `
package R
class N {
    func A(value int32) int32 { return (value)(1) }
}
`
        let diagnostics = GetDiagnostics(Source).ToList()
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func NullForgivenCallee_ExecutesAndReturnsValue() {
        // `handler!!(value)` on a populated nullable field runs the delegate.
        const Source = `package Issue2185NullForgiven
import System

class C {
    private let handler ((int32) -> int32)?
    init(h ((int32) -> int32)?) { handler = h }
    func Use(value int32) int32 {
        if handler == nil { return -1 }
        return handler!!(value)
    }
}

func run() {
    let dbl = (x int32) -> x * 2
    var c = C(dbl)
    Console.WriteLine(c.Use(21))
}

run()
`
        let output = CompileAndRun(Source, "Issue2185NullForgiven")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("42", lines[0])
    }

    @Fact
    func ParenthesizedCallee_ExecutesAndReturnsValue() {
        // `(h)(value)` on a non-null function field runs the delegate.
        const Source = `package Issue2185Parenthesized
import System

class E {
    private let h (int32) -> int32
    init(f (int32) -> int32) { h = f }
    func A(value int32) int32 { return (h)(value) }
}

func run() {
    let inc = (x int32) -> x + 1
    var e = E(inc)
    Console.WriteLine(e.A(41))
}

run()
`
        let output = CompileAndRun(Source, "Issue2185Parenthesized")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("42", lines[0])
    }

    @Fact
    func NarrowedNullableFieldCallee_ExecutesAndReturnsValue() {
        // `hn(value)` after an `== nil` guard invokes the smart-cast-narrowed
        // (now non-null) function field.
        const Source = `package Issue2185Narrowed
import System

class F {
    private let hn ((int32) -> int32)?
    init(h ((int32) -> int32)?) { hn = h }
    func B(value int32) int32 {
        if hn == nil { return -1 }
        return hn(value)
    }
}

func run() {
    let dbl = (x int32) -> x * 2
    var f = F(dbl)
    Console.WriteLine(f.B(21))
}

run()
`
        let output = CompileAndRun(Source, "Issue2185Narrowed")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("42", lines[0])
    }

    @Fact
    func CurriedCallAndParenthesizedLocal_ExecuteAndReturnValues() {
        // A curried `f()(x)` and a parenthesized-local `(f)(x)` are both indirect
        // invocations of the returned/parenthesized function value.
        const Source = `package Issue2185Curried
import System

func makeAdder(delta int32) (int32) -> int32 {
    return (x int32) -> x + delta
}

func run() {
    Console.WriteLine(makeAdder(10)(5))
    let f = makeAdder(3)
    Console.WriteLine((f)(4))
}

run()
`
        let output = CompileAndRun(Source, "Issue2185Curried")
        let lines = output.Split([]string{Environment.NewLine, "\n"}, StringSplitOptions.RemoveEmptyEntries)
        Assert.Equal("15", lines[0])
        Assert.Equal("7", lines[1])
    }

    shared {
        private func GetDiagnostics(source string) IEnumerable[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation.Emit(peStream).Diagnostics
        }

        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
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
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
