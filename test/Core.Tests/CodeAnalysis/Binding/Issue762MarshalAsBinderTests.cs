// <copyright file="Issue762MarshalAsBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Binder coverage for ADR-0096 / issue #762 — validation of
/// per-parameter <c>@MarshalAs(UnmanagedType.…)</c> overrides on
/// P/Invoke declarations. Confirms the accepted UnmanagedType values
/// flow into <c>ParameterSymbol.MarshalAsMetadata</c>, that the
/// type-compatibility table (§3) fires GS0358 on mismatches, that the
/// required-knob check fires GS0359 for ByValTStr / ByValArray /
/// LPArray, that unsupported UnmanagedType values fire GS0357, and that
/// GS0360 lights up for both LibraryImport-string and non-P/Invoke
/// misuse.
/// </summary>
public class Issue762MarshalAsBinderTests
{
    [Fact]
    public void MarshalAs_LPWStr_OnStringParameter_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""user32"", EntryPoint: ""MessageBoxW"")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "MessageBoxW");
        Assert.Equal(UnmanagedType.LPWStr, fn.Parameters[1].MarshalAsMetadata.UnmanagedType);
        Assert.Equal(UnmanagedType.LPWStr, fn.Parameters[2].MarshalAsMetadata.UnmanagedType);
        Assert.Null(fn.Parameters[0].MarshalAsMetadata);
        Assert.Null(fn.Parameters[3].MarshalAsMetadata);
    }

    [Theory]
    [InlineData("LPStr")]
    [InlineData("LPWStr")]
    [InlineData("LPUTF8Str")]
    [InlineData("BStr")]
    public void MarshalAs_StringForms_OnString_Accept(string form)
    {
        var source = $@"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.{form}) s string) void;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");
    }

    [Fact]
    public void MarshalAs_I4_OnBool_Accept()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""set_flag"")
func native_set_flag(@MarshalAs(UnmanagedType.I4) on bool) int32;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "native_set_flag");
        Assert.Equal(UnmanagedType.I4, fn.Parameters[0].MarshalAsMetadata.UnmanagedType);
    }

    [Fact]
    public void MarshalAs_LPArray_WithSizeParamIndex_OnSlice_Accept()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""sum_buf"")
func native_sum_buf(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "native_sum_buf");
        var meta = fn.Parameters[0].MarshalAsMetadata;
        Assert.Equal(UnmanagedType.LPArray, meta.UnmanagedType);
        Assert.Equal(1, meta.SizeParamIndex);
    }

    [Fact]
    public void MarshalAs_ByValArray_WithSizeConst_OnSlice_Accept()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""inline"")
func native_inline(@MarshalAs(UnmanagedType.ByValArray, SizeConst: 16) buf []uint8) void;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "native_inline");
        var meta = fn.Parameters[0].MarshalAsMetadata;
        Assert.Equal(UnmanagedType.ByValArray, meta.UnmanagedType);
        Assert.Equal(16, meta.SizeConst);
    }

    [Fact]
    public void MarshalAs_ByValTStr_WithSizeConst_OnString_Accept()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""take_str"")
func native_take_str(@MarshalAs(UnmanagedType.ByValTStr, SizeConst: 8) s string) void;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "native_take_str");
        Assert.Equal(8, fn.Parameters[0].MarshalAsMetadata.SizeConst);
    }

    [Fact]
    public void MarshalAs_SafeArray_WithSafeArraySubType_Accept()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""take_sa"")
func native_take_sa(@MarshalAs(UnmanagedType.SafeArray, SafeArraySubType: VarEnum.VT_I4) sa []int32) void;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");

        var fn = scope.Functions.Single(f => f.Name == "native_take_sa");
        Assert.Equal(VarEnum.VT_I4, fn.Parameters[0].MarshalAsMetadata.SafeArraySubType);
    }

    [Fact]
    public void MarshalAs_UnsupportedUnmanagedType_ReportsGS0357()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.CustomMarshaler) p int32) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0357");
    }

    [Fact]
    public void MarshalAs_LPWStr_OnIntParameter_ReportsGS0358()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.LPWStr) p int32) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0358");
    }

    [Fact]
    public void MarshalAs_Bool_OnInt32_ReportsGS0358()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.Bool) p int32) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0358");
    }

    [Fact]
    public void MarshalAs_ByValTStr_WithoutSizeConst_ReportsGS0359()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.ByValTStr) s string) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0359");
    }

    [Fact]
    public void MarshalAs_ByValArray_WithoutSizeConst_ReportsGS0359()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.ByValArray) buf []uint8) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0359");
    }

    [Fact]
    public void MarshalAs_LPArray_WithoutSize_ReportsGS0359()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libfoo"", EntryPoint: ""x"")
func native_x(@MarshalAs(UnmanagedType.LPArray) buf []int32) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0359");
    }

    [Fact]
    public void MarshalAs_OnLibraryImportString_ReportsGS0360()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libfoo"", EntryPoint: ""x"", StringMarshalling: StringMarshalling.Utf16)
func native_x(@MarshalAs(UnmanagedType.LPWStr) s string) void;
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0360");
    }

    [Fact]
    public void MarshalAs_OnLibraryImportNonString_IsAccepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libfoo"", EntryPoint: ""sum"")
func native_sum(
    @MarshalAs(UnmanagedType.LPArray, SizeParamIndex: 1) buf []int32,
    count int32) int64;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");
    }

    [Fact]
    public void MarshalAs_OnNonPInvokeFunction_ReportsGS0360()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

func managed(@MarshalAs(UnmanagedType.LPWStr) s string) void {
}
";
        var scope = BindSource(source);
        Assert.Contains(scope.Diagnostics, d => d.Id == "GS0360");
    }

    [Fact]
    public void MarshalAs_OnNonPInvoke_BlocksMetadataAttachment()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

func managed(@MarshalAs(UnmanagedType.LPWStr) s string) void {
}
";
        var scope = BindSource(source);
        var fn = scope.Functions.Single(f => f.Name == "managed");
        Assert.Null(fn.Parameters[0].MarshalAsMetadata);
    }

    [Fact]
    public void MarshalAs_OnDllImport_AttachesMetadata_NoSpuriousCustomAttribute()
    {
        // ADR-0096 §5: the @MarshalAs annotation is pseudo-custom — the
        // emitter must not also write a CustomAttribute row for it. The
        // binder records the metadata on the symbol; the emit-side
        // assertion (no CustomAttribute on the Param row) lives in the
        // emit tests.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""user32"", EntryPoint: ""MessageBoxW"")
func MessageBoxW(
    hWnd nint,
    @MarshalAs(UnmanagedType.LPWStr) lpText string,
    @MarshalAs(UnmanagedType.LPWStr) lpCaption string,
    uType uint32) int32;
";
        var scope = BindSource(source);
        Assert.DoesNotContain(scope.Diagnostics, d => d.Id is "GS0357" or "GS0358" or "GS0359" or "GS0360");
        var fn = scope.Functions.Single(f => f.Name == "MessageBoxW");
        Assert.NotNull(fn.Parameters[1].MarshalAsMetadata);
        Assert.NotNull(fn.Parameters[2].MarshalAsMetadata);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }
}
