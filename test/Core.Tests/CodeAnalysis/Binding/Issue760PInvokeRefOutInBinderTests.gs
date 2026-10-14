// <copyright file="Issue760PInvokeRefOutInBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Binder coverage for ADR-0094 / issue #760 — P/Invoke `ref`/`out`/`in`
/// parameter marshalling. The follow-up to ADR-0086 (which blanket-rejected
/// every ref-kind parameter as GS0326) and ADR-0093 (struct marshalling).
/// The acceptance rule is "the pointee must be blittable": blittable
/// primitives and `@StructLayout`-annotated structs are accepted under
/// either `@DllImport` or `@LibraryImport`; `bool`,
/// `char`, `string`, `object`, and unannotated structs are
/// rejected with a tailored GS0352 (or GS0349 for the struct path).
open class Issue760PInvokeRefOutInBinderTests {
    @Fact
    func DllImport_With_Ref_Int32_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;
`
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_time")
        Assert.True(fn.IsPInvoke)
        Assert.Equal(RefKind.Ref, fn.Parameters[0].RefKind)
        Assert.Same(TypeSymbol.Int64, fn.Parameters[0].Type)
        AssertNoPInvokeShapeDiagnostics(scope_)
    }

    @Fact
    func DllImport_With_Out_Int32_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_out")
func native_out(out p int32) int32;
`
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_out")
        Assert.True(fn.IsPInvoke)
        Assert.Equal(RefKind.Out, fn.Parameters[0].RefKind)
        AssertNoPInvokeShapeDiagnostics(scope_)
    }

    @Fact
    func DllImport_With_In_Int32_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_in")
func native_in(in p int32) int32;
`
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_in")
        Assert.True(fn.IsPInvoke)
        Assert.Equal(RefKind.In, fn.Parameters[0].RefKind)
        AssertNoPInvokeShapeDiagnostics(scope_)
    }

    @Fact
    func LibraryImport_With_Ref_Int64_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "time")
func native_time(ref t int64) int64;
`
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_time")
        Assert.True(fn.IsPInvoke)
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
        Assert.Equal(RefKind.Ref, fn.Parameters[0].RefKind)
        AssertNoPInvokeShapeDiagnostics(scope_)
    }

    @Fact
    func LibraryImport_With_Out_Int32_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "native_out")
func native_out(out p int32) int32;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0326" || d.Id == "GS0352")
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_out")
        Assert.True(fn.IsPInvoke)
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
    }

    @Fact
    func DllImport_With_Ref_BlittableStruct_Parameter_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@StructLayout(LayoutKind.Sequential)
struct Point {
    var X int32
    var Y int32
}

@DllImport("libc", EntryPoint: "native_point")
func native_point(ref p Point) int32;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0349" || d.Id == "GS0352" || d.Id == "GS0326"
        )
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_point")
        Assert.True(fn.IsPInvoke)
        Assert.Equal(RefKind.Ref, fn.Parameters[0].RefKind)
    }

    @Fact
    func DllImport_With_Ref_NonBlittableStruct_Parameter_Reports_GS0349() {
        // No `@StructLayout` => default `Auto` => non-blittable for P/Invoke.
        // `bool` field also forces non-blittable.
        const source = `
package P
import System.Runtime.InteropServices

struct Bad {
    var Flag bool
}

@DllImport("libc", EntryPoint: "native_bad")
func native_bad(ref p Bad) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0349")
    }

    @Fact
    func DllImport_With_Ref_String_Reports_GS0352() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_str")
func native_str(ref s string) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0352")
        // GS0326 (the old blanket "ref/out/in not supported") must NOT fire.
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0326")
    }

    @Fact
    func DllImport_With_Ref_Bool_Reports_GS0352() {
        // `bool` is non-blittable (CLR `bool` is 1 byte but P/Invoke's
        // unmanaged form depends on the surrounding `@MarshalAs`).
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_bool")
func native_bool(ref b bool) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0352")
    }

    @Theory
    @InlineData("Bool")
    @InlineData("I1")
    @InlineData("U1")
    func DllImport_With_ExplicitlyMarshaled_RefBool_Is_Accepted(unmanagedType string) {
        let source = (`
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_bool")
func native_bool(@MarshalAs(UnmanagedType.` + "$unmanagedType" + `) ref b bool) int32;
`)
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_bool")
        Assert.Equal(RefKind.Ref, fn.Parameters[0].RefKind)
        Assert.NotNull(fn.Parameters[0].MarshalAsMetadata)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> (d.Id is "GS0352" or "GS0357" or "GS0358"))
    }

    @Theory
    @InlineData("I4")
    @InlineData("VariantBool")
    func DllImport_With_Unsupported_RefBool_MarshalForm_Reports_GS0352(unmanagedType string) {
        let source = (`
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_bool")
func native_bool(@MarshalAs(UnmanagedType.` + "$unmanagedType" + `) ref b bool) int32;
`)
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0352")
    }

    @Fact
    func LibraryImport_With_ExplicitlyMarshaled_OutBool_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "native_bool")
func native_bool(@MarshalAs(UnmanagedType.Bool) out b bool) int32;
`
        let scope_ = BindSource(source)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_bool")
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
        Assert.Equal(RefKind.Out, fn.Parameters[0].RefKind)
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> (d.Id is "GS0352" or "GS0357" or "GS0358" or "GS0360")
        )
    }

    @Fact
    func DllImport_With_Ref_Char_Reports_GS0352() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_char")
