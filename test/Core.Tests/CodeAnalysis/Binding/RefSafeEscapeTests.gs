// <copyright file="RefSafeEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// ADR-0058 / issue #376: ref-safe-to-escape analysis tests.
/// Covers GS9004 (ByRef escape), GS9006 (ByRef field type), and the
/// `scoped` parameter modifier with GS0219 ref-struct return escape.
open class RefSafeEscapeTests {
    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be returned from a function
    // -----------------------------------------------------------------------
    @Fact
    func ByRef_Return_FromFunction_Reports_GS9004() {
        // A function whose return type is *int32 cannot be declared or used —
        // returning a managed pointer would expose a dangling reference to a
        // callee stack frame.
        let source = `
func getRef() *int32 {
    var x = 42
    return &x
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    @Fact
    func ByRef_Return_InLambda_Reports_GS9004() {
        // A lambda that returns *T is also rejected — a lambda captured by a
        // closure can outlive the pointed-to variable.
        let source = `
var x = 1
var f = func() *int32 { return &x }
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    @Fact
    func ByRef_ReturnVoid_IsLegal() {
        // Using &x to call a ref/out API is fine; the pointer does not escape.
        let source = `
import System
var result = 0
var ok = Int32.TryParse("99", &result)
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be captured in a closure
    // -----------------------------------------------------------------------
    @Fact
    func ByRef_CapturedInClosure_Reports_GS9004() {
        // Closing over a *T local is rejected — the closure can outlive the
        // stack frame that owns the pointed-to variable.
        let source = `
package P
func test() {
    var x = 10
    var p = &x
    var f = func() { var y = *p }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    @Fact
    func NonPointer_CapturedInClosure_IsLegal() {
        let source = `
package P
func test() {
    var x = 10
    var f = func() { var y = x }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    // -----------------------------------------------------------------------
    // GS9006: managed pointer (*T) cannot be a field type
    // -----------------------------------------------------------------------
    @Fact
    func ByRef_AsStructField_Reports_GS9006() {
        let source = `
package P
struct S {
    var Ptr *int32
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9006")
    }

    @Fact
    func ByRef_AsClassField_Reports_GS9006() {
        let source = `
package P
class C {
    var Ptr *int32
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9006")
    }

    @Fact
    func PlainIntField_InStruct_IsLegal() {
        let source = `
package P
struct S {
    var Value int32
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9006")
    }

    // -----------------------------------------------------------------------
    // scoped modifier: parsing and ParameterSymbol.IsScoped
    // -----------------------------------------------------------------------
    @Fact
    func Scoped_Parameter_ParsesWithoutError() {
        let source = `
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError && d.Id != "GS9004" && d.Id != "GS9006")
    }

    @Fact
    func Scoped_Parameter_IsScoped_True() {
        let source = `
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
        let func_ FunctionSymbol? = program.Functions.Keys.FirstOrDefault((f FunctionSymbol) -> f.Name == "f")
        Assert.NotNull(func_)
        let param ParameterSymbol? = func_!!.Parameters.FirstOrDefault((p ParameterSymbol) -> p.Name == "s")
        Assert.NotNull(param)
        Assert.True(param!!.IsScoped)
    }

    @Fact
    func NonScoped_Parameter_IsScoped_False() {
        let source = `
import System
func f(s ReadOnlySpan[int32]) int32 {
    return s.Length
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
        let func_ FunctionSymbol? = program.Functions.Keys.FirstOrDefault((f FunctionSymbol) -> f.Name == "f")
        Assert.NotNull(func_)
        let param ParameterSymbol? = func_!!.Parameters.FirstOrDefault((p ParameterSymbol) -> p.Name == "s")
        Assert.NotNull(param)
        Assert.False(param!!.IsScoped)
    }

    @Fact
    func Scoped_UsableAsIdentifier_WhenNotFollowedByIdentifier() {
        // `scoped` used as a plain variable name (not followed by another
        // identifier) must remain a valid identifier, not be consumed as a
        // modifier.
        let source = `
var scoped = 42
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    // -----------------------------------------------------------------------
    // scoped + ref struct: returning a scoped ref struct parameter (GS0219)
    // -----------------------------------------------------------------------
    @Fact
    func ScopedRefStructParam_Returned_Reports_GS0219() {
        // A `scoped` ref struct parameter has safe-to-escape = function-local;
        // it must not be returned.
        let source = `
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func NonScopedRefStructParam_Returned_IsLegal() {
        // Without `scoped`, the parameter's STE is caller scope — returning is
        // legal (same as C#'s default for ref struct parameters).
        let source = `
import System
func passThrough(s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func ScopedRefStructParam_MemberAccess_IsLegal() {
        // Using a member of a `scoped` ref struct parameter (not returning
        // the ref struct itself) is fine.
        let source = `
import System
func length(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func ScopedPlainParam_NotRefStruct_NoGS0219() {
        // `scoped` on a non-ref-struct parameter does not produce GS0219
        // (the restriction only applies when returning a ref struct value).
        let source = `
package P
func f(scoped x int32) int32 {
    return x
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_ScopedRefStruct_Returned_Reports_GS0219() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
func bad(scoped a Acc) Acc {
    return a
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func UserDeclared_NonScopedRefStruct_Returned_IsLegal() {
        let source = `
package P
ref struct Acc {
    var Total int32
}
func passThrough(a Acc) Acc {
    return a
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // -----------------------------------------------------------------------
    // scoped on local variable declarations (Phase 1)
    // -----------------------------------------------------------------------
    @Fact
    func ScopedLocal_RefStruct_Returned_Reports_GS0219() {
        let source = `
import System
func bad() ReadOnlySpan[int32] {
    var scoped s ReadOnlySpan[int32]
    return s
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func ScopedLocal_RefStruct_NotReturned_IsLegal() {
        let source = `
import System
func ok() int32 {
    var scoped s ReadOnlySpan[int32]
    return s.Length
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func ScopedLocal_Let_RefStruct_Returned_Reports_GS0219() {
        let source = `
import System
func bad(data ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let scoped local = data
    return local
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func Scoped_UsableAsLocalIdentifier() {
        // `scoped` used as a variable name (let scoped = 42) should still work
        // when not followed by another identifier that forms a name.
        let source = `
let scoped = 42
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.IsError)
    }

    // -----------------------------------------------------------------------
    // STE propagation through initializers (Phase 2)
    // -----------------------------------------------------------------------
    @Fact
    func STE_Propagation_LocalInitFromScopedParam_Reports_GS0219() {
        // `let x = scopedParam` → x inherits function-local STE → cannot return x
        let source = `
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let x = s
    return x
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func STE_Propagation_LocalInitFromNonScopedParam_IsLegal() {
        let source = `
import System
func ok(s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    let x = s
    return x
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func STE_Propagation_ThroughConversion_Reports_GS0219() {
        // Implicit conversion preserves STE.
        let source = `
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    var x ReadOnlySpan[int32] = s
    return x
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // -----------------------------------------------------------------------
    // [UnscopedRef] and ref struct methods (Phase 3; revised by ADR-0184)
    // -----------------------------------------------------------------------
    /// ADR-0184 D1 (conformance fix). This used to assert the opposite — that
    /// `return this` BY VALUE out of a `ref struct` member reports
    /// GS0219 — which conflated the receiver's two escape scopes. Only the
    /// REF-safe-context of `this` is function-local by default; its
    /// safe-to-escape (value) scope is the caller's, because the value the
    /// receiver holds was produced by, and outlives, the call. Real C# accepts
    /// exactly this shape with no annotation, and no annotation makes it
    /// illegal either — `@UnscopedRef` is not what governs it.
    @Fact
    func RefStructMethod_ReturnsThis_ByValue_IsLegal() {
        let source = `
package P
ref struct MySpan {
    var Value int32

    func getSelf() MySpan {
        return this
    }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
        Assert.Empty(diagnostics)
    }

    /// ADR-0184 D1's other half: the value-scope relaxation above must not
    /// leak into a genuinely scoped SOURCE. A `scoped` parameter's value
    /// is still function-local, so returning it — or a local seeded from it —
    /// is still GS0219, inside a struct member exactly as at top level.
    @Fact
    func RefStructMethod_ReturnsScopedParameter_StillReports_GS0219() {
        let source = `
package P
import System
ref struct MySpan {
    var Value int32

    func pick(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
        return s
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    @Fact
    func RefStructMethod_ReturnsNonRefStructField_IsLegal() {
        // Returning a non-ref-struct field from a ref struct method is fine.
        let source = `
package P
ref struct MySpan {
    var Value int32
}
func (s MySpan) getValue() int32 {
    return Value
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    /// ADR-0184. The pre-ADR-0184 version of this test wrote `@UnscopedRef`
    /// on a RECEIVER-CLAUSE func and with no `import`, so it proved neither
    /// thing it claimed: the annotation could not resolve (GS0198, which the
    /// single `DoesNotContain(GS0219)` assertion never noticed), and GS0219
    /// is not what `@UnscopedRef` governs in the first place. The in-struct
    /// spelling below is the shape the annotation actually applies to; the
    /// receiver-clause spelling is now a placement error in its own test.
    @Fact
    func RefStructMethod_WithUnscopedRef_ReturnsRefToOwnState_IsLegal() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
ref struct MySpan {
    var Value int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Value
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    /// ADR-0184: the same shape on an ordinary (non-`ref`) struct.
    @Fact
    func StructMethod_WithUnscopedRef_ReturnsRefToOwnState_IsLegal() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    /// ADR-0184: without the annotation the same member is rejected — with the
    /// dedicated GS0589, not the generic GS0254 ("function-local storage",
    /// which is wrong here: the storage is the CALLER's) and not GS0253
    /// ("must be an lvalue", which is what the pre-ADR-0184 compiler reported
    /// because it classified every `this` as read-only storage).
    @Fact
    func StructMethod_WithoutUnscopedRef_ReturnsRefToOwnState_Reports_GS0589() {
        let source = `
package P
struct Acc {
    var Total int32

    func slot() ref int32 {
        return ref this.Total
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0253")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    /// ADR-0184: the bare-name spelling lowers to a `this` access, so it
    /// reaches the same diagnostic, and a nested `this.a.b` chain does too.
    @Theory
    @InlineData("return ref Total")
    @InlineData("return ref this.Total")
    func StructMethod_ReturnsRefToOwnState_BothSpellings_Report_GS0589(returnStatement string) {
        let source = `
package P
struct Acc {
    var Total int32

    func slot() ref int32 {
        ` + returnStatement + `
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    /// ADR-0184: a reference rooted at a LOCAL still gets the generic GS0254.
    @Fact
    func RefReturn_RootedAtLocal_StillReports_GS0254_NotGS0589() {
        let source = `
package P
struct Acc {
    var Total int32
}
func f() ref int32 {
    var a Acc = default(Acc)
    return ref a.Total
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    /// ADR-0184: `@UnscopedRef` lifts the ESCAPE-scope restriction only.
    /// A genuinely read-only field (`let`) is still not writable storage,
    /// so it still fails the lvalue/readonly gate with GS0253.
    @Fact
    func StructMethod_WithUnscopedRef_ReturnsRefToLetField_StillReports_GS0253() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    let Total int32 = 0

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0253")
    }

    /// ADR-0184 §8: the property/indexer spelling. The annotation is written
    /// once on the member and pushed down onto the accessors, which have no
    /// attribute list of their own.
    @Theory
    @InlineData("prop Slot ref int32")
    @InlineData("prop this[i int32] ref int32")
    func StructProperty_WithUnscopedRef_ReturnsRefToOwnState_IsLegal(header string) {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
ref struct Ring {
    var Value int32

    @UnscopedRef
    ` + header + ` {
        get { return ref this.Value }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    /// ADR-0184: the same accessor without the annotation is GS0589.
    @Fact
    func StructIndexer_WithoutUnscopedRef_ReturnsRefToOwnState_Reports_GS0589() {
        let source = `
package P
ref struct Ring {
    var Value int32

    prop this[i int32] ref int32 {
        get { return ref this.Value }
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    /// ADR-0184: `return ref this` — a reference to the whole receiver —
    /// is the widest form the annotation permits, and is legal in C# too.
    @Fact
    func StructMethod_WithUnscopedRef_ReturnsRefToThis_IsLegal() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func self() ref Acc {
        return ref this
    }
}
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    /// ADR-0184: type-identity recognition (ADR-0084 §L5). The annotation is a
    /// real CLR attribute now, not a name match, so the `import` is load
    /// bearing — without it the attribute does not resolve (GS0198) and the
    /// member is not un-scoped.
    @Fact
    func UnscopedRef_WithoutImport_Reports_GS0198_AndIsNotHonoured() {
        let source = `
package P
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0198")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0589")
    }

    // -----------------------------------------------------------------------
    // ADR-0184: @UnscopedRef placement validation (GS0590)
    // -----------------------------------------------------------------------
    @Theory
    @InlineData(`
package P
import System.Diagnostics.CodeAnalysis
ref struct MySpan {
    var Value int32
}
@UnscopedRef
func (s MySpan) getSelf() MySpan {
    return s
}
`)
    @InlineData(`
package P
import System.Diagnostics.CodeAnalysis
@UnscopedRef
func free() int32 {
    return 1
}
`)
    @InlineData(`
package P
import System.Diagnostics.CodeAnalysis
class Box {
    var Total int32

    @UnscopedRef
    func total() ref int32 {
        return ref this.Total
    }
}
`)
    @InlineData(`
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
`)
    @InlineData(`
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
`)
    @InlineData(`
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
`)
    @InlineData(`
package P
import System.Diagnostics.CodeAnalysis
class Box {
    var Backing int32

    @UnscopedRef
    prop Total ref int32 {
        get { return ref this.Backing }
    }
}
`)
    func UnscopedRef_OnUnsupportedTarget_Reports_GS0590(source string) {
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0590")
    }

    /// ADR-0184: GREEN counterpart to the GS0590 theory — the one supported
    /// shape must not trip the placement check.
    @Fact
    func UnscopedRef_OnStructInstanceMember_DoesNotReport_GS0590() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
struct Acc {
    var Total int32

    @UnscopedRef
    func slot() ref int32 {
        return ref this.Total
    }
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0590")
    }

    /// ADR-0184 D2: a struct member's `this` is writable storage in EVERY
    /// instance member, annotated or not — the CLR passes it as `ref S`.
    /// Taking its address, writing through it, and passing it to a writable
    /// `ref` parameter must all stay legal without `@UnscopedRef`.
    @Fact
    func StructMember_ThisIsWritableStorage_WithoutUnscopedRef() {
        let source = `
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
`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func NonRefStructMethod_ReturnsThis_IsLegal() {
        // Non-ref-struct methods don't have implicit scoped on `this`.
        let source = `
package P
struct Builder {
    var Count int32
}
func (b Builder) copy() Builder {
    return b
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    // -----------------------------------------------------------------------
    // scoped ref (*T) parameter (Phase 4)
    // -----------------------------------------------------------------------
    @Fact
    func ScopedByRefParam_CannotBeReturned_GS9004() {
        // A scoped *T parameter still triggers GS9004 on return (the scoped
        // adds RSTE restriction, but GS9004 already prevents all *T returns).
        let source = `
package P
func bad(scoped p *int32) *int32 {
    return p
}
`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
    }

    @Fact
    func ScopedByRefParam_UsedLocally_IsLegal() {
        // Using a scoped *T parameter locally (dereferencing) is fine.
        let source = `
package P
func read(scoped p *int32) int32 {
    return *p
}
`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9004")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0219")
    }

    shared {
        // -----------------------------------------------------------------------
        // Helpers
        // -----------------------------------------------------------------------
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = Binder.BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }
    }
}
