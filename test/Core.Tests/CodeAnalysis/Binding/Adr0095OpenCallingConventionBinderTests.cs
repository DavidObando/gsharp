// <copyright file="Adr0095OpenCallingConventionBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder coverage for ADR-0095 v2 / issue #3611 — the open CLR
/// calling-convention model. Bare <c>unmanaged (T) -&gt; R</c> is the
/// platform-default unmanaged convention; the <c>[CC]</c> slot accepts a
/// comma-separated list resolved against
/// <c>System.Runtime.CompilerServices.CallConv{Name}</c>; a single legacy
/// name keeps the v1 closed-enum path; unknown names report GS0354 with
/// the probed CallConv type.
/// </summary>
public class Adr0095OpenCallingConventionBinderTests
{
    [Fact]
    public void BareUnmanaged_BindsToPlatformDefaultExtendedSymbol()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func bare(cb unmanaged () -> void) void;
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var fnPtr = ParameterPointer(scope, "bare");
        Assert.False(fnPtr.IsManaged);
        Assert.True(fnPtr.IsUnmanagedExtended);
        Assert.Empty(fnPtr.UnmanagedConventions);
        Assert.Equal("unmanaged () -> void", fnPtr.Name);
    }

    [Fact]
    public void SingleLegacyConvention_KeepsTheClosedEnumPath()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func legacy(cb unmanaged[Cdecl] (nint, nint) -> int32) void;
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var fnPtr = ParameterPointer(scope, "legacy");
        Assert.False(fnPtr.IsUnmanagedExtended);
        Assert.Equal(System.Runtime.InteropServices.CallingConvention.Cdecl, fnPtr.CallingConvention);
    }

    [Fact]
    public void SingleNonLegacyConvention_ResolvesAgainstCallConvType()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func suppress(cb unmanaged[SuppressGCTransition] (int32) -> int32) void;
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var fnPtr = ParameterPointer(scope, "suppress");
        Assert.True(fnPtr.IsUnmanagedExtended);
        Assert.Equal(new[] { "SuppressGCTransition" }, fnPtr.UnmanagedConventions);
        Assert.Equal(
            new[] { "System.Runtime.CompilerServices.CallConvSuppressGCTransition" },
            fnPtr.UnmanagedConventionClrTypes.Select(t => t.FullName));
    }

    [Fact]
    public void CombinedConventions_PreserveSourceOrderIdentity()
    {
        // Source order is identity (the modopt blob is ordered): the two
        // orderings are DISTINCT interned symbols.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func ab(cb unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32) void;

@DllImport(""libc"")
func ba(cb unmanaged[SuppressGCTransition, Cdecl] (int32) -> int32) void;
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var ab = ParameterPointer(scope, "ab");
        var ba = ParameterPointer(scope, "ba");
        Assert.Equal(new[] { "Cdecl", "SuppressGCTransition" }, ab.UnmanagedConventions);
        Assert.Equal(new[] { "SuppressGCTransition", "Cdecl" }, ba.UnmanagedConventions);
        Assert.NotSame(ab, ba);
        Assert.Equal("unmanaged[Cdecl, SuppressGCTransition] (int32) -> int32", ab.Name);
    }

    [Fact]
    public void LegacyNameInsideCombinedList_TakesTheOpenPath()
    {
        // C# encodes `unmanaged[Cdecl, ...]` via CallConvCdecl modopts —
        // the legacy fast path only covers a SINGLE legacy name.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func combined(cb unmanaged[MemberFunction, Stdcall] (int32) -> int32) void;
";
        var scope = BindSource(source);
        Assert.Empty(scope.Diagnostics);

        var fnPtr = ParameterPointer(scope, "combined");
        Assert.True(fnPtr.IsUnmanagedExtended);
        Assert.Equal(new[] { "MemberFunction", "Stdcall" }, fnPtr.UnmanagedConventions);
    }

    [Fact]
    public void UnknownConvention_ReportsGS0354()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func bogus(cb unmanaged[NotARealConvention] () -> void) void;
";
        var scope = BindSource(source);
        Assert.Contains(
            scope.Diagnostics,
            d => d.Id == "GS0354"
                && d.Message.Contains("CallConvNotARealConvention", System.StringComparison.Ordinal));
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static FunctionPointerTypeSymbol ParameterPointer(BoundGlobalScope scope, string functionName)
    {
        var fn = scope.Functions.Single(f => f.Name == functionName);
        return Assert.IsType<FunctionPointerTypeSymbol>(fn.Parameters[0].Type);
    }
}
