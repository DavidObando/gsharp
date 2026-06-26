// <copyright file="Issue1203SharedExternBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0086 / issue #1203: a bodyless function inside a class's
/// <c>shared { }</c> static block is the canonical G# spelling of a C#
/// <c>static extern [DllImport]</c> member. Previously the static-member path
/// dereferenced the null <c>Declaration.Body</c> and crashed the compiler with
/// a GS9998 NullReferenceException. These tests pin that a static
/// <c>@DllImport</c> extern now binds as a P/Invoke and that a bodyless static
/// method without <c>@DllImport</c> reports GS0325 instead of crashing.
/// </summary>
public class Issue1203SharedExternBinderTests
{
    [Fact]
    public void StaticDllImportExtern_BindsAsPInvoke()
    {
        const string source = @"
package p
import System.Runtime.InteropServices

class C {
    shared {
        @DllImport(""kernel32"", SetLastError: true)
        func ReadFile(handle System.IntPtr, n int32) bool;
    }
}
";
        var globalScope = BindSource(source);
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "ReadFile");

        Assert.True(method.IsPInvoke);
        Assert.NotNull(method.PInvokeMetadata);
        Assert.Equal("kernel32", method.PInvokeMetadata.LibraryName);
        Assert.True(method.PInvokeMetadata.SetLastError);
    }

    [Fact]
    public void BodylessStaticFunc_WithoutDllImport_ReportsGS0325_DoesNotCrash()
    {
        const string source = @"
package p
class C {
    shared {
        func F(x int32) bool;
    }
}
";
        var diagnostics = GetEmitDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0325");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void StaticDllImportExtern_DoesNotCrash_NoGS9998()
    {
        const string source = @"
package p
import System.Runtime.InteropServices

class C {
    shared {
        @DllImport(""kernel32"")
        func GetTickCount() int32;
    }
}
";
        var diagnostics = GetEmitDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0325");
    }

    [Fact]
    public void StaticDllImportExtern_InUnsafeClass_WithPointerParams_Binds()
    {
        const string source = @"
package p
import System.Runtime.InteropServices

unsafe class C {
    shared {
        @DllImport(""kernel32"", SetLastError: true)
        func ReadFile(handle System.IntPtr, pBuffer *void, n int32, pRead *int32, ov int32) bool;
    }
}
";
        var diagnostics = GetEmitDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static IEnumerable<Diagnostic> GetEmitDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
