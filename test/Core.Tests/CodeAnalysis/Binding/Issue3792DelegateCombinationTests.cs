// <copyright file="Issue3792DelegateCombinationTests.cs" company="GSharp">
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

/// <summary>Issue #3792: delegate combination outside event subscription sites.</summary>
public class Issue3792DelegateCombinationTests
{
    [Theory]
    [InlineData("Action")]
    [InlineData("(() -> void)")]
    [InlineData("Handler")]
    public void DelegateBinaryAndCompoundOperators_Bind(string delegateType)
    {
        var declaration = delegateType == "Handler" ? "delegate Handler();\n" : string.Empty;
        var source = $$"""
            package P
            import System

            {{declaration}}
            func Tick() {}

            class Box {
                var Field {{delegateType}}? = nil
                prop Property {{delegateType}}? { get; set; }

                func Update(value {{delegateType}}) {
                    Field += value
                    Property += value
                    Field -= value
                    Property -= value
                }
            }

            func Run() {
                let value {{delegateType}} = Tick
                let sum = value + value
                let removed = sum - value
                let leftNil = nil + value
                let rightNil = value + nil
                var local {{delegateType}}? = nil
                local += value
                local += nil
                local -= nil
                local -= value
                let box = Box()
                box.Update(value)
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DelegateOperators_DoNotBroadenToDelegateBaseOrDifferentNamedTypes()
    {
        const string source = """
            package P
            import System

            delegate First();
            delegate Second();

            func Run(
                a Delegate,
                b Delegate,
                first First,
                second Second,
                objects Action[object],
                strings Action[string]) {
                let badBase = a + b
                let badNamed = first - second
                let badVariant = objects + strings
            }
            """;

        var diagnostics = Bind(source);
        Assert.Equal(3, diagnostics.Count(d => d.Id == "GS0129"));
    }

    [Fact]
    public void DelegateOperators_TargetTypeSourceAndClrMethodGroups()
    {
        const string source = """
            package P
            import System

            func Print(value string) {}
            func Print(value int32) {}

            func Run() {
                let seed Action[string] = (value string) -> {}
                let source = seed + Print
                let clr = seed + Console.WriteLine
                var callbacks Action[string]? = seed
                callbacks += Print
                callbacks += Console.WriteLine
                callbacks -= Print
                callbacks -= Console.WriteLine
            }
            """;

        Assert.Empty(Bind(source));
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

        return Binder.BindProgram(globalScope).Diagnostics.ToImmutableArray();
    }
}
