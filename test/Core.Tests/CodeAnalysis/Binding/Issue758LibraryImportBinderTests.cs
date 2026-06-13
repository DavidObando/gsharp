// <copyright file="Issue758LibraryImportBinderTests.cs" company="GSharp">
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
/// Binder coverage for ADR-0092 / issue #758: P/Invoke functions annotated
/// with <c>@LibraryImport</c> are recognised, attached to a
/// <see cref="PInvokeMetadata"/> whose
/// <see cref="PInvokeMetadata.IsLibraryImport"/> flag is <c>true</c>, and
/// rejected when paired with the legacy <c>@DllImport</c> shape, when the
/// resolved <c>StringMarshalling</c> is invalid, when a string parameter
/// or return is used without an explicit <c>StringMarshalling</c>, or when
/// the return type is <c>string</c> (which the v1 stub generator cannot
/// safely free).
/// </summary>
public class Issue758LibraryImportBinderTests
{
    [Fact]
    public void WellFormed_LibraryImport_Marks_Function_As_PInvoke_LibraryImport()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", EntryPoint: ""strlen"", StringMarshalling: StringMarshalling.Utf8, SetLastError: true)
func MyStrLen(text string) nint;
";
        var globalScope = BindSource(source);

        var fn = globalScope.Functions.Single(f => f.Name == "MyStrLen");
        Assert.True(fn.IsPInvoke);
        Assert.NotNull(fn.PInvokeMetadata);
        Assert.True(fn.PInvokeMetadata.IsLibraryImport);
        Assert.Equal("libc", fn.PInvokeMetadata.LibraryName);
        Assert.Equal("strlen", fn.PInvokeMetadata.EntryPoint);
        Assert.Equal(System.Runtime.InteropServices.StringMarshalling.Utf8, fn.PInvokeMetadata.StringMarshalling);
        Assert.True(fn.PInvokeMetadata.SetLastError);
        Assert.DoesNotContain(GetDiagnostics(globalScope), d => d.Id is "GS0322" or "GS0342" or "GS0343" or "GS0344" or "GS0345");
    }

    [Fact]
    public void LibraryImport_Without_StringMarshalling_On_String_Param_Reports_GS0344()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"")
func MyStrLen(text string) nint;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0344");
    }

    [Fact]
    public void LibraryImport_With_Utf16_StringMarshalling_Is_Accepted()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", StringMarshalling: StringMarshalling.Utf16)
func MyWideThing(text string) nint;
";
        var globalScope = BindSource(source);
        Assert.DoesNotContain(GetDiagnostics(globalScope), d => d.Id == "GS0344");
        var fn = globalScope.Functions.Single(f => f.Name == "MyWideThing");
        Assert.Equal(System.Runtime.InteropServices.StringMarshalling.Utf16, fn.PInvokeMetadata.StringMarshalling);
    }

    [Fact]
    public void LibraryImport_With_Invalid_StringMarshalling_Reports_GS0343()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", StringMarshalling: 99)
func Foo(text string) nint;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0343");
    }

    [Fact]
    public void Mixing_DllImport_And_LibraryImport_Reports_GS0342()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
@LibraryImport(""libc"")
func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0342");
    }

    [Fact]
    public void LibraryImport_With_Body_Reports_GS0324()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"")
func Foo() int32 {
    return 0
}
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0324");
    }

    [Fact]
    public void LibraryImport_With_String_Return_Reports_GS0345()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", StringMarshalling: StringMarshalling.Utf8)
func ReturnsString() string;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0345");
    }

    [Fact]
    public void LibraryImport_With_Missing_Library_Reports_GS0322()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport
func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0322");
    }

    [Fact]
    public void LibraryImport_With_Unsupported_Parameter_Type_Reports_GS0323()
    {
        const string source = @"
package P
import System
import System.Runtime.InteropServices

@LibraryImport(""libc"")
func Foo(o Object) int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0323");
    }

    [Fact]
    public void LibraryImport_With_No_Strings_Does_Not_Require_StringMarshalling()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", EntryPoint: ""getpid"")
func MyPid() int32;
";
        var globalScope = BindSource(source);
        Assert.DoesNotContain(GetDiagnostics(globalScope), d => d.Id == "GS0344");
        var fn = globalScope.Functions.Single(f => f.Name == "MyPid");
        Assert.True(fn.IsPInvoke);
        Assert.True(fn.PInvokeMetadata.IsLibraryImport);
        Assert.Equal("getpid", fn.PInvokeMetadata.EntryPoint);
    }

    [Fact]
    public void LibraryImport_Default_EntryPoint_Falls_Back_To_Function_Name()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"")
func getpid() int32;
";
        var globalScope = BindSource(source);
        var fn = globalScope.Functions.Single(f => f.Name == "getpid");
        Assert.Equal("getpid", fn.PInvokeMetadata.EntryPoint);
    }

    [Fact]
    public void LibraryImport_With_Empty_EntryPoint_Reports_GS0329()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@LibraryImport(""libc"", EntryPoint: """")
func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0329");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetDiagnostics(BoundGlobalScope scope)
        => scope.Diagnostics;
}
