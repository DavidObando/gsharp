// <copyright file="Issue2185IndirectCalleeInvocationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2185: <c>callee(args)</c> must be recognized as an invocation whenever
/// the bound callee expression has a function type, regardless of the callee's
/// syntactic shape. Previously only a bare identifier or member-access callee was
/// invoked; a parenthesized expression (<c>(h)(value)</c>), a null-forgiveness
/// (<c>handler!!(value)</c>), or a smart-cast-narrowed nullable function field
/// (<c>hn(value)</c> after an <c>== nil</c> guard) were not, producing a bogus
/// GS0155 conversion error or GS0131 "is not a function". These tests confirm all
/// three shapes bind AND execute with correct results (including the generic
/// substitution preserved for <c>(T) -&gt; TResult</c> fields), while a callee that
/// is genuinely not function-typed still errors.
/// </summary>
public class Issue2185IndirectCalleeInvocationEmitTests
{
    [Fact]
    public void NullForgivenParenthesizedAndNarrowedCallees_Bind()
    {
        // The exact repros from issue #2185 (all three previously errored).
        const string Source = @"
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
";
        var diagnostics = GetDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void BareIdentifierAndAssignedLocalCallees_StillBind()
    {
        // The issue's controls: a bare non-null identifier callee and an
        // asserted-to-local callee already compiled and must not regress.
        const string Source = @"
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
";
        var diagnostics = GetDiagnostics(Source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void NonFunctionParenthesizedCallee_ReportsNotAFunction()
    {
        // Negative check: invoking a non-function-typed expression must still be
        // rejected (GS0131) — the generalization keys off the bound function type,
        // so an int32-typed `(value)` callee is not over-accepted.
        const string Source = @"
package R
class N {
    func A(value int32) int32 { return (value)(1) }
}
";
        var diagnostics = GetDiagnostics(Source).ToList();
        Assert.Contains(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void NullForgivenCallee_ExecutesAndReturnsValue()
    {
        // `handler!!(value)` on a populated nullable field runs the delegate.
        const string Source = @"package Issue2185NullForgiven
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
";
        var output = CompileAndRun(Source, "Issue2185NullForgiven");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("42", lines[0]);
    }

    [Fact]
    public void ParenthesizedCallee_ExecutesAndReturnsValue()
    {
        // `(h)(value)` on a non-null function field runs the delegate.
        const string Source = @"package Issue2185Parenthesized
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
";
        var output = CompileAndRun(Source, "Issue2185Parenthesized");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("42", lines[0]);
    }

    [Fact]
    public void NarrowedNullableFieldCallee_ExecutesAndReturnsValue()
    {
        // `hn(value)` after an `== nil` guard invokes the smart-cast-narrowed
        // (now non-null) function field.
        const string Source = @"package Issue2185Narrowed
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
";
        var output = CompileAndRun(Source, "Issue2185Narrowed");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("42", lines[0]);
    }

    [Fact]
    public void CurriedCallAndParenthesizedLocal_ExecuteAndReturnValues()
    {
        // A curried `f()(x)` and a parenthesized-local `(f)(x)` are both indirect
        // invocations of the returned/parenthesized function value.
        const string Source = @"package Issue2185Curried
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
";
        var output = CompileAndRun(Source, "Issue2185Curried");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal("15", lines[0]);
        Assert.Equal("7", lines[1]);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
