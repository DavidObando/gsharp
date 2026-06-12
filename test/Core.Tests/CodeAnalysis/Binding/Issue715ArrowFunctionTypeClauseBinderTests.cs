// <copyright file="Issue715ArrowFunctionTypeClauseBinderTests.cs" company="GSharp">
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
/// Issue #715 / ADR-0075 — binder/diagnostic behaviour for the canonical
/// arrow-form function-type clause <c>(T) -&gt; R</c>: both spellings produce
/// identical function-type symbols, lambdas and method groups assign to
/// either form, and the legacy <c>func(T) R</c> spelling emits exactly one
/// GS0303 warning per occurrence.
/// </summary>
public class Issue715ArrowFunctionTypeClauseBinderTests
{
    [Fact]
    public void ArrowAndLegacyForms_ProduceIdentical_FunctionType_Symbol_Identity()
    {
        // Two locals with the same shape, spelled the two different ways:
        // assigning between them must succeed (no conversion diagnostic),
        // which proves they bind to the same FunctionTypeSymbol.
        var result = Evaluate(@"
let add = func(a int32, b int32) int32 { return a + b }
let f1 (int32, int32) -> int32 = add
let f2 func(int32, int32) int32 = f1
f2(20, 22)
");
        Assert.Equal(42, result.Value);
        // The only diagnostic should be the one GS0303 for the legacy
        // `func(int32, int32) int32` spelling on the `f2` declaration.
        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.Empty(errors);
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Single(warnings);
    }

    [Fact]
    public void Lambda_AssignableTo_ArrowForm_FunctionTypeClause()
    {
        var result = Evaluate(@"
let inc (int32) -> int32 = (x int32) -> x + 1
inc(41)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void Lambda_AssignableTo_LegacyForm_FunctionTypeClause()
    {
        // The legacy spelling stays valid for one release; the only diff
        // is the GS0303 warning.
        var result = Evaluate(@"
let inc func(int32) int32 = (x int32) -> x + 1
inc(41)
");
        Assert.Equal(42, result.Value);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Single(result.Diagnostics.Where(d => d.Id == "GS0303"));
    }

    [Fact]
    public void MethodGroup_AssignableTo_ArrowForm_FunctionTypeClause()
    {
        var result = Evaluate(@"
func twice(x int32) int32 { return x * 2 }
let g (int32) -> int32 = twice
g(21)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ArrowAndLegacyForms_AreAssignmentCompatible_BothDirections()
    {
        var result = Evaluate(@"
let add = func(a int32, b int32) int32 { return a + b }
let arrowSlot (int32, int32) -> int32 = add
let legacySlot func(int32, int32) int32 = arrowSlot
let arrowSlot2 (int32, int32) -> int32 = legacySlot
arrowSlot2(40, 2)
");
        Assert.Equal(42, result.Value);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        // Exactly one GS0303 — for the single legacy spelling.
        Assert.Single(result.Diagnostics.Where(d => d.Id == "GS0303"));
    }

    [Fact]
    public void Async_ArrowForm_LowersTo_TaskReturningFunctionType()
    {
        // `async (T) -> R` must lower to `(T) -> Task[R]`, matching the
        // legacy `async func(T) R` lowering. The two spellings produce the
        // same FunctionTypeSymbol — so assigning a value from one to the
        // other binds without a conversion diagnostic.
        var result = Evaluate(@"
let arrowAsync async (int32) -> int32 = async func(x int32) int32 { return x + 100 }
let legacyAsync async func(int32) int32 = arrowAsync
1
");
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Single(result.Diagnostics.Where(d => d.Id == "GS0303"));
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void GS0303_FiresOncePerOccurrence_OfLegacyFuncFormInTypeClause()
    {
        var result = Evaluate(@"
let f func(int32) int32 = (x int32) -> x
let g (int32) -> int32 = (x int32) -> x
let h func(int32) int32 = (x int32) -> x
let i func(int32) int32 = (x int32) -> x
f(0) + g(0) + h(0) + i(0)
");
        var warnings = result.Diagnostics.Where(d => d.Id == "GS0303").ToList();
        Assert.Equal(3, warnings.Count);
        Assert.All(warnings, w => Assert.False(w.IsError));
    }

    [Fact]
    public void Arrow_Form_TypeName_Renders_Arrow_Spelling()
    {
        // FunctionTypeSymbol's display name is now `(T1, T2) -> R` — verify
        // by triggering a type-mismatch and matching the message.
        var source = @"
let f (int32) -> int32 = ""not a function""
";
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        var diagnostics = compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;

        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("(int32) -> int32"));
    }

    [Fact]
    public void TupleReturn_ArrowForm_BindsToTupleType()
    {
        var result = Evaluate(@"
func split(s string) (string, int32) { return (s, s.Length) }
let splitter (string) -> (string, int32) = split
let t = splitter(""hello"")
t.Item2
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void VoidReturn_ArrowForm_AcceptsVoidReturningLambda()
    {
        var result = Evaluate(@"
let count = 0
let greet () -> void = () -> { }
greet()
1
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
