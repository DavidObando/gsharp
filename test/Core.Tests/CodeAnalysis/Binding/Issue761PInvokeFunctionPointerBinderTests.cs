// <copyright file="Issue761PInvokeFunctionPointerBinderTests.cs" company="GSharp">
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
/// Binder coverage for ADR-0095 / issue #761 — P/Invoke function-pointer
/// marshalling. Validates the new diagnostics (GS0353 missing
/// <c>@UnmanagedFunctionPointer</c>, GS0354 unknown calling convention,
/// GS0355 delegate return, GS0356 missing calling-convention slot) and
/// confirms that the accepted shapes — delegate types with
/// <c>@UnmanagedFunctionPointer</c> and raw <c>unmanaged[CC] (...) -&gt; R</c>
/// function pointers — bind cleanly with no spurious diagnostics.
/// </summary>
public class Issue761PInvokeFunctionPointerBinderTests
{
    [Fact]
    public void DelegateParameter_WithoutUnmanagedFunctionPointer_ReportsGS0353()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

type Comparer = delegate func(a nint, b nint) int32

@DllImport(""libc"", EntryPoint: ""qsort"")
func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0353");
    }

    [Fact]
    public void DelegateParameter_WithUnmanagedFunctionPointer_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Comparer = delegate func(a nint, b nint) int32

@DllImport(""libc"", EntryPoint: ""qsort"")
func native_qsort(base nint, nmemb nint, size nint, cmp Comparer) void;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0353");
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id == "GS0276"); // attribute target check passes for delegates
        var fn = scope.Functions.Single(f => f.Name == "native_qsort");
        Assert.True(fn.IsPInvoke);
    }

    [Fact]
    public void FunctionPointerParameter_RawShape_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"", EntryPoint: ""qsort"")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
";
        var scope = BindSource(source);
        AssertNoPInvokeShapeDiagnostics(scope);
        var fn = scope.Functions.Single(f => f.Name == "native_qsort");
        Assert.True(fn.IsPInvoke);
        Assert.IsType<FunctionPointerTypeSymbol>(fn.Parameters[3].Type);
    }

    [Fact]
    public void FunctionPointer_AsReturnType_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"", EntryPoint: ""dlsym"")
func native_dlsym(handle nint, name string) unmanaged[Cdecl] () -> void;
";
        var scope = BindSource(source);
        AssertNoPInvokeShapeDiagnostics(scope);
        var fn = scope.Functions.Single(f => f.Name == "native_dlsym");
        Assert.True(fn.IsPInvoke);
        Assert.IsType<FunctionPointerTypeSymbol>(fn.Type);
    }

    [Fact]
    public void DelegateReturnType_ReportsGS0355()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@UnmanagedFunctionPointer(CallingConvention.Cdecl)
type Callback = delegate func() void

@DllImport(""libc"", EntryPoint: ""f"")
func bad() Callback;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0355");
    }

    [Fact]
    public void UnknownCallingConvention_ReportsGS0354()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func bad(cb unmanaged[Garbage] () -> void) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0354");
    }

    [Fact]
    public void FunctionPointer_AllSupportedConventions_BindToCorrectEnum()
    {
        var cases = new[]
        {
            ("Cdecl", System.Runtime.InteropServices.CallingConvention.Cdecl),
            ("Stdcall", System.Runtime.InteropServices.CallingConvention.StdCall),
            ("Thiscall", System.Runtime.InteropServices.CallingConvention.ThisCall),
            ("Fastcall", System.Runtime.InteropServices.CallingConvention.FastCall),
        };
        foreach (var (spelling, expected) in cases)
        {
            var source = $@"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func f(cb unmanaged[{spelling}] () -> void) void;
";
            var scope = BindSource(source);
            AssertNoPInvokeShapeDiagnostics(scope);
            var fn = scope.Functions.Single(f => f.Name == "f");
            var fp = Assert.IsType<FunctionPointerTypeSymbol>(fn.Parameters[0].Type);
            Assert.Equal(expected, fp.CallingConvention);
        }
    }

    [Fact]
    public void LibraryImport_With_FunctionPointer_Parameter_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", EntryPoint: ""qsort"")
func native_qsort(base nint, nmemb nint, size nint, cmp unmanaged[Cdecl] (nint, nint) -> int32) void;
";
        var scope = BindSource(source);
        AssertNoPInvokeShapeDiagnostics(scope);
        var fn = scope.Functions.Single(f => f.Name == "native_qsort");
        Assert.True(fn.IsPInvoke);
    }

    [Fact]
    public void LibraryImport_With_Delegate_Without_Attribute_ReportsGS0353()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

type Cb = delegate func() void

@LibraryImport(""libc"", EntryPoint: ""f"")
func native_f(cb Cb) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0353");
    }

    [Fact]
    public void FunctionPointerType_IsStructurallyInterned()
    {
        // ADR-0095 §3: two textually-identical function-pointer type
        // clauses must resolve to the same FunctionPointerTypeSymbol
        // instance so downstream comparisons (overload resolution,
        // conversion classification) work by reference equality.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func one(cb unmanaged[Cdecl] (nint, nint) -> int32) void;

@DllImport(""libc"")
func two(cb unmanaged[Cdecl] (nint, nint) -> int32) void;
";
        var scope = BindSource(source);
        var one = scope.Functions.Single(f => f.Name == "one");
        var two = scope.Functions.Single(f => f.Name == "two");
        Assert.Same(one.Parameters[0].Type, two.Parameters[0].Type);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static void AssertNoPInvokeShapeDiagnostics(BoundGlobalScope scope)
    {
        Assert.DoesNotContain(
            scope.Diagnostics,
            d => d.Id is "GS0322" or "GS0323" or "GS0324" or "GS0325" or "GS0326" or "GS0327" or "GS0328" or "GS0329" or "GS0349" or "GS0352" or "GS0353" or "GS0354" or "GS0355" or "GS0356");
    }
}
