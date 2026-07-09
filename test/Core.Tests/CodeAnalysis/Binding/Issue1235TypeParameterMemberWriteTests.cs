// <copyright file="Issue1235TypeParameterMemberWriteTests.cs" company="GSharp">
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
/// Issue #1235 (write side, follow-up to
/// <see cref="Issue1235TypeParameterClassMemberTests"/>): a variable whose
/// static type is a type parameter constrained to a class or a non-generic
/// user interface also exposes the constraint's settable field/property
/// surface for ASSIGNMENT (<c>t.F = v</c> / <c>t.P = v</c>), not only for
/// reads. Previously <c>ExpressionBinder.BindFieldAssignmentExpression</c>
/// only modelled a struct-symbol or interface-symbol variable receiver and
/// fell through to GS0158 "Cannot find member" for a type-parameter-typed
/// receiver — this surfaced in real-world generic factory methods such as
/// <c>where T : class, IFoo, new()</c> that build and populate a <c>T</c>
/// (Oahu migration gap: <c>BookLibrary.AddPersons&lt;TPerson&gt;</c>). The
/// companion object-initializer literal <c>T{Member: value}</c> (the
/// <c>where T : new()</c> counterpart of C#'s <c>new T { Member = value }</c>)
/// is covered at the emit layer by
/// <c>GSharp.Compiler.Tests.Emit.Issue1235TypeParameterObjectInitializerEmitTests</c>,
/// since constructing a type parameter is compiled-backend-only (issue #988).
/// </summary>
public class Issue1235TypeParameterMemberWriteTests
{
    [Fact]
    public void ClassConstraint_PropertyWrite_BindsAndReturnsValue()
    {
        var source = @"
open class Base { prop P int32 { get; set; } }

func WriteP[T Base](t T) int32 {
    t.P = 7
    return t.P
}
WriteP[Base](Base())
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void ClassConstraint_FieldWrite_BindsAndReturnsValue()
    {
        var source = @"
open class Base { var F2 int32 }

func WriteF[T Base](t T) int32 {
    t.F2 = 13
    return t.F2
}
WriteF[Base](Base())
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(13, result.Value);
    }

    [Fact]
    public void InterfaceConstraint_PropertyWrite_Binds()
    {
        // Mirrors Issue1068InterfacePropertyAccessTests.GetSetProperty_WriteThroughInterfaceReference_Binds:
        // writing through a non-generic interface reference (whether a plain
        // interface-typed variable or, as here, an interface-constrained type
        // parameter) is binder-verified but not evaluated end-to-end by the
        // tree-walking interpreter — the interpreter's property-assignment
        // evaluator only executes a concrete setter body, not a virtual
        // dispatch through an abstract interface accessor. The real setter
        // runs through the compiled backend at runtime.
        var source = @"
interface IHasName { prop Name int32 { get; set; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func WriteName[T IHasName](t T) int32 {
    t.Name = 55
    return t.Name
}
WriteName[Named](Named())
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void UnknownMemberOnTypeParameter_WriteStillReportsGS0158()
    {
        var source = @"
open class Base { var F2 int32 }

func Bad[T Base](t T) { t.Missing = 1 }
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void NewConstraintObjectInitializerLiteral_ClassConstraint_BindsWithoutDiagnostics()
    {
        // Binder-level coverage for the `T{Member: value}` object-initializer
        // literal (the `where T : new()` counterpart of C#'s
        // `new T { Member = value }`); real construction only runs through the
        // compiled backend (issue #988), so end-to-end execution is covered by
        // GSharp.Compiler.Tests.Emit.Issue1235TypeParameterObjectInitializerEmitTests.
        var source = @"
open class Base { prop P int32 { get; set; } }

func Make[T Base init()]() T { return T{P: 42} }
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void NewConstraintObjectInitializerLiteral_InterfaceConstraint_BindsWithoutDiagnostics()
    {
        var source = @"
interface IHasName { prop Name int32 { get; set; } }
open class Named : IHasName { prop Name int32 { get; set; } }

func Make[T IHasName init()]() T { return T{Name: 99} }
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void NewConstraintObjectInitializerLiteral_UnknownMember_ReportsGS0158()
    {
        var source = @"
open class Base { prop P int32 { get; set; } }

func Bad[T Base init()]() T { return T{Missing: 1} }
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0158");
    }

    [Fact]
    public void NewConstraintObjectInitializerLiteral_WithoutNewConstraint_ReportsGS0389()
    {
        var source = @"
open class Base { prop P int32 { get; set; } }

func Bad[T Base]() T { return T{P: 1} }
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0389");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
