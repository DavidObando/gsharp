// <copyright file="VisibilityModifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Phase 2.8: explicit <c>public</c> / <c>internal</c> / <c>private</c>
/// modifiers on top-level <c>func</c>, <c>type</c>, <c>var</c>, <c>let</c>,
/// and <c>const</c> declarations. Default for top-level is <c>public</c>
/// per ADR-0014.
/// </summary>
public class VisibilityModifierTests
{
    [Fact]
    public void PublicFunc_Binds_AsPublic()
    {
        var (diagnostics, scope) = BindWithScope("public func F() { var x = 1 }\n");
        Assert.Empty(diagnostics);
        Assert.Equal(Accessibility.Public, FindFunction(scope, "F").Accessibility);
    }

    [Fact]
    public void InternalFunc_Binds_AsInternal()
    {
        var (diagnostics, scope) = BindWithScope("internal func F() { var x = 1 }\n");
        Assert.Empty(diagnostics);
        Assert.Equal(Accessibility.Internal, FindFunction(scope, "F").Accessibility);
    }

    [Fact]
    public void PrivateFunc_Binds_AsPrivate()
    {
        var (diagnostics, scope) = BindWithScope("private func F() { var x = 1 }\n");
        Assert.Empty(diagnostics);
        Assert.Equal(Accessibility.Private, FindFunction(scope, "F").Accessibility);
    }

    [Fact]
    public void Func_WithoutModifier_DefaultsToPublic()
    {
        var (diagnostics, scope) = BindWithScope("func F() { var x = 1 }\n");
        Assert.Empty(diagnostics);
        Assert.Equal(Accessibility.Public, FindFunction(scope, "F").Accessibility);
    }

    [Fact]
    public void PublicTypeAlias_Binds()
    {
        var (diagnostics, _) = BindWithScope("public type UserId = int\nfunc F() { var x UserId = 1 }\n");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InternalGlobalVar_Binds()
    {
        var (diagnostics, scope) = BindWithScope("internal var counter = 0\n");
        Assert.Empty(diagnostics);
        var counter = scope.Variables.Single(v => v.Name == "counter");
        Assert.Equal(Accessibility.Internal, ((GlobalVariableSymbol)counter).Accessibility);
    }

    [Fact]
    public void PrivateGlobalLet_Binds()
    {
        var (diagnostics, scope) = BindWithScope("private let secret = 42\n");
        Assert.Empty(diagnostics);
        var secret = scope.Variables.Single(v => v.Name == "secret");
        Assert.Equal(Accessibility.Private, ((GlobalVariableSymbol)secret).Accessibility);
    }

    [Fact]
    public void ModifierBeforeNonDeclaration_ReportsError()
    {
        // `public 1 + 1` is not a valid declaration site.
        var diagnostics = Bind("public\n1 + 1\n");
        Assert.Contains(diagnostics, d => d.Message.Contains("not allowed", System.StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ModifierInsideFunctionBody_ReportsError()
    {
        // Local variable declarations don't accept modifiers; treating `public` as a
        // keyword should surface a parse-time diagnostic.
        var diagnostics = Bind("func F() { public var x = 1 }\n");
        Assert.NotEmpty(diagnostics);
    }

    private static FunctionSymbol FindFunction(BoundGlobalScope scope, string name)
        => scope.Functions.Single(f => f.Name == name);

    private static (ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Diagnostics, BoundGlobalScope Scope) BindWithScope(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return (tree.Diagnostics, null);
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return (globalScope.Diagnostics, globalScope);
        }

        var program = Binder.BindProgram(globalScope);
        return (program.Diagnostics.ToImmutableArray(), globalScope);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
        => BindWithScope(source).Diagnostics;
}
