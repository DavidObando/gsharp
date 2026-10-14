// <copyright file="Issue761PInvokeFunctionPointerBinderTests.cs" company="GSharp">
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
import System.Runtime.InteropServices
import Xunit

/// Binder coverage for ADR-0095 / issue #761 — P/Invoke function-pointer
/// marshalling. Validates the new diagnostics (GS0353 missing
/// `@UnmanagedFunctionPointer`, GS0354 unknown calling convention,
/// GS0355 delegate return, GS0356 missing calling-convention slot) and
/// confirms that the accepted shapes — delegate types with
/// `@UnmanagedFunctionPointer` and raw `unmanaged[CC] (...) -> R`
/// function pointers — bind cleanly with no spurious diagnostics.
open class Issue761PInvokeFunctionPointerBinderTests {
    @Fact
    func DelegateParameter_WithoutUnmanagedFunctionPointer_ReportsGS0353() {
        const source = `
package P
import System.Runtime.InteropServices

delegate Comparer(a nint, b nint) int32;

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0353")
    }

    @Fact
    func DelegateParameter_WithUnmanagedFunctionPointer_IsAccepted() {
        const source = `
package P
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate Comparer(a nint, b nint) int32;

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;
`
        let scope_ = BindSource(source)
        Assert.DoesNotContain(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0353")
        Assert.DoesNotContain(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0276"
        ) // attribute target check passes for delegates
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_qsort")
        Assert.True(fn.IsPInvoke)
    }

    @Fact
    func FunctionPointerParameter_RawShape_IsAccepted() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
`
        let scope_ = BindSource(source)
        AssertNoPInvokeShapeDiagnostics(scope_)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_qsort")
        Assert.True(fn.IsPInvoke)
        Assert.IsType[FunctionPointerTypeSymbol](fn.Parameters[3].Type)
    }

    @Fact
    func FunctionPointer_AsReturnType_IsAccepted() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "dlsym")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
`
        let scope_ = BindSource(source)
        AssertNoPInvokeShapeDiagnostics(scope_)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_dlsym")
        Assert.True(fn.IsPInvoke)
        Assert.IsType[FunctionPointerTypeSymbol](fn.Type)
    }

    @Fact
    func DelegateReturnType_ReportsGS0355() {
        const source = `
package P
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
delegate Callback() void;

@DllImport("libc", EntryPoint: "f")
func bad() Callback;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0355")
    }

    @Fact
    func UnknownCallingConvention_ReportsGS0354() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func bad(cb unmanaged[Garbage] () -> void) void;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0354")
    }

    @Fact
    func FunctionPointer_AllSupportedConventions_BindToCorrectEnum() {
        let cases = [](string, CallingConvention){
            ("Cdecl", CallingConvention.Cdecl),
            ("Stdcall", CallingConvention.StdCall),
            ("Thiscall", CallingConvention.ThisCall),
            ("Fastcall", CallingConvention.FastCall)
        }
        for (spelling, expected) in cases {
            let source = (`
package P
import System.Runtime.InteropServices

@DllImport("libc")
func f(cb unmanaged[` + "$spelling" + `] () -> void) void;
`)
            let scope_ = BindSource(source)
            AssertNoPInvokeShapeDiagnostics(scope_)
            let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "f")
            let fp = Assert.IsType[FunctionPointerTypeSymbol](fn.Parameters[0].Type)
            Assert.Equal(expected, fp.CallingConvention)
        }
    }

    @Fact
    func LibraryImport_With_FunctionPointer_Parameter_IsAccepted() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "qsort")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
`
        let scope_ = BindSource(source)
        AssertNoPInvokeShapeDiagnostics(scope_)
        let fn = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "native_qsort")
        Assert.True(fn.IsPInvoke)
    }

    @Fact
    func LibraryImport_With_Delegate_Without_Attribute_ReportsGS0353() {
        const source = `
package P
import System.Runtime.InteropServices

delegate Cb() void;

@LibraryImport("libc", EntryPoint: "f")
func native_f(cb Cb) void;
`
        let scope_ = BindSource(source)
        Assert.Contains(scope_.Diagnostics, (d Diagnostic) -> d.Id == "GS0353")
    }

    @Fact
    func FunctionPointerType_IsStructurallyInterned() {
        // ADR-0095 §3: two textually-identical function-pointer type
        // clauses must resolve to the same FunctionPointerTypeSymbol
        // instance so downstream comparisons (overload resolution,
        // conversion classification) work by reference equality.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func one(cb unmanaged[Cdecl] (nint, nint) -> int32) void;

@DllImport("libc")
func two(cb unmanaged[Cdecl] (nint, nint) -> int32) void;
`
        let scope_ = BindSource(source)
        let one = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "one")
        let two = scope_.Functions.Single((f FunctionSymbol) -> f.Name == "two")
        Assert.Same(one.Parameters[0].Type, two.Parameters[0].Type)
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
                        "GS0352" or
                        "GS0353" or
                        "GS0354" or
                        "GS0355" or
                        "GS0356"
                )
            )
        }
    }
}
