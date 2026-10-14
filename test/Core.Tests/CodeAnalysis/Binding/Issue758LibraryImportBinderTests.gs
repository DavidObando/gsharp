// <copyright file="Issue758LibraryImportBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Binder coverage for ADR-0092 / issue #758: P/Invoke functions annotated
/// with `@LibraryImport` are recognised, attached to a
/// (cref:PInvokeMetadata) whose
/// (cref:PInvokeMetadata.IsLibraryImport) flag is `true`, and
/// rejected when paired with the legacy `@DllImport` shape, when the
/// resolved `StringMarshalling` is invalid, or when a string parameter
/// or return is used without an explicit `StringMarshalling`. Per
/// issue #1504 a `string` return type is now supported (the v1 stub
/// materializes the managed string from the inner P/Invoke's raw pointer);
/// it still requires an explicit `StringMarshalling` (GS0344).
open class Issue758LibraryImportBinderTests {
    @Fact
    func WellFormed_LibraryImport_Marks_Function_As_PInvoke_LibraryImport() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "strlen", StringMarshalling: StringMarshalling.Utf8, SetLastError: true)
func MyStrLen(text string) nint;
`
        let globalScope = BindSource(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MyStrLen")
        Assert.True(fn.IsPInvoke)
        Assert.NotNull(fn.PInvokeMetadata)
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
        Assert.Equal("libc", fn.PInvokeMetadata!!.LibraryName)
        Assert.Equal("strlen", fn.PInvokeMetadata!!.EntryPoint)
        Assert.Equal(StringMarshalling.Utf8, fn.PInvokeMetadata!!.StringMarshalling)
        Assert.True(fn.PInvokeMetadata!!.SetLastError)
        Assert.DoesNotContain(
            GetDiagnostics(globalScope),
            (d Diagnostic) -> (d.Id is "GS0322" or "GS0342" or "GS0343" or "GS0344" or "GS0345")
        )
    }

    @Fact
    func LibraryImport_Without_StringMarshalling_On_String_Param_Reports_GS0344() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc")
func MyStrLen(text string) nint;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0344")
    }

    @Fact
    func LibraryImport_With_Utf16_StringMarshalling_Is_Accepted() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", StringMarshalling: StringMarshalling.Utf16)
func MyWideThing(text string) nint;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0344")
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MyWideThing")
        Assert.Equal(StringMarshalling.Utf16, fn.PInvokeMetadata!!.StringMarshalling)
    }

    @Fact
    func LibraryImport_With_Invalid_StringMarshalling_Reports_GS0343() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", StringMarshalling: 99)
func Foo(text string) nint;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0343")
    }

    @Fact
    func Mixing_DllImport_And_LibraryImport_Reports_GS0342() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
@LibraryImport("libc")
func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0342")
    }

    @Fact
    func LibraryImport_With_Body_Reports_GS0324() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc")
func Foo() int32 {
    return 0
}
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0324")
    }

    @Fact
    func LibraryImport_With_String_Return_And_StringMarshalling_Binds_With_No_Diagnostic() {
        // Issue #1504: a `string` return is now supported as long as an
        // explicit StringMarshalling is given. The v1 stub materializes the
        // managed string from the inner P/Invoke's raw native pointer.
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func ReturnsString(name string) string;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(
            GetDiagnostics(globalScope),
            (d Diagnostic) -> (d.Id is "GS0322" or "GS0342" or "GS0343" or "GS0344" or "GS0345")
        )
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "ReturnsString")
        Assert.True(fn.IsPInvoke)
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
        Assert.Equal("getenv", fn.PInvokeMetadata!!.EntryPoint)
        Assert.Equal(StringMarshalling.Utf8, fn.PInvokeMetadata!!.StringMarshalling)
    }

    @Fact
    func LibraryImport_With_String_Return_Utf16_Binds_With_No_Diagnostic() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf16)
func ReturnsWideString() string;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetDiagnostics(globalScope), (d Diagnostic) -> (d.Id is "GS0344" or "GS0345"))
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "ReturnsWideString")
        Assert.Equal(StringMarshalling.Utf16, fn.PInvokeMetadata!!.StringMarshalling)
    }

    @Fact
    func LibraryImport_With_String_Return_Without_StringMarshalling_Still_Reports_GS0344() {
        // Issue #1504: GS0345 is gone, but a string return without an
        // explicit StringMarshalling still fails GS0344 (the encoding is
        // ambiguous). `returnIsString` feeds the string-surface check.
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv")
func ReturnsString() string;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0344")
    }

    @Fact
    func LibraryImport_With_String_Return_Is_Never_Rejected_With_GS0345() {
        // Issue #1504: GS0345 was removed entirely; no string-return shape
        // should ever surface it again.
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getenv", StringMarshalling: StringMarshalling.Utf8)
func ReturnsString(name string) string;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0345")
    }

    @Fact
    func LibraryImport_With_Missing_Library_Reports_GS0322() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport
func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0322")
    }

    @Fact
    func LibraryImport_With_Unsupported_Parameter_Type_Reports_GS0323() {
        const source = `
package P
import System
import System.Runtime.InteropServices

@LibraryImport("libc")
func Foo(o Object) int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func LibraryImport_With_No_Strings_Does_Not_Require_StringMarshalling() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "getpid")
func MyPid() int32;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0344")
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MyPid")
        Assert.True(fn.IsPInvoke)
        Assert.True(fn.PInvokeMetadata!!.IsLibraryImport)
        Assert.Equal("getpid", fn.PInvokeMetadata!!.EntryPoint)
    }

    @Fact
    func LibraryImport_Default_EntryPoint_Falls_Back_To_Function_Name() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc")
func getpid() int32;
`
        let globalScope = BindSource(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "getpid")
        Assert.Equal("getpid", fn.PInvokeMetadata!!.EntryPoint)
    }

    @Fact
    func LibraryImport_With_Empty_EntryPoint_Reports_GS0329() {
        const source = `
package P
import System.Runtime.InteropServices

@LibraryImport("libc", EntryPoint: "")
func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0329")
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] -> $scope.Diagnostics
    }
}
