// <copyright file="Issue1035FunctionPointerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1035 / ADR-0122 §9: binder coverage for managed function pointers
/// (<c>*func(T1, T2) R</c>). A function pointer is legal as a local /
/// parameter / return / field inside an <c>unsafe</c> context; <c>&amp;Method</c>
/// yields a function-pointer value type-checked against the target type; a
/// function-pointer value is directly invokable (<c>fp(args)</c>). Use outside
/// an unsafe context is rejected with GS0404, and an instance/overloaded
/// method address-of is rejected with GS0405.
/// </summary>
public class Issue1035FunctionPointerBinderTests
{
    [Fact]
    public void ManagedFunctionPointer_LocalAndCall_NoError()
    {
        const string source = @"
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    var r = fp(1, 2)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ManagedFunctionPointer_Parameter_NoError()
    {
        const string source = @"
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func apply(fp *func(int32, int32) int32, x int32, y int32) int32 {
    return fp(x, y)
}

unsafe func run() {
    var r = apply(&add, 3, 4)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ManagedFunctionPointer_VoidReturn_NoError()
    {
        const string source = @"
package P
import System

unsafe func greet() {
}

unsafe func run() {
    let fp *func() = &greet
    fp()
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void ManagedFunctionPointer_OutsideUnsafe_ReportsGS0404()
    {
        const string source = @"
package P
import System

func run() {
    let fp *func(int32) int32 = nil
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0404");
    }

    [Fact]
    public void AddressOfInstanceMethod_ReportsGS0405()
    {
        const string source = @"
package P
import System

class C {
    func m(a int32) int32 {
        return a
    }
}

unsafe func run() {
    var c = C()
    let fp *func(int32) int32 = &c.m
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0405");
    }

    [Fact]
    public void NintRoundTrip_NoError()
    {
        const string source = @"
package P
import System

unsafe func add(a int32, b int32) int32 {
    return a + b
}

unsafe func run() {
    let fp *func(int32, int32) int32 = &add
    var n = nint(fp)
}
";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
