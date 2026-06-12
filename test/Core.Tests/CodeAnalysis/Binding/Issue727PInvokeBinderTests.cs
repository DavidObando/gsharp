// <copyright file="Issue727PInvokeBinderTests.cs" company="GSharp">
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
/// Binder coverage for ADR-0086 / issue #727: P/Invoke functions are
/// recognised by their <c>@DllImport</c> attribute, validated against the
/// supported marshalling table, and surfaced through
/// <see cref="FunctionSymbol.IsPInvoke"/> + <see cref="FunctionSymbol.PInvokeMetadata"/>.
/// Each negative test pins a single diagnostic from the GS0322–GS0329
/// range introduced by the ADR.
/// </summary>
public class Issue727PInvokeBinderTests
{
    [Fact]
    public void WellFormed_DllImport_Marks_Function_As_PInvoke()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"", EntryPoint: ""strlen"", CharSet: CharSet.Ansi, SetLastError: true)
func MyStrLen(text string) nint;
";
        var globalScope = BindSource(source);

        var fn = globalScope.Functions.Single(f => f.Name == "MyStrLen");
        Assert.True(fn.IsPInvoke);
        Assert.NotNull(fn.PInvokeMetadata);
        Assert.Equal("libc", fn.PInvokeMetadata.LibraryName);
        Assert.Equal("strlen", fn.PInvokeMetadata.EntryPoint);
        Assert.Equal(System.Runtime.InteropServices.CharSet.Ansi, fn.PInvokeMetadata.CharSet);
        Assert.True(fn.PInvokeMetadata.SetLastError);
        Assert.DoesNotContain(GetDiagnostics(globalScope), d => d.Id is "GS0322" or "GS0323" or "GS0324" or "GS0325" or "GS0326" or "GS0327" or "GS0328" or "GS0329");
    }

    [Fact]
    public void Function_With_Semicolon_Body_Without_DllImport_Reports_GS0325()
    {
        const string source = @"
package P

func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0325");
    }

    [Fact]
    public void DllImport_With_Body_Reports_GS0324()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func Foo() int32 {
    return 0
}
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0324");
    }

    [Fact]
    public void DllImport_With_Missing_Library_Reports_GS0322()
    {
        // No positional library name argument.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport
func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0322");
    }

    [Fact]
    public void DllImport_With_Unsupported_Parameter_Type_Reports_GS0323()
    {
        const string source = @"
package P
import System
import System.Runtime.InteropServices

@DllImport(""libc"")
func Foo(o Object) int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0323");
    }

    [Fact]
    public void DllImport_With_Unsupported_Return_Type_Reports_GS0323()
    {
        const string source = @"
package P
import System
import System.Runtime.InteropServices

@DllImport(""libc"")
func Foo() Object;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0323");
    }

    [Fact]
    public void DllImport_With_Empty_EntryPoint_Reports_GS0329()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"", EntryPoint: """")
func Foo() int32;
";
        var globalScope = BindSource(source);
        Assert.Contains(GetDiagnostics(globalScope), d => d.Id == "GS0329");
    }

    [Fact]
    public void Default_EntryPoint_Falls_Back_To_Function_Name()
    {
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func MyEntry() int32;
";
        var globalScope = BindSource(source);

        var fn = globalScope.Functions.Single(f => f.Name == "MyEntry");
        Assert.True(fn.IsPInvoke);
        Assert.Equal("MyEntry", fn.PInvokeMetadata.EntryPoint);
    }

    [Fact]
    public void Without_DllImport_Function_Is_Not_PInvoke()
    {
        const string source = @"
package P

func Foo() int32 {
    return 0
}
";
        var globalScope = BindSource(source);
        var fn = globalScope.Functions.Single(f => f.Name == "Foo");
        Assert.False(fn.IsPInvoke);
        Assert.Null(fn.PInvokeMetadata);
    }

    [Fact]
    public void DllImport_Does_Not_Emit_GS0211_Anymore()
    {
        // Regression: the old "DllImport is not supported" rejection was
        // removed by ADR-0086. Well-formed @DllImport must not produce GS0211.
        const string source = @"
package P
import System.Runtime.InteropServices

@DllImport(""libc"")
func MyEntry() int32;
";
        var globalScope = BindSource(source);
        Assert.DoesNotContain(GetDiagnostics(globalScope), d => d.Id == "GS0211");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetDiagnostics(BoundGlobalScope scope)
        => scope.Diagnostics;
}
