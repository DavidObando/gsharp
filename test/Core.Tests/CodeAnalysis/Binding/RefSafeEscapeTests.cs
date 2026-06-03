// <copyright file="RefSafeEscapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0058 / issue #376: ref-safe-to-escape analysis tests.
/// Covers GS9004 (ByRef escape), GS9006 (ByRef field type), and the
/// <c>scoped</c> parameter modifier with GS0219 ref-struct return escape.
/// </summary>
public class RefSafeEscapeTests
{
    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be returned from a function
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_Return_FromFunction_Reports_GS9004()
    {
        // A function whose return type is *int32 cannot be declared or used —
        // returning a managed pointer would expose a dangling reference to a
        // callee stack frame.
        var source = @"
func getRef() *int32 {
    var x = 42
    return &x
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void ByRef_Return_InLambda_Reports_GS9004()
    {
        // A lambda that returns *T is also rejected — a lambda captured by a
        // closure can outlive the pointed-to variable.
        var source = @"
var x = 1
var f = func() *int32 { return &x }
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void ByRef_ReturnVoid_IsLegal()
    {
        // Using &x to call a ref/out API is fine; the pointer does not escape.
        var source = @"
import System
var result = 0
var ok = Int32.TryParse(""99"", &result)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9004");
    }

    // -----------------------------------------------------------------------
    // GS9004: managed pointer (*T) cannot be captured in a closure
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_CapturedInClosure_Reports_GS9004()
    {
        // Closing over a *T local is rejected — the closure can outlive the
        // stack frame that owns the pointed-to variable.
        var source = @"
package P
func test() {
    var x = 10
    var p = &x
    var f = func() { var y = *p }
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9004");
    }

    [Fact]
    public void NonPointer_CapturedInClosure_IsLegal()
    {
        var source = @"
package P
func test() {
    var x = 10
    var f = func() { var y = x }
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9004");
    }

    // -----------------------------------------------------------------------
    // GS9006: managed pointer (*T) cannot be a field type
    // -----------------------------------------------------------------------

    [Fact]
    public void ByRef_AsStructField_Reports_GS9006()
    {
        var source = @"
package P
type S struct {
    Ptr *int32
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void ByRef_AsClassField_Reports_GS9006()
    {
        var source = @"
package P
type C class {
    var Ptr *int32
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS9006");
    }

    [Fact]
    public void PlainIntField_InStruct_IsLegal()
    {
        var source = @"
package P
type S struct {
    Value int32
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9006");
    }

    // -----------------------------------------------------------------------
    // scoped modifier: parsing and ParameterSymbol.IsScoped
    // -----------------------------------------------------------------------

    [Fact]
    public void Scoped_Parameter_ParsesWithoutError()
    {
        var source = @"
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError && d.Id != "GS9004" && d.Id != "GS9006");
    }

    [Fact]
    public void Scoped_Parameter_IsScoped_True()
    {
        var source = @"
import System
func f(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);

        var func = program.Functions.Keys.FirstOrDefault(f => f.Name == "f");
        Assert.NotNull(func);
        var param = func.Parameters.FirstOrDefault(p => p.Name == "s");
        Assert.NotNull(param);
        Assert.True(param.IsScoped);
    }

    [Fact]
    public void NonScoped_Parameter_IsScoped_False()
    {
        var source = @"
import System
func f(s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);

        var func = program.Functions.Keys.FirstOrDefault(f => f.Name == "f");
        Assert.NotNull(func);
        var param = func.Parameters.FirstOrDefault(p => p.Name == "s");
        Assert.NotNull(param);
        Assert.False(param.IsScoped);
    }

    [Fact]
    public void Scoped_UsableAsIdentifier_WhenNotFollowedByIdentifier()
    {
        // `scoped` used as a plain variable name (not followed by another
        // identifier) must remain a valid identifier, not be consumed as a
        // modifier.
        var source = @"
var scoped = 42
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.DoesNotContain(tree.Diagnostics, d => d.IsError);
    }

    // -----------------------------------------------------------------------
    // scoped + ref struct: returning a scoped ref struct parameter (GS0219)
    // -----------------------------------------------------------------------

    [Fact]
    public void ScopedRefStructParam_Returned_Reports_GS0219()
    {
        // A `scoped` ref struct parameter has safe-to-escape = function-local;
        // it must not be returned.
        var source = @"
import System
func bad(scoped s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void NonScopedRefStructParam_Returned_IsLegal()
    {
        // Without `scoped`, the parameter's STE is caller scope — returning is
        // legal (same as C#'s default for ref struct parameters).
        var source = @"
import System
func passThrough(s ReadOnlySpan[int32]) ReadOnlySpan[int32] {
    return s
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedRefStructParam_MemberAccess_IsLegal()
    {
        // Using a member of a `scoped` ref struct parameter (not returning
        // the ref struct itself) is fine.
        var source = @"
import System
func length(scoped s ReadOnlySpan[int32]) int32 {
    return s.Length
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void ScopedPlainParam_NotRefStruct_NoGS0219()
    {
        // `scoped` on a non-ref-struct parameter does not produce GS0219
        // (the restriction only applies when returning a ref struct value).
        var source = @"
package P
func f(scoped x int32) int32 {
    return x
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_ScopedRefStruct_Returned_Reports_GS0219()
    {
        var source = @"
package P
type Acc ref struct {
    Total int32
}
func bad(scoped a Acc) Acc {
    return a
}
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0219");
    }

    [Fact]
    public void UserDeclared_NonScopedRefStruct_Returned_IsLegal()
    {
        var source = @"
package P
type Acc ref struct {
    Total int32
}
func passThrough(a Acc) Acc {
    return a
}
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0219");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
