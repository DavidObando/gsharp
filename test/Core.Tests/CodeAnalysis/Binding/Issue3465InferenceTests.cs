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
    public void GenericMethod_InfersThroughSourceImplementedClrInterface()
    {
        var result = Evaluate("""
            import System.Collections
            import System.Collections.Generic

            class Repo[T] : IEnumerable[T] {
                private let items List[T] = List[T]()

                init(value T) {
                    items.Add(value)
                }

                func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
            }

            func First[T](items IEnumerable[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            First(items: (Repo[int32](23)))
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(23, result.Value);
    }

    [Fact]
    public void SequenceInference_InfersThroughSourceImplementedClrInterface()
    {
        var result = Evaluate("""
            import System.Collections
            import System.Collections.Generic

            class Repo[T] : IEnumerable[T] {
                private let items List[T] = List[T]()

                init(value T) {
                    items.Add(value)
                }

                func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
                private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
            }

            func First[T](items sequence[T]) T {
                for item in items {
                    return item
                }

                return default(T)
            }

            First(Repo[int32](29))
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(29, result.Value);
    }

    [Fact]
    public void SequenceInference_ConflictingImportedProjections_DoNotInferArbitrarily()
    {
        foreach (var typeName in new[]
        {
            nameof(Issue3465ConflictingCollectionForward),
            nameof(Issue3465ConflictingCollectionReverse),
        })
        {
            var result = Evaluate($$"""
                import GSharp.Core.Tests.CodeAnalysis.Binding

                func First[T](items sequence[T]) T -> default(T)

                First({{typeName}}())
                """);

            Assert.Equal(1, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0151"));
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
        }
    }

    [Fact]
    public void GenericMethod_ConflictingSourceImplementedClrInterfaces_DoNotInferArbitrarily()
    {
        foreach (var baseTypes in new[]
        {
            "IEnumerable[int32], IEnumerable[string]",
            "IEnumerable[string], IEnumerable[int32]",
        })
        {
            var result = Evaluate($$"""
                import System.Collections
                import System.Collections.Generic

                class Conflict : {{baseTypes}} {
                    private func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] ->
                        List[int32]().GetEnumerator()
                    private func (IEnumerable[string]) GetEnumerator() IEnumerator[string] ->
                        List[string]().GetEnumerator()
                    private func (IEnumerable) GetEnumerator() IEnumerator ->
                        List[int32]().GetEnumerator()
                }

                func First[T](items IEnumerable[T]) T -> default(T)

                First(Conflict())
                """);

            Assert.Equal(1, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0151"));
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
        }
    }

    [Fact]
    public void AsyncSequenceInference_ConflictingImportedProjections_DoNotInferArbitrarily()
    {
        foreach (var typeName in new[]
        {
            nameof(Issue3465ConflictingAsyncCollectionForward),
            nameof(Issue3465ConflictingAsyncCollectionReverse),
        })
        {
            var result = Evaluate($$"""
                import GSharp.Core.Tests.CodeAnalysis.Binding

                func First[T](items async sequence[T]) T -> default(T)

                First({{typeName}}())
                """);

            Assert.Equal(1, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0151"));
            Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.Id == "GS9999");
        }
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
    public void NestedUntypedLambdaExplicitReturnShape_DisambiguatesOverloadsRegardlessOfOrder()
    {
        var overloadOrders = new[]
        {
            """
            func Choose(factory ()->Action[int32]) int32 -> 1
            func Choose(factory ()->Func[int32, int32]) int32 -> 2
            """,
            """
            func Choose(factory ()->Func[int32, int32]) int32 -> 2
            func Choose(factory ()->Action[int32]) int32 -> 1
            """,
        };

        foreach (var overloads in overloadOrders)
        {
            foreach (var call in new[]
            {
                "Choose(() -> { return ((value) -> {}) })",
                "Choose(factory: () -> { return (((value) -> {})) })",
                "Choose(() -> { return true ? ((value) -> {}) : ((value) -> {}) })",
                """
                Choose(() -> {
                    return switch true {
                        case true: (value) -> {}
                        default: (value) -> {}
                    }
                })
                """,
            })
            {
                var result = Evaluate($$"""
                    import System

                    {{overloads}}

                    {{call}}
                    """);

                Assert.Empty(result.Diagnostics);
                Assert.Equal(1, result.Value);
            }
        }
    }

    [Theory]
    [InlineData("(value) -> {}")]
    [InlineData("(value) -> { return }")]
    [InlineData("(value) -> { let copy = value }")]
    public void UntypedNoValueBlock_DisambiguatesToVoidOverload(string lambda)
    {
        var result = Evaluate($$"""
            func Choose(action (int32)->void) int32 -> 1
            func Choose(action (int32)->int32) int32 -> 2

            Choose({{lambda}})
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Theory]
    [InlineData("{ throw Exception(\"stop\") }")]
    [InlineData("{ for { } }")]
    public void NonCompletingBlock_IsCompatibleWithValueDelegate(string body)
    {
        var result = Evaluate($$"""
            import System

            func Visit(action (int32)->int32) {}

            func BindOnly() {
                Visit((value) -> {{body}})
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Theory]
    [InlineData("{ throw Exception(\"stop\") }")]
    [InlineData("{ for { } }")]
    public void NonCompletingBlock_DoesNotPreferVoidOverload(string body)
    {
        var result = Evaluate($$"""
            import System

            func Choose(action (int32)->void) int32 -> 1
            func Choose(action (int32)->int32) int32 -> 2

            Choose((value) -> {{body}})
            """);

        Assert.Equal(1, result.Diagnostics.Count(diagnostic => diagnostic.Id == "GS0266"));
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.Id is "GS0154" or "GS0155");
    }

    [Fact]
    public void NestedUntypedLambdaInExplicitReturn_DefersThroughWrappers()
    {
        var result = Evaluate("""
            import System

            func Accept(factory ()->Action[int32]) {
                factory()(2)
            }

            var seen = 0
            let flag = true
            Accept(factory: () -> {
                return (((value) -> { seen = seen + value }))
            })
            Accept(() -> {
                return flag
                    ? ((value) -> { seen = seen + value })
                    : ((value) -> { seen = seen + 100 })
            })
            Accept(() -> {
                return switch flag {
                    case true: (value) -> { seen = seen + value }
                    default: (value) -> { seen = seen + 100 }
                }
            })
            seen
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    [Fact]
    public void NestedUntypedLambda_CoalesceOperandReceivesDelegateTarget()
    {
        var result = Evaluate("""
            import System

            func Accept(factory ()->Action[int32]) {
                factory()(5)
            }

            var seen = 0
            Accept(factory: () -> nil ?? ((value) -> { seen = value }))
            seen
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
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

    [Fact]
    public void InvalidTypedLambdaBody_ReportsDiagnosticsOnceAcrossCallPaths()
    {
        var sources = new[]
        {
            """
            func Visit(action (int32)->void) {
                action(0)
            }

            Visit((value int32) -> { nonexistentName })
            """,
            """
            class Visitor {
                func Visit(action (int32)->void) {
                    action(0)
                }
            }

            Visitor().Visit((value int32) -> { nonexistentName })
            """,
            """
            class Visitor {
                init(action (int32)->void) {
                    action(0)
                }
            }

            Visitor((value int32) -> { nonexistentName })
            """,
            """
            class Visitor {
                shared {
                    func Visit(action (int32)->void) {
                        action(0)
                    }
                }
            }

            Visitor.Visit((value int32) -> { nonexistentName })
            """,
        };

        foreach (var source in sources)
        {
            var result = Evaluate(source);

            Assert.Equal(
                new[] { "GS0125", "GS0154" },
                result.Diagnostics.Select(diagnostic => diagnostic.Id).OrderBy(id => id));
        }
    }

    [Fact]
    public void ContextuallyReboundLambda_WarningIsReportedOnceAcrossCallPaths()
    {
        foreach (var source in LambdaDiagnosticOwnershipSources("""
            called = called + 1
            s == nil
            """))
        {
            var result = Evaluate(source);

            Assert.Equal(
                new[] { "GS0523" },
                result.Diagnostics.Select(diagnostic => diagnostic.Id));
            Assert.Equal(1, result.Value);
        }
    }

    [Fact]
    public void ContextuallyReboundLambda_NonTrailingErrorAndWarningAreReportedOnceAcrossCallPaths()
    {
        foreach (var source in LambdaDiagnosticOwnershipSources("""
            undefinedThing()
            s == nil
            """))
        {
            var result = Evaluate(source);

            Assert.Equal(
                new[] { "GS0130", "GS0523" },
                result.Diagnostics.Select(diagnostic => diagnostic.Id).OrderBy(id => id));
        }
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

    private static IEnumerable<string> LambdaDiagnosticOwnershipSources(string body)
    {
        var sources = new[]
        {
            """
            func Visit(action ()->void) {
                action()
            }

            var called = 0
            var s = []int32{1}
            Visit(() -> {
                __BODY__
            })
            called
            """,
            """
            func Visit(action (int32)->void) {
                action(0)
            }

            var called = 0
            var s = []int32{1}
            Visit((ignored) -> {
                __BODY__
            })
            called
            """,
            """
            class Visitor {
                func Visit(action ()->void) {
                    action()
                }
            }

            var called = 0
            var s = []int32{1}
            Visitor().Visit(() -> {
                __BODY__
            })
            called
            """,
            """
            class Visitor {
                init(action ()->void) {
                    action()
                }
            }

            var called = 0
            var s = []int32{1}
            Visitor(() -> {
                __BODY__
            })
            called
            """,
            """
            class Visitor {
                shared {
                    func Visit(action ()->void) {
                        action()
                    }
                }
            }

            var called = 0
            var s = []int32{1}
            Visitor.Visit(() -> {
                __BODY__
            })
            called
            """,
            """
            import System

            func Accept(factory ()->Action) {
                factory()()
            }

            var called = 0
            var s = []int32{1}
            Accept(() -> () -> {
                __BODY__
            })
            called
            """,
        };

        foreach (var source in sources)
        {
            yield return source.Replace("__BODY__", body);
        }
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

public sealed class Issue3465ConflictingAsyncCollectionForward :
    IAsyncEnumerable<int>,
    IAsyncEnumerable<string>
{
    IAsyncEnumerator<int> IAsyncEnumerable<int>.GetAsyncEnumerator(
        System.Threading.CancellationToken cancellationToken)
        => new Issue3465EmptyAsyncEnumerator<int>();

    IAsyncEnumerator<string> IAsyncEnumerable<string>.GetAsyncEnumerator(
        System.Threading.CancellationToken cancellationToken)
        => new Issue3465EmptyAsyncEnumerator<string>();
}

public sealed class Issue3465ConflictingAsyncCollectionReverse :
    IAsyncEnumerable<string>,
    IAsyncEnumerable<int>
{
    IAsyncEnumerator<int> IAsyncEnumerable<int>.GetAsyncEnumerator(
        System.Threading.CancellationToken cancellationToken)
        => new Issue3465EmptyAsyncEnumerator<int>();

    IAsyncEnumerator<string> IAsyncEnumerable<string>.GetAsyncEnumerator(
        System.Threading.CancellationToken cancellationToken)
        => new Issue3465EmptyAsyncEnumerator<string>();
}

public sealed class Issue3465EmptyAsyncEnumerator<T> : IAsyncEnumerator<T>
{
    public T Current => default!;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    public ValueTask<bool> MoveNextAsync() => ValueTask.FromResult(false);
}
