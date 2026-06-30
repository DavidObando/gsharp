// <copyright file="NamedDelegateBindingTests.cs" company="GSharp">
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
/// ADR-0059 / issue #255: binder tests for named delegate type declarations.
/// </summary>
public class NamedDelegateBindingTests
{
    [Fact]
    public void DeclareAndUse_NamedDelegate_Binds_Without_Diagnostics()
    {
        var source = @"
package P
import System

type Combine = delegate func(a int32, b int32) int32

var sum Combine = func(a int32, b int32) int32 {
    return a + b
}

Console.WriteLine(sum.Invoke(2, 40))
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GenericDelegate_Binds_Without_Diagnostics()
    {
        // Issue #1503: a generic named delegate declaration now binds without
        // diagnostics (GS0234 retired). Single and multi type-parameter shapes,
        // and a type parameter used in a composite return type, all bind.
        var source = @"
package P

type Box[T any] = delegate func(value T) T
type Converter[TIn any, TOut any] = delegate func(x TIn) TOut
type Mapper[T any] = delegate func(items []T) []T
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0234");
    }

    [Fact]
    public void GenericDelegate_Construct_And_Use_Binds_Without_Diagnostics()
    {
        // Issue #1503: a generic delegate constructed over a concrete type
        // argument binds as a parameter/local type and is assignable from a
        // matching func literal.
        var source = @"
package P
import System

type Predicate1503[T any] = delegate func(value T) bool

var isPositive Predicate1503[int32] = func(value int32) bool {
    return value > 0
}

Console.WriteLine(isPositive.Invoke(7))
";
        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void DelegateDeclaration_Without_Func_Reports_GS0233()
    {
        var source = @"
package P

type Bad = delegate int32
";
        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0233");
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}

