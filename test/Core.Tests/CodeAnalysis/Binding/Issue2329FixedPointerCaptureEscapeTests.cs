// <copyright file="Issue2329FixedPointerCaptureEscapeTests.cs" company="GSharp">
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
/// Issue #2329 (deferred audit item) / ADR-0125: a <c>fixed</c> statement's
/// unmanaged <c>*T</c> pointer variable (<c>PointerTypeSymbol</c>, distinct
/// from the ordinary <c>*T</c>/<c>&amp;</c>/<c>ByRefTypeSymbol</c> "managed
/// pointer" already guarded by GS9004/GS9006 — see
/// <c>RefSafeEscapeTests</c>) was reachably captured by a nested closure with
/// no diagnostic at all: <c>LambdaBinder</c>'s capture-escape checks covered
/// by-ref-like (<c>ref struct</c>) and <c>ByRefTypeSymbol</c> locals, but not
/// <c>PointerTypeSymbol</c> locals. The capture then flowed unchecked into
/// <c>CaptureBoxingRewriter</c>, which has no allocation/seed path for a
/// <c>fixed</c> pointer variable (it, like a catch-clause variable, is
/// "declaration-less" — bound directly by <c>BoundFixedStatement</c>, not a
/// <c>BoundVariableDeclaration</c>) — crashing emit with
/// <c>GS9998: Variable has no local slot</c>.
/// <para>
/// Rather than implement an unsafe lowering that boxes a raw unmanaged
/// pointer past the lifetime of its pin (the pinned handle is released when
/// the enclosing <c>fixed</c> block exits, so any closure invoked after that
/// point — or, for a heap-escaping closure, at an arbitrary later time —
/// would dereference a pointer that is no longer guaranteed pinned/valid),
/// the fix rejects the escape during binding: <c>LambdaBinder</c> now
/// reports <c>GS9008</c> for any <c>PointerTypeSymbol</c> variable found in a
/// function-literal's captured-variable set, before lowering/emission ever
/// runs. This mirrors the existing GS9004 rejection for by-ref-like/managed
/// pointer captures, just for an additional variable kind.
/// </para>
/// These tests bind (but do not lower/emit) source directly via
/// <see cref="GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram"/>, the
/// same lightweight pattern <c>RefSafeEscapeTests</c> uses for GS9004/GS9006.
/// </summary>
public class Issue2329FixedPointerCaptureEscapeTests
{
    [Fact]
    public void FixedPointer_ReadCapturedInLambda_Reports_GS9008_NotGS9998()
    {
        // The reachable gap from the audit: a lambda declared inside a
        // `fixed` block reads the pinned pointer variable.
        var source = """
            package P
            unsafe func run() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                fixed pD *uint8 = buf {
                    var f = func() uint8 { return pD[0] }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9008");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void FixedPointer_WriteCapturedInLambda_Reports_GS9008()
    {
        // Issue #567/#618-style write-only capture: the LHS of an assignment
        // is a use that must also be checked (mirrors the existing GS9004
        // by-ref write-capture coverage).
        var source = """
            package P
            unsafe func run() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                fixed pD *uint8 = buf {
                    var f = func() { pD[0] = uint8(9) }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9008");
    }

    [Fact]
    public void FixedPointer_CapturedInLetBoundLambda_Reports_GS9008()
    {
        // The `let name = func() {...}` local-function-style spelling goes
        // through the same BindFunctionLiteral path as an anonymous lambda —
        // confirm it is covered too.
        var source = """
            package P
            unsafe func run() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                fixed pD *uint8 = buf {
                    let log = func() uint8 { return pD[0] }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9008");
    }

    [Fact]
    public void FixedPointer_NonCapturingUsage_IsLegal()
    {
        // The overwhelmingly common case — using the pointer only inside the
        // `fixed` block itself, never inside a nested closure — must remain
        // unaffected.
        var source = """
            package P
            unsafe func run() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                fixed pD *uint8 = buf {
                    pD[0] = uint8(9)
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9008");
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void FixedPointer_NestedInsideLambdaBody_NotCapturedOutward_IsLegal()
    {
        // The inverse (#1437-analogous) shape: the ENTIRE `fixed` statement —
        // pin, pointer variable, and all uses — is declared inside the lambda
        // body. The pointer variable is local to that body, not captured
        // from an enclosing scope, so no GS9008 applies.
        var source = """
            package P
            unsafe func run() {
                var f = func() uint8 {
                    var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                    fixed pD *uint8 = buf {
                        return pD[0]
                    }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9008");
    }

    [Fact]
    public void NonPointerLocal_CapturedInLambdaInsideFixedBlock_IsLegal()
    {
        // A lambda inside a `fixed` block that captures a different,
        // ordinary (non-pointer) outer local must still box normally — the
        // GS9008 rejection is specific to the pointer variable itself.
        var source = """
            package P
            unsafe func run() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                var total = 0
                fixed pD *uint8 = buf {
                    pD[0] = uint8(9)
                    var f = func() { total = total + 1 }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9008");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
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
