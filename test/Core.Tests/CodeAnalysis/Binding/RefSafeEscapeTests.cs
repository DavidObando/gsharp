// <copyright file="RefSafeEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0058 / issue #376: ref-safe-to-escape analysis tests.
/// Covers GS9004 (ByRef escape), GS9006 (ByRef field type), and the
/// <c>scoped</c> parameter modifier with GS0219 ref-struct return escape.
/// </summary>
public class RefSafeEscapeTests
{
    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be returned from a function
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_Return_FromFunction_Reports_GS9004()
    {
        // A function whose return type is *int32 cannot be declared or used —
        // returning a managed pointer would expose a dangling reference to a
        // callee stack frame.
        var source = @"
func getRef() *int32 {
    var x = 42
    return &x
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void ByRef_Return_InLambda_Reports_GS9004()
    {
        // A lambda that returns *T is also rejected — a lambda captured by a
        // closure can outlive the pointed-to variable.
        var source = @"
var x = 1
var f = func() *int32 { return &x }
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void ByRef_ReturnVoid_IsLegal()
    {
        // Using &x to call a ref/out API is fine; the pointer does not escape.
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""99"", &result)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9004");
    }

    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be captured in a closure
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_CapturedInClosure_Reports_GS9004()
    {
        // Closing over a *T local is rejected — the closure can outlive the
        // stack frame that owns the pointed-to variable.
        var source = @"
package P
func test() {
    var x = 10
    var p = &x
    var f = func() { var y = *p }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void NonPointer_CapturedInClosure_IsLegal()
    {
        var source = @"
package P
func test() {
    var x = 10
    var f = func() { var y = x }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9004");
    }

    // -----------------------------------------------------------------------
    // GS9006: managed pointer (*T) cannot be a field type
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_AsStructField_Reports_GS9006()
    {
        var source = @"
package P
struct S {
    var Ptr *int32
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void ByRef_AsClassField_Reports_GS9006()
    {
        var source = @"
package P
class C {
    var Ptr *int32
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void PlainIntField_InStruct_IsLegal()
    {
        var source = @"
package P
struct S {
    var Value int32
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9006");
    }

    // -----------------------------------------------------------------------
    // scoped modifier: parsing and ParameterSymbol.IsScoped
    // -----------------------------------------------------------------------

    [Fact]
    public void Scoped_Parameter_ParsesWithoutError()
    {
        var source = @"
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError && d.Id != "GS9004" && d.Id != "GS9006");
    }

    [Fact]
    public void Scoped_Parameter_IsScoped_True()
    {
        var source = @"
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);

        var func = program.Functions.Keys.FirstOrDefault(f => f.Name == "f");
        Assert.NotNull(func);
        var param = func.Parameters.FirstOrDefault(p => p.Name == "s");
        Assert.NotNull(param);
        Assert.True(param.IsScoped);
    }

    [Fact]
    public void NonScoped_Parameter_IsScoped_False()
    {
        var source = @"
import System
func f(s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);

        var func = program.Functions.Keys.FirstOrDefault(f => f.Name == "f");
        Assert.NotNull(func);
        var param = func.Parameters.FirstOrDefault(p => p.Name == "s");
        Assert.NotNull(param);
        Assert.False(param.IsScoped);
    }

    [Fact]
    public void Scoped_UsableAsIdentifier_WhenNotFollowedByIdentifier()
    {
        // `scoped` used as a plain variable name (not followed by another
        // identifier) must remain a valid identifier, not be consumed as a
        // modifier.
        var source = @"
var scoped = 42
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.DoesNotContain(tree.Diagnostics, d => d.IsError);
    }

    // -----------------------------------------------------------------------
    // scoped + ref struct: returning a scoped ref struct parameter (GS0219)
    // -----------------------------------------------------------------------

    [Fact]
    public void ScopedRefStructParam_Returned_Reports_GS0219()
    {
        // A `scoped` ref struct parameter has safe-to-escape = function-local;
        // it must not be returned.
        var source = @"
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void NonScopedRefStructParam_Returned_IsLegal()
    {
        // Without `scoped`, the parameter's STE is caller scope — returning is
        // legal (same as C#'s default for ref struct parameters).
        var source = @"
import System
func passThrough(s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedRefStructParam_MemberAccess_IsLegal()
    {
        // Using a member of a `scoped` ref struct parameter (not returning
        // the ref struct itself) is fine.
        var source = @"
import System
func length(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedPlainParam_NotRefStruct_NoGS0219()
    {
        // `scoped` on a non-ref-struct parameter does not produce GS0219
        // (the restriction only applies when returning a ref struct value).
        var source = @"
package P
func f(scoped x int32) int32 {
    return x
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_ScopedRefStruct_Returned_Reports_GS0219()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
func bad(scoped a Acc) Acc {
    return a
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_NonScopedRefStruct_Returned_IsLegal()
    {
        var source = @"
package P
ref struct Acc {
    var Total int32
}
func passThrough(a Acc) Acc {
    return a
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    // -----------------------------------------------------------------------
    // scoped on local variable declarations (Phase 1)
    // -----------------------------------------------------------------------

    [Fact]
    public void ScopedLocal_RefStruct_Returned_Reports_GS0219()
    {
        var source = @"
import System
func bad() ReadOnlySpan[int32] {
    var scoped s ReadOnlySpan[int32]
    return s
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedLocal_RefStruct_NotReturned_IsLegal()
    {
        var source = @"
import System
func ok() int32 {
    var scoped s ReadOnlySpan[int32]
    return s.Length
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedLocal_Let_RefStruct_Returned_Reports_GS0219()
    {
        var source = @"
import System
func bad(data ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let scoped local = data
    return local
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void Scoped_UsableAsLocalIdentifier()
    {
        // `scoped` used as a variable name (let scoped = 42) should still work
        // when not followed by another identifier that forms a name.
        var source = @"
let scoped = 42
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.DoesNotContain(tree.Diagnostics, d => d.IsError);
    }

    // -----------------------------------------------------------------------
    // STE propagation through initializers (Phase 2)
    // -----------------------------------------------------------------------

    [Fact]
    public void STE_Propagation_LocalInitFromScopedParam_Reports_GS0219()
    {
        // `let x = scopedParam` → x inherits function-local STE → cannot return x
        var source = @"
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let x = s
    return x
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void STE_Propagation_LocalInitFromNonScopedParam_IsLegal()
    {
        var source = @"
import System
func ok(s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let x = s
    return x
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void STE_Propagation_ThroughConversion_Reports_GS0219()
    {
        // Implicit conversion preserves STE.
        var source = @"
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    var x ReadOnlySpan[int32] = s
    return x
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    // -----------------------------------------------------------------------
    // [UnscopedRef] and ref struct methods (Phase 3; revised by ADR-0184)
    // -----------------------------------------------------------------------

    /// <summary>
    /// ADR-0184 D1 (conformance fix). This used to assert the opposite — that
    /// <c>return this</c> BY VALUE out of a <c>ref struct</c> member reports
    /// GS0219 — which conflated the receiver's two escape scopes. Only the
    /// REF-safe-context of <c>this</c> is function-local by default; its
    /// safe-to-escape (value) scope is the caller's, because the value the
    /// receiver holds was produced by, and outlives, the call. Real C# accepts
    /// exactly this shape with no annotation, and no annotation makes it
    /// illegal either — <c>@UnscopedRef</c> is not what governs it.
    /// </summary>
    [Fact]
    public void RefStructMethod_ReturnsThis_ByValue_IsLegal()
    {
        var source = @"
package P
ref struct MySpan {
    var Value int32

    func getSelf() MySpan {
        return this
    }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// ADR-0184 D1's other half: the value-scope relaxation above must not
    /// leak into a genuinely scoped SOURCE. A <c>scoped</c> parameter's value
    /// is still function-local, so returning it — or a local seeded from it —
    /// is still GS0219, inside a struct member exactly as at top level.
    /// </summary>
    [Fact]
    public void RefStructMethod_ReturnsScopedParameter_StillReports_GS0219()
    {
        var source = @"
package P
import System
ref struct MySpan {
    var Value int32

    func pick(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
        return s
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void RefStructMethod_ReturnsNonRefStructField_IsLegal()
    {
        // Returning a non-ref-struct field from a ref struct method is fine.
        var source = @"
package P
ref struct MySpan {
    var Value int32
}
func (s MySpan) getValue() int32 {
    return Value
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    /// <summary>
    /// ADR-0184. The pre-ADR-0184 version of this test wrote <c>@UnscopedRef</c>
    /// on a RECEIVER-CLAUSE func and with no <c>import</c>, so it proved neither
    /// thing it claimed: the annotation could not resolve (GS0198, which the
    /// single <c>DoesNotContain(GS0219)</c> assertion never noticed), and GS0219
    /// is not what <c>@UnscopedRef</c> governs in the first place. The in-struct
    /// spelling below is the shape the annotation actually applies to; the
    /// receiver-clause spelling is now a placement error in its own test.
    /// </summary>
    [Fact]
    public void RefStructMethod_WithUnscopedRef_ReturnsRefToOwnState_IsLegal()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
ref struct MySpan {
    var Value int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Value
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    /// <summary>ADR-0184: the same shape on an ordinary (non-<c>ref</c>) struct.</summary>
    [Fact]
    public void StructMethod_WithUnscopedRef_ReturnsRefToOwnState_IsLegal()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// ADR-0184: without the annotation the same member is rejected — with the
    /// dedicated GS0589, not the generic GS0254 ("function-local storage",
    /// which is wrong here: the storage is the CALLER's) and not GS0253
    /// ("must be an lvalue", which is what the pre-ADR-0184 compiler reported
    /// because it classified every <c>this</c> as read-only storage).
    /// </summary>
    [Fact]
    public void StructMethod_WithoutUnscopedRef_ReturnsRefToOwnState_Reports_GS0589()
    {
        var source = @"
package P
struct Acc {
    var Total int32

    func slot() ref int32 {
        return ref this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0589");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0253");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0254");
    }

    /// <summary>
    /// ADR-0184: the bare-name spelling lowers to a <c>this</c> access, so it
    /// reaches the same diagnostic, and a nested <c>this.a.b</c> chain does too.
    /// </summary>
    [Theory]
    [InlineData("return ref Total")]
    [InlineData("return ref this.Total")]
    public void StructMethod_ReturnsRefToOwnState_BothSpellings_Report_GS0589(string returnStatement)
    {
        var source = @"
package P
struct Acc {
    var Total int32

    func slot() ref int32 {
        " + returnStatement + @"
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0589");
    }

    /// <summary>ADR-0184: a reference rooted at a LOCAL still gets the generic GS0254.</summary>
    [Fact]
    public void RefReturn_RootedAtLocal_StillReports_GS0254_NotGS0589()
    {
        var source = @"
package P
struct Acc {
    var Total int32
}
func f() ref int32 {
    var a Acc = default(Acc)
    return ref a.Total
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0254");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0589");
    }

    /// <summary>
    /// ADR-0184: <c>@UnscopedRef</c> lifts the ESCAPE-scope restriction only.
    /// A genuinely read-only field (<c>let</c>) is still not writable storage,
    /// so it still fails the lvalue/readonly gate with GS0253.
    /// </summary>
    [Fact]
    public void StructMethod_WithUnscopedRef_ReturnsRefToLetField_StillReports_GS0253()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    let Total int32 = 0

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0253");
    }

    /// <summary>
    /// ADR-0184 §8: the property/indexer spelling. The annotation is written
    /// once on the member and pushed down onto the accessors, which have no
    /// attribute list of their own.
    /// </summary>
    [Theory]
    [InlineData("prop Slot ref int32")]
    [InlineData("prop this[i int32] ref int32")]
    public void StructProperty_WithUnscopedRef_ReturnsRefToOwnState_IsLegal(string header)
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
ref struct Ring {
    var Value int32

    @UnscopedRef
    " + header + @" {
        get { return ref this.Value }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    /// <summary>ADR-0184: the same accessor without the annotation is GS0589.</summary>
    [Fact]
    public void StructIndexer_WithoutUnscopedRef_ReturnsRefToOwnState_Reports_GS0589()
    {
        var source = @"
package P
ref struct Ring {
    var Value int32

    prop this[i int32] ref int32 {
        get { return ref this.Value }
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0589");
    }

    /// <summary>
    /// ADR-0184: <c>return ref this</c> — a reference to the whole receiver —
    /// is the widest form the annotation permits, and is legal in C# too.
    /// </summary>
    [Fact]
    public void StructMethod_WithUnscopedRef_ReturnsRefToThis_IsLegal()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func self() ref Acc {
        return ref this
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    /// <summary>
    /// ADR-0184: type-identity recognition (ADR-0084 §L5). The annotation is a
    /// real CLR attribute now, not a name match, so the <c>import</c> is load
    /// bearing — without it the attribute does not resolve (GS0198) and the
    /// member is not un-scoped.
    /// </summary>
    [Fact]
    public void UnscopedRef_WithoutImport_Reports_GS0198_AndIsNotHonoured()
    {
        var source = @"
package P
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0198");
        Assert.Contains(diagnostics, d => d.Id == "GS0589");
    }

    // -----------------------------------------------------------------------
    // ADR-0184: @UnscopedRef placement validation (GS0590)
    // -----------------------------------------------------------------------

    [Theory]

    // A receiver clause is always an extension (ADR-0182), whose receiver is an
    // ordinary by-value parameter — the exact shape the old test used.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
ref struct MySpan {
    var Value int32
}
@UnscopedRef
func (s MySpan) getSelf() MySpan {
    return s
}
")]

    // A free function has no receiver at all.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
@UnscopedRef
func free() int32 {
    return 1
}
")]

    // A class receiver is a reference that already outlives the call.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
class Box {
    var Total int32

    @UnscopedRef
    func total() ref int32 {
        return ref this.Total
    }
}
")]

    // A `shared` (static) member has no receiver to un-scope.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    shared {
        @UnscopedRef
        func make() int32 {
            return 1
        }
    }
}
")]

    // ADR-0184 D4: an override is deferred.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
open class Base {
    open func total() int32 {
        return 0
    }
}
class Derived : Base {
    @UnscopedRef
    override func total() int32 {
        return 1
    }
}
")]

    // ADR-0184 D4: an interface member is deferred.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
interface IThing {
    @UnscopedRef
    func total() int32;
}
")]

    // The property spellings of the static and class rejections.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    shared {
        @UnscopedRef
        prop Total int32 {
            get { return 1 }
        }
    }
}
")]
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
class Box {
    var Backing int32

    @UnscopedRef
    prop Total ref int32 {
        get { return ref this.Backing }
    }
}
")]

    // ADR-0184 D4: the PROPERTY spelling of an explicit interface
    // implementation (ADR-0149's `prop (IFoo) P T` clause). Found in
    // adversarial review of PR #4291: `PropertySymbol.IsOverride` is false for
    // this shape, so it escaped GS0590 entirely, while the `func (IFoo) M()`
    // spelling — which DescribeUnscopedRefRejection checks through
    // HasExplicitInterfaceClause — was rejected. Both are deferred alike.
    [InlineData(@"
package P
import System.Diagnostics.CodeAnalysis
interface IThing {
    prop Total int32 { get; }
}
struct Acc : IThing {
    var Backing int32

    @UnscopedRef
    private prop (IThing) Total int32 -> this.Backing
}
")]
    public void UnscopedRef_OnUnsupportedTarget_Reports_GS0590(string source)
    {
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0590");
    }

    /// <summary>
    /// ADR-0184: GREEN counterpart to the GS0590 theory — the one supported
    /// shape must not trip the placement check.
    /// </summary>
    [Fact]
    public void UnscopedRef_OnStructInstanceMember_DoesNotReport_GS0590()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0590");
    }

    /// <summary>
    /// ADR-0184 D2: a struct member's <c>this</c> is writable storage in EVERY
    /// instance member, annotated or not — the CLR passes it as <c>ref S</c>.
    /// Taking its address, writing through it, and passing it to a writable
    /// <c>ref</c> parameter must all stay legal without <c>@UnscopedRef</c>.
    /// </summary>
    [Fact]
    public void StructMember_ThisIsWritableStorage_WithoutUnscopedRef()
    {
        var source = @"
package P
func take(ref x int32) { }
struct Acc {
    var Total int32

    func bump() {
        this.Total = this.Total + 1
        this.Total++
        take(ref this.Total)
        var p *int32 = &this.Total
    }
}
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void NonRefStructMethod_ReturnsThis_IsLegal()
    {
        // Non-ref-struct methods don't have implicit scoped on `this`.
        var source = @"
package P
struct Builder {
    var Count int32
}
func (b Builder) copy() Builder {
    return b
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    // -----------------------------------------------------------------------
    // scoped ref (*T) parameter (Phase 4)
    // -----------------------------------------------------------------------

    [Fact]
    public void ScopedByRefParam_CannotBeReturned_GS9004()
    {
        // A scoped *T parameter still triggers GS9004 on return (the scoped
        // adds RSTE restriction, but GS9004 already prevents all *T returns).
        var source = @"
package P
func bad(scoped p *int32) *int32 {
    return p
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void ScopedByRefParam_UsedLocally_IsLegal()
    {
        // Using a scoped *T parameter locally (dereferencing) is fine.
        var source = @"
package P
func read(scoped p *int32) int32 {
    return *p
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9004");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

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
