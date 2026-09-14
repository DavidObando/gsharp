// <copyright file="Issue3785ImportedParamsAddBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0180 / issue #3785 reviewer finding: the content-spread capability
/// probe (<c>HasUnaryCollectionAdd</c>'s raw-reflection
/// <c>ParameterInfo[]</c> view) counted a TRAILING <c>params</c> parameter as
/// required, so an imported CLR type whose only <c>Add</c> overload is
/// <c>Add(item, params rest[])</c> was rejected with GS0369 before overload
/// resolution ever ran, even though the overload is callable with exactly one
/// argument. Mirrors <see cref="Issue3096CollectionSpreadBindingTests"/>'s
/// diagnostics-only <c>Bind</c> style, with
/// <see cref="ImportedParamsAddCollection"/> (a plain, non-aggregate imported
/// type) forcing the raw-reflection probe rather than the semantic-aggregate
/// one.
/// </summary>
public sealed class Issue3785ImportedParamsAddBindingTests
{
    private static ReferenceResolver FixtureResolver()
        => ReferenceResolver.WithReferences(new[] { typeof(ImportedParamsAddCollection).Assembly.Location });

    [Theory]
    [InlineData("ImportedParamsAddCollection")]
    [InlineData("ImportedOptionalParamsAddCollection")]
    public void ContentSpread_ImportedTypeWithTrailingParamsAdd_BindsLikeOrdinaryCall(string target)
    {
        Assert.Empty(Bind($$"""
            import GSharp.Core.Tests.Fixtures
            let bag = {{target}}()
            bag.Add("a")
            """));

        var diagnostics = Bind($$"""
            import System.Collections.Generic
            import GSharp.Core.Tests.Fixtures

            let rows = List[string]{ "a", "b" }
            let bag = {{target}}(){ .Tag: 7, ...rows }
            """);

        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), FixtureResolver());
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        return Binder.BindProgram(globalScope, FixtureResolver()).Diagnostics.ToImmutableArray();
    }
}
