// <copyright file="Issue4265SpanByValueRefReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System.Collections.Immutable
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.Tests
import System.Collections.Generic

/// Issue #4265: a native ref-returning function that takes a by-value
/// byref-like (ref struct, e.g. `Span[T]`) parameter and returns a ref
/// THROUGH it (`return ref s[0]`) was always rejected with GS0254,
/// unlike C#. (cref:GSharp.Core.CodeAnalysis.Binding.RefCapabilities)'s
/// `SelectEscapeArguments` and `StatementBinder.HasFunctionLocalRefScope`'s
/// new `BoundClrIndexExpression` case (plus the new
/// `HasFunctionLocalReferentScope` helper it and the by-value-byref-like
/// argument list both use) recognize that such a value's ENCAPSULATED
/// REFERENT (e.g. `Span[T]`'s backing pointer, reached only through its
/// indexer/methods) is caller-supplied, distinct from its OWN storage (its
/// fields), which remains function-local exactly like any other by-value
/// struct's fields — a ref struct's OWN field is still rejected
/// ((cref:RefStructByValueParameter_RefReturnToOwnField_StillReportsGS0254)),
/// and so is an ordinary (non-byref-like) struct's field
/// ((cref:OrdinaryStruct_ByValueParameter_RefReturnToOwnField_StillReportsGS0254))
/// — that distinction is what makes the widening sound.
open class Issue4265SpanByValueRefReturnTests {
    @Fact
    func Span_ByValueParameter_RefReturn_Compiles_AndAliasesOriginalStorage() {
        let result = EmittedOracle.Evaluate(`import System

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
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.ReadGlobals()["answer"])
    }

    @Fact
    func Span_ByValueParameter_ForwardedThroughAnotherRefReturningCall_Compiles_AndAliasesOriginalStorage() {
        // DoD bullet 2 (positive half): a chain of ref-returning calls over a
        // by-value byref-like parameter must still be accepted when safe.
        let result = EmittedOracle.Evaluate(`import System

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
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(123, result.ReadGlobals()["answer"])
    }

    @Fact
    func ScopedSpanByValueParameter_ForwardedThroughAnotherRefReturningCall_ReportsGS0254() {
        // DoD bullet 2 (negative half): a `scoped` by-value byref-like
        // parameter forwarded into another ref-returning call must still be
        // rejected — the callee's `scoped` contract means the caller cannot
        // rely on it outliving the call.
        let result = EmittedOracle.Evaluate(`import System

func First(s Span[int32]) ref int32 {
    return ref s[0]
}
func BadForward(scoped s Span[int32]) ref int32 {
    return ref First(s)
}`)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func ReadOnlySpan_ByValueParameter_RefReadonlyReturn_Compiles() {
        let result = EmittedOracle.Evaluate(`import System

func First(s ReadOnlySpan[int32]) ref readonly int32 {
    return ref s[0]
}
func Run() int32 {
    var values = []int32{7, 8, 9}
    var span = ReadOnlySpan[int32](values)
    let ref readonly alias = First(span)
    return alias
}
var answer = Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.ReadGlobals()["answer"])
    }

    @Fact
    func ReadOnlySpan_ByValueParameter_PlainRefReturn_IsRejected() {
        // ReadOnlySpan[T]'s indexer only yields `ref readonly T` — a plain
        // (mutable) `ref` return from it is a read-only-storage violation,
        // not a scope violation, and must stay rejected (GS0253).
        let diagnostics = Bind(`import System

func Bad(s ReadOnlySpan[int32]) ref int32 {
    return ref s[0]
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0253")
    }

    @Fact
    func OrdinaryStruct_ByValueParameter_RefReturnToOwnField_StillReportsGS0254() {
        // The unsafe case this change must NOT relax: an ordinary (non-ref-
        // struct) by-value struct parameter is a function-local copy, so a
        // ref to one of its fields must dangle once the function returns.
        // `ref readonly` (rather than plain `ref`) isolates the scope check
        // from the unrelated "by-value parameters are read-only storage"
        // GS0253 check, which would otherwise also fire here for a
        // completely different reason and mask what this test targets.
        let diagnostics = Bind(`package P
struct Point {
    var X int32
}
func BadField(p Point) ref readonly int32 {
    return ref p.X
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func RefStructByValueParameter_RefReturnToOwnField_StillReportsGS0254() {
        // The unsafe case a naive "byref-like parameters get caller scope"
        // widening would wrongly relax, caught during review: a ref
        // struct's OWN field is still the struct's own (function-local)
        // storage, exactly like an ordinary struct's field — only a ref
        // struct's ENCAPSULATED referent (e.g. Span[T]'s backing pointer,
        // reached only through its indexer/methods) gets caller scope.
        let diagnostics = Bind(`package P
ref struct Acc {
    var Total int32
}
func BadField(a Acc) ref readonly int32 {
    return ref a.Total
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func RefStructFieldForwardedThroughRefParameter_StillReportsGS0254() {
        // Caught during review: a ref/in/out argument that happens to be
        // byref-like-typed must still be checked against its OWN storage
        // scope (HasFunctionLocalRefScope), never against the more
        // permissive referent-scope rule reserved for BY-VALUE byref-like
        // arguments — otherwise this exact chain would be wrongly accepted.
        let diagnostics = Bind(`package P
ref struct Acc {
    var Total int32
}
func Fwd(ref a Acc) ref int32 {
    return ref a.Total
}
func Bad(a Acc) ref int32 {
    return ref Fwd(ref a)
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
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
    @Theory
    @InlineData("UnscopedRefIndexerFixture")
    @InlineData("UnscopedRefIndexerPropertyLevelFixture")
    func UnscopedRefClrIndexer_ByValueParameter_RefReturn_StillReportsGS0254(typeName string) {
        let diagnostics = BindWithFixtures((`package P
import GSharp.Core.Tests.Fixtures

func M(buf ` + "$typeName" + `) ref int32 {
    return ref buf[0]
}`))
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    /// The premise of the two tests above: both fixtures really do carry
    /// `[UnscopedRef]` in the metadata gsc reads, one on the `get`
    /// accessor and one on the property. Without this, a silently dropped
    /// attribute would turn them into ordinary byref-like indexers and the
    /// GS0254 assertions would still pass for the WRONG reason.
    @Theory
    @InlineData("UnscopedRefIndexerFixture")
    @InlineData("UnscopedRefIndexerPropertyLevelFixture")
    func UnscopedRefFixture_CarriesTheAttribute(typeName string) {
        let type = NativeMetadataFixtures.GetType("GSharp.Core.Tests.Fixtures." + typeName)
        Assert.NotNull(type)
        let indexer PropertyInfo? = type.GetProperty("Item")
        Assert.NotNull(indexer)
        let getter MethodInfo? = indexer!!.GetGetMethod(nonPublic: true)
        Assert.NotNull(getter)
        Assert.True(
            CarriesUnscopedRef(indexer!!.GetCustomAttributesData()) ||
                CarriesUnscopedRef(getter!!.GetCustomAttributesData())
        )
    }

    @Fact
    func UnscopedRefClrIndexer_RefParameter_RefReturn_Compiles() {
        // Positive counterpart proving the guard above is the STRICT scope
        // check, not a blanket rejection of the type: forwarding through a
        // genuine `ref` parameter is safe (the referent IS the caller's own
        // storage in that case) and real C# accepts the analogous code
        // (confirmed against csc directly) — only the BY-VALUE forwarding
        // case is unsound and must be rejected.
        let diagnostics = BindWithFixtures(`package P
import GSharp.Core.Tests.Fixtures

func M(ref buf UnscopedRefIndexerFixture) ref int32 {
    return ref buf[0]
}`)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    shared {
        private func CarriesUnscopedRef(attributes IList[CustomAttributeData]) bool -> attributes.Any(
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute"
        )

        private func BindWithFixtures(source string) ImmutableArray[Diagnostic] {
            using let fixture = NativeMetadataFixtures.Compile()
            using let resolver = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver)
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }
    }
}
