// <copyright file="Issue3096CollectionSpreadBindingTests.cs" company="GSharp">
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

/// <summary>Binder coverage for native array/collection spread lowering.</summary>
public sealed class Issue3096CollectionSpreadBindingTests
{
    [Fact]
    public void ArraySpread_AppliesElementConversions()
    {
        var diagnostics = Bind("""
            let source = []int32{ 2, 3 }
            let values []int64 = []int64{ int64(1), ...source, int64(4) }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void Spread_UserDefinedImplicitConversion_BindsBeforeAdd()
    {
        var program = BindProgram("""
            import System.Collections.Generic

            class Celsius {
                prop Degrees float64 { get; init; }

                init(degrees float64) {
                    Degrees = degrees
                }
            }

            func operator implicit(value Celsius) float64 {
                return value.Degrees
            }

            let source = []Celsius{
                Celsius(2.5),
                Celsius(3.5),
            }
            let array = []float64{ 1.0, ...source, 9.0 }
            let list = List[float64](){ ...source }
            """);

        Assert.Empty(program.Diagnostics);
        var conversions = new UserDefinedConversionCollector();
        conversions.Visit(program.Statement);
        Assert.Equal(2, conversions.Count);
    }

    [Fact]
    public void CollectionSpread_UsesTargetAddContract()
    {
        var diagnostics = Bind("""
            import System.Collections.Generic

            let first = []int32{ 1, 2 }
            let second = []int32{}
            let values = HashSet[int32](){ 0, ...first, ...second, 3 }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SpreadSource_MustBeEnumerable()
    {
        var diagnostics = Bind("let values = []int32{ ...42 }");

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0116");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void DictionarySpread_UsesKeyValuePairAddContract()
    {
        var diagnostics = Bind("""
            import System.Collections.Generic

            let pairs = List[KeyValuePair[string, int32]]()
            let values = Dictionary[string, int32](){ ...pairs }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void SpreadTarget_WithOnlyMultiArgumentAdd_IsRejected()
    {
        var diagnostics = Bind("""
            class PairBag {
                func Add(key string, value int32) {
                }
            }

            let pairs = [](string, int32){ ("key", 1) }
            let values = PairBag(){ ...pairs }
            """);

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0369");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Id == "GS9998");
    }

    [Fact]
    public void StaticAndInstanceFieldInitializers_Bind()
    {
        var diagnostics = Bind("""
            class Holder {
                let Instance []int32 = []int32{ 0, ...[]int32{}, 1 }

                shared {
                    let Source []string = []string{ "a", "b" }
                    let Values []string = []string{ "head", ...Source, "tail" }
                }
            }
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

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        return Binder.BindProgram(globalScope).Diagnostics.ToImmutableArray();
    }

    private static BoundProgram BindProgram(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return Binder.BindProgram(globalScope);
    }

    private sealed class UserDefinedConversionCollector : BoundTreeWalker
    {
        public int Count { get; private set; }

        public override void VisitExpression(BoundExpression node)
        {
            if (node is BoundFunctionLiteralExpression literal)
            {
                VisitStatement(literal.Body);
                return;
            }

            base.VisitExpression(node);
        }

        protected override void VisitCallExpression(BoundCallExpression node)
        {
            if (node.Function.Name == "op_Implicit")
            {
                Count++;
            }

            base.VisitCallExpression(node);
        }
    }
}
