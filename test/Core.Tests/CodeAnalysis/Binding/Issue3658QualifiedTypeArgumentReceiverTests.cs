// <copyright file="Issue3658QualifiedTypeArgumentReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3658 — a constructed generic type used as a member-access receiver
/// must bind when its type argument is spelled as a <em>dotted</em> name
/// (<c>ImmutableArray[System.String].Empty</c>,
/// <c>ImmutableArray[App.Thing].Empty</c>). The reshape from index-expression
/// brackets to a type clause previously accepted only a bare identifier, so a
/// dotted argument abandoned the constructed-generic-receiver interpretation and
/// fell back to element access — reporting
/// <c>GS0125 Variable 'ImmutableArray' doesn't exist</c> plus a bogus member
/// lookup on the trailing segment. The same spelling in type position always
/// bound, which is why the defect only surfaced on the initializer side.
/// </summary>
public class Issue3658QualifiedTypeArgumentReceiverTests
{
    [Fact]
    public void ImportedGenericReceiver_WithQualifiedTypeArgument_Binds()
    {
        var source = """
            package App
            import System.Collections.Immutable

            class Thing {
            }

            class Holder {
                private var items ImmutableArray[App.Thing] = ImmutableArray[App.Thing].Empty
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedGenericReceiver_WithFrameworkQualifiedTypeArgument_Binds()
    {
        var source = """
            package App
            import System.Collections.Immutable

            class Holder {
                private var names ImmutableArray[System.String] = ImmutableArray[System.String].Empty
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedGenericReceiver_WithDeepQualifiedTypeArgument_Binds()
    {
        // Three or more segments nest to the *right* in expression position
        // (`System.(Text.StringBuilder)`), unlike the two-segment case, so the
        // flattening walk has to handle both leanings.
        var source = """
            package App
            import System.Collections.Immutable

            class Holder {
                private var builders ImmutableArray[System.Text.StringBuilder] = ImmutableArray[System.Text.StringBuilder].Empty
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FullyQualifiedGenericReceiver_WithQualifiedTypeArgument_Binds()
    {
        var source = """
            package App

            class Thing {
            }

            class Holder {
                private var items System.Collections.Immutable.ImmutableArray[App.Thing] =
                    System.Collections.Immutable.ImmutableArray[App.Thing].Empty
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UserGenericReceiver_WithNestedTypeArgument_Binds()
    {
        var source = """
            package App

            class Outer {
                class Inner {
                }
            }

            class Box[T] {
                shared {
                    let Default int32 = 0
                }
            }

            func F() int32 {
                return Box[Outer.Inner].Default
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void GenuineIndexing_WithQualifiedIndexExpression_StillBindsAsElementAccess()
    {
        // The dotted-name reshape must not steal genuine indexing: `values` is a
        // value in scope, so `values[Keys.First]` remains element access.
        var source = """
            package App
            import System.Collections.Generic

            class Keys {
                shared {
                    let First int32 = 0
                }
            }

            func F() string {
                var values = List[string]()
                values.Add("a")
                return values[Keys.First]
            }
            """;

        Assert.Empty(Bind(source));
    }

    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(ImmutableArray<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }
}
