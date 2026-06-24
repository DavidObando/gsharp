// <copyright file="Issue1036UnsafeMethodSignatureBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1036 / ADR-0122 §1: an <c>unsafe func</c> method declared inside an
/// otherwise-<em>safe</em> type now binds its SIGNATURE (parameter + return
/// types) in an unsafe context too — not just its body — so a single unsafe
/// method may take/return unmanaged raw pointers (<c>*T</c> →
/// <see cref="PointerTypeSymbol"/>). A non-<c>unsafe</c> method's signature
/// keeps its historical managed by-ref meaning (GS0243), confirming the change
/// is gated on the per-method <c>unsafe</c> modifier.
/// </summary>
public class Issue1036UnsafeMethodSignatureBinderTests
{
    [Fact]
    public void UnsafeMethod_InSafeClass_PointerParameter_NoGS0243()
    {
        const string source = @"
package P
import System

class Safe {
    unsafe func f(p *int32) {
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void UnsafeMethod_InSafeStruct_PointerParameter_NoGS0243()
    {
        const string source = @"
package P
import System

struct Safe {
    unsafe func f(p *int32) {
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void SafeMethod_InSafeClass_PointerParameter_StillReportsGS0243()
    {
        const string source = @"
package P
import System

class Safe {
    func f(p *int32) {
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void UnsafeStaticMethod_InSafeClass_PointerParameter_NoGS0243()
    {
        const string source = @"
package P
import System

class Safe {
    shared {
        unsafe func f(p *int32) {
        }
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0243");
    }

    [Fact]
    public void UnsafeMethod_InSafeClass_ParameterIsUnmanagedPointer()
    {
        const string source = @"
package P
import System

class Safe {
    unsafe func f(p *int32) {
    }
}
";
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var type = compilation.GlobalScope.Structs.Single(s => s.Name == "Safe");
        var method = type.Methods.Single(m => m.Name == "f");
        var parameterType = method.Parameters.Single(p => p.Name == "p").Type;

        Assert.IsType<PointerTypeSymbol>(parameterType);
        Assert.Equal(TypeSymbol.Int32, ((PointerTypeSymbol)parameterType).PointeeType);
    }

    [Fact]
    public void UnsafeMethod_InSafeClass_ReturnTypeIsUnmanagedPointer()
    {
        const string source = @"
package P
import System

class Safe {
    unsafe func f(p *int32) *int32 {
        return p
    }
}
";
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var type = compilation.GlobalScope.Structs.Single(s => s.Name == "Safe");
        var method = type.Methods.Single(m => m.Name == "f");

        Assert.IsType<PointerTypeSymbol>(method.Type);
        Assert.Equal(TypeSymbol.Int32, ((PointerTypeSymbol)method.Type).PointeeType);
    }

    [Fact]
    public void SafeMethod_InSafeClass_ParameterIsManagedByRef()
    {
        const string source = @"
package P
import System

class Safe {
    func f(p *int32) {
    }
}
";
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        var type = compilation.GlobalScope.Structs.Single(s => s.Name == "Safe");
        var method = type.Methods.Single(m => m.Name == "f");
        var parameterType = method.Parameters.Single(p => p.Name == "p").Type;

        Assert.IsType<ByRefTypeSymbol>(parameterType);
    }

    [Fact]
    public void UnsafeMethod_InSafeStruct_VoidPointerParameter_NoGS0243()
    {
        const string source = @"
package P
import System

struct Safe {
    unsafe func f(p *void) {
    }
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0243");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0398");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
