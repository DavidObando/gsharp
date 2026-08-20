// <copyright file="Issue3465InferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections;
using System.Collections.Generic;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue3465InferenceTests
{
    [Fact]
    public void GenericMethod_InfersThroughImportedImplementedInterface()
    {
        var result = Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding
            import System.Collections.Generic

            func Count[T](items IReadOnlyCollection[T]) int32 {
                return items.Count
            }

            Count(Issue3465ImportedIntCollection())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void GenericMethod_InfersThroughImportedGenericBase()
    {
        var result = Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Read[T](item Issue3465ImportedGenericBase[T]) T {
                return item.Value
            }

            Read(Issue3465ImportedStringContainer())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("base", result.Value);
    }

    [Fact]
    public void GenericMethod_UsesImplementedInterfaceProjection_NotConcreteTypeArguments()
    {
        var result = Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding
            import System.Collections.Generic

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            First(Issue3465ProjectedCollection[int32]())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("projected", result.Value);
    }

    [Fact]
    public void GenericMethod_UsesBaseProjection_NotConcreteTypeArguments()
    {
        var result = Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding

            func Read[T](item Issue3465ImportedGenericBase[T]) T {
                return item.Value
            }

            Read(Issue3465ProjectedBase[int32]())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("projected-base", result.Value);
    }

    [Fact]
    public void GenericConstructor_InfersThroughImportedImplementedInterface()
    {
        var result = Evaluate("""
            import GSharp.Core.Tests.CodeAnalysis.Binding
            import System.Collections.Generic

            class Holder[T] {
                var Count int32

                init(items IReadOnlyCollection[T]) {
                    Count = items.Count
                }
            }

            Holder(Issue3465ImportedIntCollection()).Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void SourceStaticCall_ContextuallyBindsVoidBlockLambda()
    {
        var result = Evaluate("""
            class Visitor {
                shared {
                    func Visit(action (int32)->void) {
                        action(0)
                        action(7)
                    }
                }
            }

            var seen = 0
            Visitor.Visit((value int32) -> {
                if value == 0 {
                    return
                }
                seen = value
            })
            seen
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void SourceStaticOverload_UsesVoidReturnShape()
    {
        var result = Evaluate("""
            class Visitor {
                shared {
                    func Visit(action (int32)->void) {
                        action(0)
                        action(7)
                    }

                    func Visit(action (int32)->bool) {
                    }
                }
            }

            var seen = 0
            Visitor.Visit((value int32) -> {
                if value == 0 {
                    return
                }
                seen = value
            })
            seen
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void SourceStaticOverload_UsesVoidReturnShape_WithImportedParameter()
    {
        var result = Evaluate("""
            import System.Collections.Generic
            import System.Reflection.Emit

            class Visitor {
                shared {
                    func Visit(action (OperandType, int32)->void) {
                        action(OperandType.InlineI, 7)
                    }

                    func Visit(action (OperandType, int32)->bool) {
                    }
                }
            }

            let seen = HashSet[int32]()
            Visitor.Visit((operandType OperandType, token int32) -> {
                if operandType != OperandType.InlineI {
                    return
                }
                seen.Add(token)
            })
            seen.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void SourceInstanceCall_ContextuallyBindsVoidBlockLambda()
    {
        var result = Evaluate("""
            import System.Collections.Generic

            class Visitor {
                func Visit(action (int32)->void) {
                    action(0)
                    action(9)
                }
            }

            let seen = HashSet[int32]()
            Visitor().Visit((value int32) -> {
                if value == 0 {
                    return
                }
                seen.Add(value)
            })
            seen.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void SourceExtensionCall_ContextuallyBindsVoidBlockLambda()
    {
        var result = Evaluate("""
            import System.Collections.Generic

            func (visitor string) Visit(action (int32)->void) {
                action(0)
                action(11)
            }

            let seen = HashSet[int32]()
            "visitor".Visit((value int32) -> {
                if value == 0 {
                    return
                }
                seen.Add(value)
            })
            seen.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void GenericFunction_ContextuallyBindsVoidBlockLambda()
    {
        var result = Evaluate("""
            import System.Collections.Generic

            func Visit[T](value T, action (T)->void) {
                action(value)
            }

            let seen = HashSet[int32]()
            Visit(17, (value int32) -> {
                if value == 0 {
                    return
                }
                seen.Add(value)
            })
            seen.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void NestedDelegateTarget_ContextuallyBindsVoidBlockLambda()
    {
        var result = Evaluate("""
            import System
            import System.Collections.Generic

            func Accept(factory ()->Action[int32]) {
                let action = factory()
                action(0)
                action(13)
            }

            let seen = HashSet[int32]()
            Accept(() -> (value int32) -> {
                if value == 0 {
                    return
                }
                seen.Add(value)
            })
            seen.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void ValueReturningBlockLambda_KeepsValueReturnType()
    {
        var result = Evaluate("""
            class Visitor {
                shared {
                    func Visit(transform (int32)->int32) int32 {
                        return transform(4)
                    }
                }
            }

            Visitor.Visit((value int32) -> {
                if value < 0 {
                    return 0
                }
                value + 1
            })
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    [Fact]
    public void SourceStaticOverload_UsesValueReturnShape()
    {
        var result = Evaluate("""
            class Visitor {
                shared {
                    func Visit(action (int32)->void) int32 {
                        return 0
                    }

                    func Visit(action (int32)->bool) int32 {
                        return action(4) ? 1 : -1
                    }
                }
            }

            Visitor.Visit((value int32) -> {
                if value < 0 {
                    return false
                }
                return value == 4
            })
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    private static EmittedOracleResult Evaluate(string source)
    {
        return EmittedOracle.Evaluate(
            source,
            new[] { typeof(Issue3465InferenceTests).Assembly.Location });
    }
}

public sealed class Issue3465ImportedIntCollection : IReadOnlyCollection<int>
{
    private static readonly int[] Values = { 1, 2, 3 };

    public int Count => Values.Length;

    public IEnumerator<int> GetEnumerator() => ((IEnumerable<int>)Values).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public class Issue3465ImportedGenericBase<T>
{
    public T Value { get; protected init; }
}

public sealed class Issue3465ImportedStringContainer : Issue3465ImportedGenericBase<string>
{
    public Issue3465ImportedStringContainer()
    {
        Value = "base";
    }
}

public sealed class Issue3465ProjectedCollection<TMarker> : IReadOnlyCollection<string>
{
    private static readonly string[] Values = { "projected" };

    public int Count => Values.Length;

    public IEnumerator<string> GetEnumerator() => ((IEnumerable<string>)Values).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public sealed class Issue3465ProjectedBase<TMarker> : Issue3465ImportedGenericBase<string>
{
    public Issue3465ProjectedBase()
    {
        Value = "projected-base";
    }
}
