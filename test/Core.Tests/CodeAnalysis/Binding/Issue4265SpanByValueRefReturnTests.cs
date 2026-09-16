// <copyright file="Issue4265SpanByValueRefReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4265: a native ref-returning function that takes a by-value
/// byref-like (ref struct, e.g. <c>Span[T]</c>) parameter and returns a ref
/// THROUGH it (<c>return ref s[0]</c>) was always rejected with GS0254,
/// unlike C#. <see cref="GSharp.Core.CodeAnalysis.Binding.RefCapabilities"/>'s
/// <c>SelectEscapeArguments</c> and <c>StatementBinder.HasFunctionLocalRefScope</c>'s
/// new <c>BoundClrIndexExpression</c> case (plus the new
/// <c>HasFunctionLocalReferentScope</c> helper it and the by-value-byref-like
/// argument list both use) recognize that such a value's ENCAPSULATED
/// REFERENT (e.g. <c>Span[T]</c>'s backing pointer, reached only through its
/// indexer/methods) is caller-supplied, distinct from its OWN storage (its
/// fields), which remains function-local exactly like any other by-value
/// struct's fields — a ref struct's OWN field is still rejected
/// (<see cref="RefStructByValueParameter_RefReturnToOwnField_StillReportsGS0254"/>),
/// and so is an ordinary (non-byref-like) struct's field
/// (<see cref="OrdinaryStruct_ByValueParameter_RefReturnToOwnField_StillReportsGS0254"/>)
/// — that distinction is what makes the widening sound.
/// </summary>
public class Issue4265SpanByValueRefReturnTests
{
    [Fact]
    public void Span_ByValueParameter_RefReturn_Compiles_AndAliasesOriginalStorage()
    {
        var result = EmittedOracle.Evaluate("""
            import System

            func First(s Span[int32]) ref int32 {
                return ref s[0]
            }
            func Run() int32 {
                var values = []int32{10, 20, 30}
                var span = Span[int32](values)
                var ref alias = First(span)
                alias = 42
                return values[0]
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void Span_ByValueParameter_ForwardedThroughAnotherRefReturningCall_Compiles_AndAliasesOriginalStorage()
    {
        // DoD bullet 2 (positive half): a chain of ref-returning calls over a
        // by-value byref-like parameter must still be accepted when safe.
        var result = EmittedOracle.Evaluate("""
            import System

            func First(s Span[int32]) ref int32 {
                return ref s[0]
            }
            func Forward(s Span[int32]) ref int32 {
                return ref First(s)
            }
            func Run() int32 {
                var values = []int32{5}
                var span = Span[int32](values)
                var ref alias = Forward(span)
                alias = 123
                return values[0]
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(123, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ScopedSpanByValueParameter_ForwardedThroughAnotherRefReturningCall_ReportsGS0254()
    {
        // DoD bullet 2 (negative half): a `scoped` by-value byref-like
        // parameter forwarded into another ref-returning call must still be
        // rejected — the callee's `scoped` contract means the caller cannot
        // rely on it outliving the call.
        var result = EmittedOracle.Evaluate("""
            import System

            func First(s Span[int32]) ref int32 {
                return ref s[0]
            }
            func BadForward(scoped s Span[int32]) ref int32 {
                return ref First(s)
            }
            """);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void ReadOnlySpan_ByValueParameter_RefReadonlyReturn_Compiles()
    {
        var result = EmittedOracle.Evaluate("""
            import System

            func First(s ReadOnlySpan[int32]) ref readonly int32 {
                return ref s[0]
            }
            func Run() int32 {
                var values = []int32{7, 8, 9}
                var span = ReadOnlySpan[int32](values)
                let ref readonly alias = First(span)
                return alias
            }
            var answer = Run()
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.ReadGlobals()["answer"]);
    }

    [Fact]
    public void ReadOnlySpan_ByValueParameter_PlainRefReturn_IsRejected()
    {
        // ReadOnlySpan[T]'s indexer only yields `ref readonly T` — a plain
        // (mutable) `ref` return from it is a read-only-storage violation,
        // not a scope violation, and must stay rejected (GS0253).
        var diagnostics = Bind("""
            import System

            func Bad(s ReadOnlySpan[int32]) ref int32 {
                return ref s[0]
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0253");
    }

    [Fact]
    public void OrdinaryStruct_ByValueParameter_RefReturnToOwnField_StillReportsGS0254()
    {
        // The unsafe case this change must NOT relax: an ordinary (non-ref-
        // struct) by-value struct parameter is a function-local copy, so a
        // ref to one of its fields must dangle once the function returns.
        // `ref readonly` (rather than plain `ref`) isolates the scope check
        // from the unrelated "by-value parameters are read-only storage"
        // GS0253 check, which would otherwise also fire here for a
        // completely different reason and mask what this test targets.
        var diagnostics = Bind("""
            package P
            struct Point {
                var X int32
            }
            func BadField(p Point) ref readonly int32 {
                return ref p.X
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void RefStructByValueParameter_RefReturnToOwnField_StillReportsGS0254()
    {
        // The unsafe case a naive "byref-like parameters get caller scope"
        // widening would wrongly relax, caught during review: a ref
        // struct's OWN field is still the struct's own (function-local)
        // storage, exactly like an ordinary struct's field — only a ref
        // struct's ENCAPSULATED referent (e.g. Span[T]'s backing pointer,
        // reached only through its indexer/methods) gets caller scope.
        var diagnostics = Bind("""
            package P
            ref struct Acc {
                var Total int32
            }
            func BadField(a Acc) ref readonly int32 {
                return ref a.Total
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void RefStructFieldForwardedThroughRefParameter_StillReportsGS0254()
    {
        // Caught during review: a ref/in/out argument that happens to be
        // byref-like-typed must still be checked against its OWN storage
        // scope (HasFunctionLocalRefScope), never against the more
        // permissive referent-scope rule reserved for BY-VALUE byref-like
        // arguments — otherwise this exact chain would be wrongly accepted.
        var diagnostics = Bind("""
            package P
            ref struct Acc {
                var Total int32
            }
            func Fwd(ref a Acc) ref int32 {
                return ref a.Total
            }
            func Bad(a Acc) ref int32 {
                return ref Fwd(ref a)
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    // Soundness guard found reviewing this PR before merge: a byref-like
    // CLR (externally-compiled) type can legally declare its indexer ref
    // return [UnscopedRef] (System.Diagnostics.CodeAnalysis) — a legitimate
    // C# 11+ pattern (no unsafe, no IL authoring) that returns a ref into
    // the RECEIVER'S OWN storage, not an encapsulated referent the receiver
    // merely wraps (unlike Span[T]/ReadOnlySpan[T]'s indexers, which never
    // do this). C# accepts [UnscopedRef] on either the `get` accessor or
    // the property itself (an expression-bodied indexer emits it on the
    // property) — both fixtures below cover one placement each. Real C#
    // rejects forwarding such a member through a by-value parameter
    // (CS8166); RefCapabilities.IsUnscopedRefIndexerGetter makes gsc match
    // that by falling back to the strict HasFunctionLocalRefScope check
    // whenever the resolved indexer (or its getter) carries [UnscopedRef],
    // instead of unconditionally trusting any byref-like CLR indexer target
    // as safe-to-forward. Without the guard this compiled clean and
    // returned a dangling reference into the callee's own dead stack frame
    // (confirmed reproducible outside this test: an intervening call's
    // locals silently corrupted the "aliased" value on read-back).
    [Theory]
    [InlineData("UnscopedRefIndexerFixture")]
    [InlineData("UnscopedRefIndexerPropertyLevelFixture")]
    public void UnscopedRefClrIndexer_ByValueParameter_RefReturn_StillReportsGS0254(string typeName)
    {
        var diagnostics = BindWithFixtures($$"""
            package P
            import GSharp.Core.Tests.Fixtures

            func M(buf {{typeName}}) ref int32 {
                return ref buf[0]
            }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void UnscopedRefClrIndexer_RefParameter_RefReturn_Compiles()
    {
        // Positive counterpart proving the guard above is the STRICT scope
        // check, not a blanket rejection of the type: forwarding through a
        // genuine `ref` parameter is safe (the referent IS the caller's own
        // storage in that case) and real C# accepts the analogous code
        // (confirmed against csc directly) — only the BY-VALUE forwarding
        // case is unsound and must be rejected.
        var diagnostics = BindWithFixtures("""
            package P
            import GSharp.Core.Tests.Fixtures

            func M(ref buf UnscopedRefIndexerFixture) ref int32 {
                return ref buf[0]
            }
            """);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0254");
    }

    private static ImmutableArray<Diagnostic> BindWithFixtures(string source)
    {
        var fixturePath = typeof(GSharp.Core.Tests.Fixtures.UnscopedRefIndexerFixture).Assembly.Location;
        var resolver = ReferenceResolver.WithReferences(new[] { fixturePath });
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            System.Collections.Immutable.ImmutableArray.Create(tree),
            resolver);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
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
