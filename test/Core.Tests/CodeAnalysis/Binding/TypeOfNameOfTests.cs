// <copyright file="TypeOfNameOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #143: binder and evaluator coverage for the <c>typeof(T)</c> and
/// <c>nameof(expr)</c> contextual operators.
/// </summary>
public class TypeOfNameOfTests
{
    [Fact]
    public void TypeOf_Int_Resolves_To_SystemInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var t = typeof(int)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(typeof(int), vars["t"]);
    }

    [Fact]
    public void TypeOf_String_Resolves_To_SystemString()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var t = typeof(string)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(typeof(string), vars["t"]);
    }

    [Fact]
    public void TypeOf_Result_Type_Is_SystemType()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var t = typeof(int)\n"));
        var compilation = new Compilation(tree);
        Assert.Empty(compilation.GlobalScope.Diagnostics);

        var variable = FindVariable(compilation, "t");
        Assert.Equal(typeof(System.Type), variable.Type.ClrType);
    }

    [Fact]
    public void TypeOf_Slice_Of_Int_Resolves_To_Int_Array()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var t = typeof([]int)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(typeof(int[]), vars["t"]);
    }

    [Fact]
    public void TypeOf_Nullable_Int_Resolves_To_Nullable_Int32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var t = typeof(int?)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(typeof(int?), vars["t"]);
    }

    [Fact]
    public void NameOf_Local_Returns_Identifier()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var counter = 0
var n = nameof(counter)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal("counter", vars["n"]);
    }

    [Fact]
    public void NameOf_Member_Access_Returns_RightmostName()
    {
        var (eval, vars) = EvaluateWithVariables(@"
import System
var n = nameof(Console.WriteLine)
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal("WriteLine", vars["n"]);
    }

    [Fact]
    public void NameOf_Result_Type_Is_String()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var n = nameof(n)\n"));
        var compilation = new Compilation(tree);
        var variable = FindVariable(compilation, "n");
        Assert.Same(TypeSymbol.String, variable.Type);
    }

    [Fact]
    public void NameOf_Rejects_Literal_Argument()
    {
        var tree = SyntaxTree.Parse(SourceText.From("var n = nameof(123)\n"));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.GlobalScope.Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0190");
    }

    [Fact]
    public void NameOf_Rejects_Arbitrary_Call()
    {
        var tree = SyntaxTree.Parse(SourceText.From(@"
import System
var n = nameof(Console.WriteLine(""hi""))
"));
        var compilation = new Compilation(tree);
        var diagnostics = compilation.GlobalScope.Diagnostics;
        Assert.Contains(diagnostics, d => d.Id == "GS0190");
    }

    private static VariableSymbol FindVariable(Compilation compilation, string name)
    {
        foreach (var symbol in compilation.GlobalScope.Variables)
        {
            if (symbol.Name == name)
            {
                return symbol;
            }
        }

        throw new Xunit.Sdk.XunitException($"variable '{name}' not found");
    }

    private static (EvaluationResult Result, Dictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);

        var namedVars = new Dictionary<string, object>();
        foreach (var kvp in variables)
        {
            namedVars[kvp.Key.Name] = kvp.Value;
        }

        return (result, namedVars);
    }
}
