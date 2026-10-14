// <copyright file="Issue727PInvokeBinderTests.cs" company="GSharp">
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

/// Binder coverage for ADR-0086 / issue #727: P/Invoke functions are
/// recognised by their `@DllImport` attribute, validated against the
/// supported marshalling table, and surfaced through
/// (cref:FunctionSymbol.IsPInvoke) + (cref:FunctionSymbol.PInvokeMetadata).
/// Each negative test pins a single diagnostic from the GS0322–GS0329
/// range introduced by the ADR.
open class Issue727PInvokeBinderTests {
    @Fact
    func WellFormed_DllImport_Marks_Function_As_PInvoke() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "strlen", CharSet: CharSet.Ansi, SetLastError: true)
func MyStrLen(text string) nint;
`
        let globalScope = BindSource(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MyStrLen")
        Assert.True(fn.IsPInvoke)
        Assert.NotNull(fn.PInvokeMetadata)
        Assert.Equal("libc", fn.PInvokeMetadata!!.LibraryName)
        Assert.Equal("strlen", fn.PInvokeMetadata!!.EntryPoint)
        Assert.Equal(CharSet.Ansi, fn.PInvokeMetadata!!.CharSet)
        Assert.True(fn.PInvokeMetadata!!.SetLastError)
        Assert.DoesNotContain(
            GetDiagnostics(globalScope),
            (d Diagnostic) -> (
                d.Id is "GS0322" or "GS0323" or "GS0324" or "GS0325" or "GS0326" or "GS0327" or "GS0328" or "GS0329"
            )
        )
    }

    @Fact
    func Function_With_Semicolon_Body_Without_DllImport_Reports_GS0325() {
        const source = `
package P

func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0325")
    }

    @Fact
    func DllImport_With_Body_Reports_GS0324() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func Foo() int32 {
    return 0
}
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0324")
    }

    @Fact
    func DllImport_With_Missing_Library_Reports_GS0322() {
        // No positional library name argument.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport
func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0322")
    }

    @Fact
    func DllImport_With_Unsupported_Parameter_Type_Reports_GS0323() {
        const source = `
package P
import System
import System.Runtime.InteropServices

@DllImport("libc")
func Foo(o Object) int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func DllImport_With_Unsupported_Return_Type_Reports_GS0323() {
        const source = `
package P
import System
import System.Runtime.InteropServices

@DllImport("libc")
func Foo() Object;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0323")
    }

    @Fact
    func DllImport_With_Empty_EntryPoint_Reports_GS0329() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc", EntryPoint: "")
func Foo() int32;
`
        let globalScope = BindSource(source)
        Assert.Contains(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0329")
    }

    @Fact
    func Default_EntryPoint_Falls_Back_To_Function_Name() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func MyEntry() int32;
`
        let globalScope = BindSource(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "MyEntry")
        Assert.True(fn.IsPInvoke)
        Assert.Equal("MyEntry", fn.PInvokeMetadata!!.EntryPoint)
    }

    @Fact
    func Without_DllImport_Function_Is_Not_PInvoke() {
        const source = `
package P

func Foo() int32 {
    return 0
}
`
        let globalScope = BindSource(source)
        let fn = globalScope.Functions.Single((f FunctionSymbol) -> f.Name == "Foo")
        Assert.False(fn.IsPInvoke)
        Assert.Null(fn.PInvokeMetadata)
    }

    @Fact
    func DllImport_Does_Not_Emit_GS0211_Anymore() {
        // Regression: the old "DllImport is not supported" rejection was
        // removed by ADR-0086. Well-formed @DllImport must not produce GS0211.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func MyEntry() int32;
`
        let globalScope = BindSource(source)
        Assert.DoesNotContain(GetDiagnostics(globalScope), (d Diagnostic) -> d.Id == "GS0211")
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func GetDiagnostics($scope BoundGlobalScope) IEnumerable[Diagnostic] -> $scope.Diagnostics
    }
}
