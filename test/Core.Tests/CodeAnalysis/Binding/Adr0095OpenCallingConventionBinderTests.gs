// <copyright file="Adr0095OpenCallingConventionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Binder coverage for ADR-0095 v2 / issue #3611 — the open CLR
/// calling-convention model. Bare `unmanaged (T) -> R` is the
/// platform-default unmanaged convention; the `[CC]` slot accepts a
/// comma-separated list resolved against
/// `System.Runtime.CompilerServices.CallConv{Name}`; a single legacy
/// name keeps the v1 closed-enum path; unknown names report GS0354 with
/// the probed CallConv type.
open class Adr0095OpenCallingConventionBinderTests {
    @Fact
    func BareUnmanaged_BindsToPlatformDefaultExtendedSymbol() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func bare(cb unmanaged () -> void) void;
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let fnPtr = ParameterPointer(scope_, "bare")
        Assert.False(fnPtr.IsManaged)
        Assert.True(fnPtr.IsUnmanagedExtended)
        Assert.Empty(fnPtr.UnmanagedConventions)
        Assert.Equal("unmanaged () -> void", fnPtr.Name)
    }

    @Fact
    func SingleLegacyConvention_KeepsTheClosedEnumPath() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func legacy(cb unmanaged[Cdecl] (nint, nint) -> int32) void;
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let fnPtr = ParameterPointer(scope_, "legacy")
        Assert.False(fnPtr.IsUnmanagedExtended)
        Assert.Equal(CallingConvention.Cdecl, fnPtr.CallingConvention)
    }

    @Fact
    func SingleNonLegacyConvention_ResolvesAgainstCallConvType() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func suppress(cb unmanaged[SuppressGCTransition] (int32) -> int32) void;
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let fnPtr = ParameterPointer(scope_, "suppress")
        Assert.True(fnPtr.IsUnmanagedExtended)
        Assert.Equal([]string{"SuppressGCTransition"}, fnPtr.UnmanagedConventions)
        Assert.Equal(
            []string{"System.Runtime.CompilerServices.CallConvSuppressGCTransition"},
            fnPtr.UnmanagedConventionClrTypes.Select((t Type) -> t.FullName)
        )
    }

    @Fact
    func CombinedConventions_PreserveSourceOrderIdentity() {
        // Source order is identity (the modopt blob is ordered): the two
        // orderings are DISTINCT interned symbols.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func ab(cb unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32) void;

@DllImport("libc")
func ba(cb unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32) void;
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let ab = ParameterPointer(scope_, "ab")
        let ba = ParameterPointer(scope_, "ba")
        Assert.Equal([]string{"Cdecl", "SuppressGCTransition"}, ab.UnmanagedConventions)
        Assert.Equal([]string{"SuppressGCTransition", "Cdecl"}, ba.UnmanagedConventions)
        Assert.NotSame(ab, ba)
        Assert.Equal("unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32", ab.Name)
    }

    @Fact
    func LegacyNameInsideCombinedList_TakesTheOpenPath() {
        // C# encodes `unmanaged[Cdecl, ...]` via CallConvCdecl modopts —
        // the legacy fast path only covers a SINGLE legacy name.
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func combined(cb unmanaged[MemberFunction, Stdcall] (int32) -> int32) void;
`
        let scope_ = BindSource(source)
        Assert.Empty(scope_.Diagnostics)
        let fnPtr = ParameterPointer(scope_, "combined")
        Assert.True(fnPtr.IsUnmanagedExtended)
        Assert.Equal([]string{"MemberFunction", "Stdcall"}, fnPtr.UnmanagedConventions)
    }

    @Fact
    func UnknownConvention_ReportsGS0354() {
        const source = `
package P
import System.Runtime.InteropServices

@DllImport("libc")
func bogus(cb unmanaged[NotARealConvention] () -> void) void;
`
        let scope_ = BindSource(source)
        Assert.Contains(
            scope_.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0354" && d.Message.Contains(
                "CallConvNotARealConvention",
                StringComparison.Ordinal
            )
        )
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }

        private func ParameterPointer($scope BoundGlobalScope, functionName string) FunctionPointerTypeSymbol {
            let fn = $scope.Functions.Single((f FunctionSymbol) -> f.Name == functionName)
            return Assert.IsType[FunctionPointerTypeSymbol](fn.Parameters[0].Type)
        }
    }
}
