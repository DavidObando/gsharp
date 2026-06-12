// <copyright file="ExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 6.3 exhaustiveness diagnostics for enum and sealed-interface switches.
/// </summary>
public class ExhaustivenessTests
{
    [Fact]
    public void SwitchExpression_Enum_AllMembersCovered_HasNoDiagnostic()
    {
        var diagnostics = Bind(@"
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: ""red"" case Color.Green: ""green"" case Color.Blue: ""blue"" }
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_Enum_MissingMember_DiagnosesMissingName()
    {
        var diagnostics = Bind(@"
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: ""red"" case Color.Green: ""green"" }
");

        Assert.Contains(diagnostics, d => d.Message == "Switch expression on enum 'Color' is not exhaustive: missing 'Blue'.");
    }

    [Fact]
    public void SwitchExpression_Enum_DefaultArm_HasNoDiagnostic()
    {
        var diagnostics = Bind(@"
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: ""red"" default: ""other"" }
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_Enum_DiscardArm_HasNoDiagnostic()
    {
        var diagnostics = Bind(@"
enum Color { Red, Green, Blue }
let color = Color.Red
let label = switch color { case Color.Red: ""red"" case _: ""other"" }
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_SealedInterface_AllImplementorsCovered_HasNoDiagnostic()
    {
        var diagnostics = Bind(@"
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: ""add"" case x is Mul: ""mul"" }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_SealedInterface_MissingImplementor_DiagnosesMissingName()
    {
        var diagnostics = Bind(@"
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: ""add"" }
}
");

        Assert.Contains(diagnostics, d => d.Message == "Switch expression on sealed interface 'Expr' is not exhaustive: missing 'Mul'.");
    }

    [Fact]
    public void SwitchExpression_SealedInterface_DefaultArm_HasNoDiagnostic()
    {
        var diagnostics = Bind(@"
sealed interface Expr { }
class Add : Expr { }
class Mul : Expr { }
func Label(expr Expr) string {
 return switch expr { case x is Add: ""add"" default: ""other"" }
}
");

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SwitchExpression_IntDiscriminant_MissingDefault_UsesExistingDiagnostic()
    {
        var diagnostics = Bind(@"
let value = 1
let label = switch value { case 1: ""one"" }
");

        Assert.Contains(diagnostics, d => d.Message == "Switch expression must have a 'default' arm.");
        Assert.DoesNotContain(diagnostics, d => d.Message.Contains("not exhaustive", System.StringComparison.Ordinal));
    }

    [Fact]
    public void SwitchStatement_Enum_MissingMember_DiagnosesStatementForm()
    {
        var diagnostics = Bind(@"
enum Color { Red, Green, Blue }
var label = """"
switch Color.Red { case Color.Red { label = ""red"" } case Color.Green { label = ""green"" } }
");

        Assert.Contains(diagnostics, d => d.Message == "Switch statement on enum 'Color' is not exhaustive: missing 'Blue'.");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        var diagnostics = globalScope.Diagnostics.ToBuilder();
        var program = Binder.BindProgram(globalScope);
        diagnostics.AddRange(program.Diagnostics);
        return diagnostics.ToImmutable();
    }
}
