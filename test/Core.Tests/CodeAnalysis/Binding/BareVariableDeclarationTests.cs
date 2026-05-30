// <copyright file="BareVariableDeclarationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Tests for `var` declarations that omit their initializer (e.g. `var x int32`).
/// Such declarations are valid when an explicit type clause is present and take
/// the type's default (zero) value. `let`/`const` remain initializer-required.
/// </summary>
public class BareVariableDeclarationTests
{
    [Fact]
    public void BareVarDeclaration_Int32_DefaultsToZero()
    {
        var source = @"
var x int32
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void BareVarDeclaration_Bool_DefaultsToFalse()
    {
        var source = @"
var b bool
b
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    [Fact]
    public void BareVarDeclaration_String_DefaultsToEmpty()
    {
        var source = @"
var s string
s
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(string.Empty, result.Value);
    }

    [Fact]
    public void BareVarDeclaration_ThenAssignment_UsesAssignedValue()
    {
        var source = @"
var x int32
x = 42
x
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BareLetDeclaration_WithoutInitializer_ReportsDiagnostic()
    {
        var source = @"
let x int32
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void BareConstDeclaration_WithoutInitializer_ReportsDiagnostic()
    {
        var source = @"
const x int32
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    [Fact]
    public void BareVarDeclaration_WithoutTypeClause_ReportsDiagnostic()
    {
        var source = @"
var x
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
