// <copyright file="Issue948FieldInitializerBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #948: binder tests for inline `const`/`let`/`var` field initializers in
/// a type body — constant folding for `const`, and the constraints that a
/// `const` field needs a constant initializer and that an instance initializer
/// cannot reference instance members or constructor parameters.
/// </summary>
public class Issue948FieldInitializerBindingTests
{
    [Fact]
    public void ConstField_WithConstantInitializer_NoDiagnostics()
    {
        const string source = "package P\nclass K {\n  const Max int32 = 5 * 10\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0375" || d.Id == "GS0376");
    }

    [Fact]
    public void ConstField_WithoutInitializer_ReportsGS0375()
    {
        const string source = "package P\nclass K {\n  const Max int32\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0375");
    }

    [Fact]
    public void ConstField_WithNonConstantInitializer_ReportsGS0376()
    {
        const string source = "package P\nclass K {\n  const Len int32 = \"abc\".Length\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0376");
    }

    [Fact]
    public void InstanceInitializer_ReferencingInstanceMember_ReportsGS0377()
    {
        const string source = "package P\nclass Foo {\n  var a int32 = 5\n  var b int32 = a + 10\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void InstanceInitializer_ReferencingThis_ReportsGS0377()
    {
        const string source = "package P\nclass Foo {\n  var a int32 = 5\n  var b int32 = this.a\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0377");
    }

    [Fact]
    public void InstanceInitializer_WithConstantExpression_NoGS0377()
    {
        const string source = "package P\nclass Foo {\n  var a int32 = 5\n  var b int32 = 10\n}\n";
        var diagnostics = GetDiagnostics(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0377");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }
}
