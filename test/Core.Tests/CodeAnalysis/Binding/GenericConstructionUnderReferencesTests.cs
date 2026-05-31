// <copyright file="GenericConstructionUnderReferencesTests.cs" company="GSharp">
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
/// Regression tests for issue #310: generic type construction
/// (<c>List[int32]()</c>, <c>Dictionary[string, int32]()</c>, ...) must resolve
/// when references are supplied explicitly (the SDK <c>/r:</c> build path), which
/// loads them into an isolated <see cref="System.Reflection.MetadataLoadContext"/>.
/// <para>
/// Previously the generic-construction binding path called
/// <c>openType.MakeGenericType(clrArgs)</c> with gsc-host CLR type arguments
/// (primitives map to host <c>typeof(...)</c>) while <c>openType</c> came from
/// the MetadataLoadContext. <c>MakeGenericType</c> rejects cross-context
/// arguments, the <see cref="ArgumentException"/> was silently swallowed, and
/// binding fell through to <c>GS0130: Function 'List' doesn't exist</c>. The fix
/// projects each argument through
/// <see cref="ReferenceResolver.MapClrTypeToReferences(System.Type)"/> first.
/// </para>
/// </summary>
public class GenericConstructionUnderReferencesTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        // Supplying explicit assembly paths forces ReferenceResolver to load
        // them into an isolated MetadataLoadContext, mirroring the SDK build's
        // explicit /r: reference path.
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Collections.Generic.Dictionary<,>).Assembly.Location,
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

    [Fact]
    public void List_Construction_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var list = List[int32]()
                list.Add(1)
                Console.WriteLine(list.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Dictionary_Construction_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var counts = Dictionary[string, int32]()
                counts["one"] = 1
                Console.WriteLine(counts.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Nested_Generic_Construction_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var nested = List[List[int32]]()
                var inner = List[int32]()
                inner.Add(1)
                nested.Add(inner)
                Console.WriteLine(nested.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Dictionary_With_Generic_Value_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var counts = Dictionary[string, List[int32]]()
                Console.WriteLine(counts.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Reference_Type_Argument_Resolves_Under_Explicit_References()
    {
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var list = List[string]()
                list.Add("hello")
                Console.WriteLine(list.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Generic_Type_Clause_Variable_Resolves_Under_Explicit_References()
    {
        // Exercises the BindTypeClause generic-construction path (a typed local
        // declaration) in addition to the constructor-call path.
        var source = """
            package App
            import System
            import System.Collections.Generic

            func main() {
                var list List[int32] = List[int32]()
                list.Add(1)
                Console.WriteLine(list.Count)
            }
            """;

        Assert.Empty(Bind(source));
    }
}
