// <copyright file="Issue1216ImportedGenericStaticMethodReturnTypeTests.cs" company="GSharp">
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
/// Regression tests for issue #1216: an explicit type argument on a call to an
/// imported (CLR) generic static method whose open return type <em>embeds</em>
/// the method type parameter — <c>GC.AllocateArray[T](n) → T[]</c> and
/// <c>Array.Empty[T]() → T[]</c> — must surface the SUBSTITUTED return type, not
/// the type-erased <c>object[]</c>. Before the fix the array-of-method-parameter
/// projection only recovered an in-scope <em>type parameter</em>, so a
/// same-compilation user type argument (closed with an <c>object</c> placeholder
/// in the reference load context) collapsed to <c>object[]</c> and failed to
/// convert to <c>[]Foo</c> (GS0155).
/// </summary>
public class Issue1216ImportedGenericStaticMethodReturnTypeTests
{
    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Array).Assembly.Location,
            typeof(System.GC).Assembly.Location,
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
    public void AllocateArray_With_UserStruct_TypeArg_Returns_SliceOfStruct()
    {
        var source = """
            package App
            import System

            struct Foo { var X int32 }

            func Make(n int32) []Foo {
                return GC.AllocateArray[Foo](n)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ArrayEmpty_With_UserStruct_TypeArg_Returns_SliceOfStruct()
    {
        var source = """
            package App
            import System

            struct Foo { var X int32 }

            func Empty() []Foo {
                return Array.Empty[Foo]()
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void TaskFromResult_With_UserStruct_TypeArg_Returns_TaskOfStruct()
    {
        var source = """
            package App
            import System.Threading.Tasks

            struct Foo { var X int32 }

            func R(f Foo) Task[Foo] {
                return Task.FromResult[Foo](f)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void AllocateArray_With_PrimitiveTypeArg_Still_Returns_SliceOfPrimitive()
    {
        // Regression guard: an all-BCL explicit type argument must continue to
        // bind to the substituted slice exactly as before.
        var source = """
            package App
            import System

            func Make(n int32) []int32 {
                return GC.AllocateArray[int32](n)
            }
            """;

        Assert.Empty(Bind(source));
    }
}
