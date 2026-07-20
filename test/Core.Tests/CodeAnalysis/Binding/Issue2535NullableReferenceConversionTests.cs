// <copyright file="Issue2535NullableReferenceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2535: class-to-interface conversion must honor the same safe
/// declaration-site variance as an already interface-typed value.
/// </summary>
public sealed class Issue2535NullableReferenceConversionTests
{
    [Fact]
    public void CovariantImplementedInterfaceLiftsThroughReferenceNullability()
    {
        var result = Evaluate("""
            interface IService[out T] {}
            class Service : IService[object] {}

            func InterfaceControl(value IService[object]) IService[object?]? -> value
            func Lift(value Service) IService[object?]? -> value
            func NullableLift(value Service?) IService[object?]? -> value
            func AssertedLift(value Service?) IService[object?] -> value!!
            func FlowLift(value object?) IService[object?]? {
                if value is Service {
                    return value
                }
                return nil
            }
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void NullableReferenceCannotFlowToNonNullableOrUnrelatedTarget()
    {
        var result = Evaluate("""
            interface IService {}
            class Service : IService {}
            class Other {}
            interface IInvariant[T] {}
            class InvariantService : IInvariant[object] {}

            func DropsNull(value Service?) IService -> value
            func Unrelated(value Other) IService? -> value
            func InvariantWiden(value InvariantService) IInvariant[object?]? -> value
            """);

        Assert.Contains(result.Diagnostics, d => d.Id is "GS0155" or "GS0156");
        Assert.Equal(3, result.Diagnostics.Count());
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(tree) { IsLibrary = true };
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
