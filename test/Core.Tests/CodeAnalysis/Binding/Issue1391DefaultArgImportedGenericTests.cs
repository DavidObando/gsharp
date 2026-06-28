// <copyright file="Issue1391DefaultArgImportedGenericTests.cs" company="GSharp">
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
/// Regression tests for issue #1391: passing the untyped <c>default</c> literal
/// as an argument to an IMPORTED (CLR) generic method invoked with an explicit
/// type argument — e.g. <c>Task.FromResult[int32](default)</c> — must bind. The
/// bare <c>default</c> is bound with the <see cref="TypeSymbol.Error"/> sentinel
/// type until a target is known, and the imported overload-resolution path
/// previously discarded the candidate (no effective CLR type for the argument),
/// reporting GS0159 "Cannot find function". The user-defined generic method path
/// already accepted <c>default</c>, so the defect was specific to applicability
/// of imported generic methods against an untyped <c>default</c> argument.
/// </summary>
public class Issue1391DefaultArgImportedGenericTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Array).Assembly.Location,
            typeof(System.Threading.Tasks.Task).Assembly.Location,
            typeof(System.Console).Assembly.Location,
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
    public void TaskFromResult_With_PrimitiveTypeArg_And_DefaultArg_Binds()
    {
        var source = """
            package p
            import System.Threading.Tasks

            class C { func A() Task[int32] -> Task.FromResult[int32](default) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void TaskFromResult_With_TypeParameterTypeArg_And_DefaultArg_Binds()
    {
        // The real-world shape: an in-scope generic type parameter as the
        // explicit type argument, with a bare `default` argument.
        var source = """
            package p
            import System.Threading.Tasks

            class Box[T] { func Make() Task[T?] -> Task.FromResult[T](default) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void TaskFromResult_With_ReferenceTypeArg_And_DefaultArg_Binds()
    {
        var source = """
            package p
            import System.Threading.Tasks

            class C { func A() Task[string] -> Task.FromResult[string](default) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void TaskFromResult_With_PrimitiveTypeArg_And_ConcreteArg_StillBinds()
    {
        // Regression guard: a concrete value argument must continue to bind.
        var source = """
            package p
            import System.Threading.Tasks

            class C { func A() Task[int32] -> Task.FromResult[int32](0) }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UserGenericMethod_With_DefaultArg_StillBinds()
    {
        // Control: the user-defined generic method path that already accepted
        // `default` must remain unaffected.
        var source = """
            package p

            class Box { shared { func Wrap[T](v T) T -> v } }
            class C { func A() int32 -> Box.Wrap[int32](default) }
            """;

        Assert.Empty(Bind(source));
    }
}