func native_char(ref c char) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0352")
    }

    @Fact
    func DllImport_With_Out_NonBlittablePrimitive_Reports_GS0352() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_out_str")
func native_out_str(out s string) int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0352")
    }

    @Fact
    func DllImport_With_RefKind_Does_Not_Report_GS0326_Anymore() {
        // Regression: ADR-0086 / issue #727 used to reject every ref-kind
        // parameter with GS0326 "ref/out/in is not supported". ADR-0094 /
        // issue #760 lifts that rejection.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "native_in")
func native_in(ref a int32, out b int64, in c float64) int32;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0326" && d.Message.Contains("ref/out/in")
        )
    }

    @Fact
    func DllImport_With_RefKind_AcceptsAllSupportedPrimitives() {
        // Spot-check each blittable primitive accepted as a byref pointee.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "f") func f1(ref x int8) int32;
@DllImport("libc", EntryPoint: "f") func f2(ref x uint8) int32;
@DllImport("libc", EntryPoint: "f") func f3(ref x int16) int32;
@DllImport("libc", EntryPoint: "f") func f4(ref x uint16) int32;
@DllImport("libc", EntryPoint: "f") func f5(ref x int32) int32;
@DllImport("libc", EntryPoint: "f") func f6(ref x uint32) int32;
@DllImport("libc", EntryPoint: "f") func f7(ref x int64) int32;
@DllImport("libc", EntryPoint: "f") func f8(ref x uint64) int32;
@DllImport("libc", EntryPoint: "f") func f9(ref x nint) int32;
@DllImport("libc", EntryPoint: "f") func f10(ref x nuint) int32;
@DllImport("libc", EntryPoint: "f") func f11(ref x float32) int32;
@DllImport("libc", EntryPoint: "f") func f12(ref x float64) int32;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> (d.Id is "GS0326" or "GS0349" or "GS0352"))
    }

    @Fact
    func DllImport_With_RefKindOnReturn_Still_Reports_GS0326() {
        // The function-shape constraint for ref-returns (separate from
        // parameter ref-kinds) is unchanged: GS0326 should still fire for
        // a ref-returning P/Invoke.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "f")
func f() ref int32;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0326")
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func AssertNoPInvokeShapeDiagnostics($scope BoundGlobalScope) {
            Assert.DoesNotContain(
                $scope.Diagnostics,
                (d Diagnostic) -> (
                    d.Id is "GS0322" or
                        "GS0323" or
                        "GS0324" or
                        "GS0325" or
                        "GS0326" or
                        "GS0327" or
                        "GS0328" or
                        "GS0329" or
                        "GS0349" or
                        "GS0352"
                )
            )
        }
    }
}
