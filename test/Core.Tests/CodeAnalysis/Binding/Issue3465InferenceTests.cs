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
    public void GenericMethod_ConflictingImportedInterfaceProjections_DoNotInferArbitrarily()
    {
        foreach (var typeName in new[]
        {
            nameof(Issue3465ConflictingCollectionForward),
            nameof(Issue3465ConflictingCollectionReverse),
        })
        {
            var result = Evaluate($$"""
                import GSharp.Core.Tests.CodeAnalysis.Binding
                import System.Collections.Generic

                func Count[T](items IReadOnlyCollection[T]) int32 {
                    return items.Count
                }

                Count({{typeName}}())
                """);

            Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0151");
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
        }
    }

    [Fact]
    public void GenericMethod_RegexGroupCollectionConflict_DoesNotInferArbitrarily()
    {
        var result = Evaluate("""
            import System.Collections.Generic
            import System.Text.RegularExpressions

            func Count[T](items IReadOnlyCollection[T]) int32 {
                return items.Count
            }

            Count(Regex.Match("a", "a").Groups)
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0151");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
    }

    [Fact]
    public void GenericMethod_InfersThroughSourceGenericBase()
    {
        var result = Evaluate("""
            open class Base[T any] {}
            class Derived : Base[string] {}

            func Read[T](item Base[T]) T -> default(T)

            let value string? = Read(Derived())
            value == nil ? 1 : 0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void GenericMethod_InfersThroughTransitiveSourceInterface()
    {
        var result = Evaluate("""
            interface Root[T] {}
            interface Middle[T] : Root[T] {}
            class Leaf : Middle[int32] {}

            func Read[T](item Root[T]) T -> default(T)

            let value int32 = Read(Leaf())
            value + 1
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void GenericMethod_ConflictingSourceInterfaceProjections_DoNotInfer()
    {
        var result = Evaluate("""
            interface Root[T] {}
            interface Left : Root[int32] {}
            interface Right : Root[string] {}
            class Both : Left, Right {}

            func Read[T](item Root[T]) T -> default(T)

            Read(Both())
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0151");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
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
    public void NestedUntypedDelegateTarget_DefersUntilOuterTargetIsKnown()
    {
        var result = Evaluate("""
            import System

            func Accept(factory ()->Action[int32]) int32 {
                let action = factory()
                action(13)
                return 1
            }

            Accept(() -> (value) -> {})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void NestedUntypedDelegateTarget_FlowsThroughConditionalSwitchAndBlock()
    {
        var result = Evaluate("""
            import System

            func Accept(factory ()->Action[int32]) {
                factory()(2)
            }

            var seen = 0
            let flag = true
            Accept(() -> flag
                ? ((value) -> { seen = seen + value })
                : ((value) -> { seen = seen + 100 }))
            Accept(() -> switch flag {
                case true: (value) -> { seen = seen + value }
                default: (value) -> { seen = seen + 100 }
            })
            Accept(() -> {
                let ignored = 1
                (value) -> { seen = seen + value }
            })
            seen
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void NestedUntypedLambdaReturnShape_DisambiguatesOverloads()
    {
        var result = Evaluate("""
            import System

            func Choose(factory ()->Action[int32]) int32 -> 1
            func Choose(factory ()->Func[int32, int32]) int32 -> 2

            Choose(() -> (value) -> {})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void VoidTarget_RejectsExplicitValueReturnWithoutEmitterFailure()
    {
        var result = Evaluate("""
            func Visit(action ()->void) int32 {
                action()
                return 1
            }

            Visit(() -> { return 1 })
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0154");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
    }

    [Fact]
    public void VoidOverload_RejectsExplicitValueReturnAndSelectsValueOverload()
    {
        var result = Evaluate("""
            func Visit(action ()->void) int32 -> 1
            func Visit(action ()->int32) int32 -> action() + 1

            Visit(() -> { return 41 })
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void VoidTarget_StillDiscardsExpressionAndBlockTailValues()
    {
        var result = Evaluate("""
            func Visit(action ()->void) {
                action()
            }

            Visit(() -> 1)
            Visit(() -> { 2 })
            3
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void AsyncNoValueTarget_RejectsExplicitValueReturn(string taskType)
    {
        var result = Evaluate($$"""
            import System.Threading.Tasks

            func Visit(action ()->{{taskType}}) int32 -> 1

            Visit(async () -> { return 1 })
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0154");
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void AsyncNoValueOverload_RejectsExplicitValueReturn(string taskType)
    {
        var result = Evaluate($$"""
            import System.Threading.Tasks

            func Visit(action ()->{{taskType}}) int32 -> 1
            func Visit(action ()->Task[int32]) int32 -> 2

            Visit(async () -> { return 1 })
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void AsyncNoValueTarget_AcceptsVoidBlock(string taskType)
    {
        var result = Evaluate($$"""
            import System.Threading.Tasks

            func Visit(action ()->{{taskType}}) int32 -> 7

            Visit(async () -> {})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
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

public sealed class Issue3465ConflictingCollectionForward :
    IReadOnlyCollection<int>,
    IReadOnlyCollection<string>
{
    public int Count => 0;

    IEnumerator<int> IEnumerable<int>.GetEnumerator() => ((IEnumerable<int>)System.Array.Empty<int>()).GetEnumerator();

    IEnumerator<string> IEnumerable<string>.GetEnumerator() => ((IEnumerable<string>)System.Array.Empty<string>()).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<int>)this).GetEnumerator();
}

public sealed class Issue3465ConflictingCollectionReverse :
    IReadOnlyCollection<string>,
    IReadOnlyCollection<int>
{
    public int Count => 0;

    IEnumerator<int> IEnumerable<int>.GetEnumerator() => ((IEnumerable<int>)System.Array.Empty<int>()).GetEnumerator();

    IEnumerator<string> IEnumerable<string>.GetEnumerator() => ((IEnumerable<string>)System.Array.Empty<string>()).GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<string>)this).GetEnumerator();
}
