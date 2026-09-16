// <copyright file="Issue4259RefParameterCaptureEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4259: a closure (lambda or non-generic local function) that
/// captures a <c>ref</c>/<c>out</c>/<c>in</c> PARAMETER of its enclosing
/// function compiled successfully and silently lost the mutation instead of
/// being rejected — the capture would hoist a value snapshot of the
/// parameter into the closure's display class/struct, not a live reference
/// to the caller's argument, and the CLR has no mechanism to keep a managed
/// pointer alive past the enclosing call's return anyway. <c>LambdaBinder</c>
/// already rejected a <c>ref struct</c> capture (GS0219), a managed-pointer
/// capture (GS9004) and a <c>fixed</c>-pointer capture (GS9008); it now
/// rejects a by-ref PARAMETER capture the same way, with the new GS9010.
/// <para>
/// This is distinct from capturing a <c>ref</c>/<c>var ref</c> LOCAL alias
/// (<see cref="RefLocalAliasingTests"/>, <see cref="Issue4222RefAliasSuspensionLivenessTests"/>):
/// a local alias is a plain <c>LocalVariableSymbol</c>, not a
/// <c>ParameterSymbol</c>, so it is unaffected by this check — the GS9010
/// branch matches only <c>ParameterSymbol</c> instances with
/// <c>RefKind.Ref</c>/<c>Out</c>/<c>In</c>.
/// </para>
/// These tests bind (but do not lower/emit) source directly via
/// <see cref="GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram"/>, mirroring
/// <c>Issue2329FixedPointerCaptureEscapeTests</c>.
/// </summary>
public class Issue4259RefParameterCaptureEscapeTests
{
    [Fact]
    public void RefParameter_MutatedInLetBoundLocalFunction_Reports_GS9010()
    {
        // The issue's own repro, verbatim.
        var source = """
            package P
            func Foo(ref x int32) {
                let Bad = func(a int32) int32 {
                    x = x + 1
                    return a
                }
                Bad(1)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void RefParameter_ReadOnlyCapturedInAnonymousLambda_Reports_GS9010()
    {
        // A read-only reference (no assignment through the capture) is
        // rejected too: even a stale read is unsound once the closure
        // outlives the caller's argument.
        var source = """
            package P
            func Foo(ref x int32) {
                var f = func() int32 { return x }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void OutParameter_CapturedInClosure_Reports_GS9010()
    {
        var source = """
            package P
            func Foo(out x int32) {
                x = 0
                let Bad = func(a int32) int32 {
                    x = x + 1
                    return a
                }
                Bad(1)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void InParameter_CapturedInClosure_Reports_GS9010()
    {
        var source = """
            package P
            func Foo(in x int32) {
                let Bad = func(a int32) int32 { return x + a }
                Bad(1)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void RefParameter_CapturedInArrowLambda_Reports_GS9010()
    {
        // The `(p) -> { ... }` arrow spelling binds through
        // BindLambdaExpression, a different call site than the `let name =
        // func ... {...}` local-function spelling — confirm it is covered.
        var source = """
            package P
            func Foo(ref x int32) {
                var f = (a int32) -> { x = x + 1
                    return a }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void RefParameter_CapturedInGenericLocalFunction_Reports_GS9010()
    {
        // Issue #4259's own note: the same gap reproduces identically for a
        // generic local function (`let Name[T] = func ...`), not just an
        // ordinary closure.
        var source = """
            package P
            func Foo[T](ref x int32, seed T) T {
                let Bad[U] = func(a U) U {
                    x = x + 1
                    return a
                }
                return Bad(seed)
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9010");
    }

    [Fact]
    public void OrdinaryByValueParameter_CapturedInClosure_IsLegal()
    {
        // No over-rejection: an ordinary (by-value) parameter capture must
        // remain unaffected.
        var source = """
            package P
            func Foo(x int32) {
                var f = func() int32 { return x }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void OrdinaryLocal_CapturedInClosure_IsLegal()
    {
        var source = """
            package P
            func Foo() {
                var total = 0
                var f = func() { total = total + 1 }
                f()
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefParameter_NotCapturedOnlyUsedLocally_IsLegal()
    {
        // Using a ref parameter directly in the enclosing function body
        // (never referenced by a nested closure) must remain unaffected.
        var source = """
            package P
            func Foo(ref x int32) {
                x = x + 1
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void RefLocalAlias_CapturedInClosure_DoesNotReport_GS9010()
    {
        // A `var ref` LOCAL alias is a distinct capture kind from a
        // ref/out/in PARAMETER (it is a plain LocalVariableSymbol, not a
        // ParameterSymbol) and must not trip the new GS9010 check, whatever
        // its own (separately handled) legality outcome is.
        var source = """
            package P
            func Foo() {
                var arr = []int32{1}
                var ref alias = arr[0]
                var f = func() { alias = alias + 1 }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9010");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
