// <copyright file="Issue3785ExplicitMemberInitializerBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3785ExplicitMemberInitializerBindingTests
{
    [Fact]
    public void MembersOnly_DoesNotRequireAdd()
    {
        Assert.Empty(Bind("class Plain { var Value int32 }\nlet p = Plain(){ .Value: 1 }"));
    }

    [Theory]
    [InlineData("class Plain { var Value int32 }", ".Missing: 1", "GS0158")]
    [InlineData("class Plain { prop Value int32 { get; } }", ".Value: 1", "GS0127")]
    [InlineData("class Plain { let Value int32 = 0 }", ".Value: 1", "GS0127")]
    [InlineData("class Plain { private var Value int32 }", ".Value: 1", "GS0472")]
    [InlineData("class Plain { var Value int32 }", ".Value: 1, .Value: 2", "GS0102")]
    [InlineData("class Plain { var Value int32 }", ".Value: 1, 2", "GS0369")]
    public void ExplicitMemberErrors_DoNotFallBackToKeyedAdd(string declaration, string elements, string diagnosticId)
    {
        var diagnostics = Bind(declaration + "\nlet p = Plain(){ " + elements + " }");
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == diagnosticId);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS9998");
        if (diagnosticId != "GS0369")
        {
            Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0369" || diagnostic.Id == "GS0159");
        }
    }

    [Theory]
    [InlineData("\"bad\"")]
    [InlineData("...[]string{ \"bad\" }")]
    public void InvalidElementConversion_ReportsOrdinaryBindingErrors(string element)
    {
        var diagnostics = Bind("import System.Collections.Generic\nlet p = List[int32](){ .Capacity: 4, " + element + " }");
        Assert.Contains(diagnostics, diagnostic => diagnostic.IsError);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS0369" || diagnostic.Id == "GS9998");
    }

    [Fact]
    public void AmbiguousAdd_MatchesOrdinaryOverloadResolution()
    {
        const string declaration = """
            class Left {}
            class Right {}
            class Bag {
                var Tag int32
                func Add(value Left?) {}
                func Add(value Right?) {}
            }
            """;
        var ordinary = Bind(declaration + "\nlet b = Bag()\nb.Add(nil)");
        var initializer = Bind(declaration + "\nlet b = Bag(){ .Tag: 1, nil }");
        Assert.NotEmpty(ordinary);
        Assert.Equal(ordinary.Select(diagnostic => diagnostic.Id), initializer.Select(diagnostic => diagnostic.Id));
    }

    [Fact]
    public void LegacyObjectInitializer_RemainsUnchanged()
    {
        Assert.Empty(Bind("class Plain { var Value int32 }\nlet p = Plain(){ Value = 1 }"));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(source);
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var scope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return scope.Diagnostics.Any() ? scope.Diagnostics : Binder.BindProgram(scope).Diagnostics.ToImmutableArray();
    }
}
