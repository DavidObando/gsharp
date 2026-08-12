// <copyright file="Issue3353MultiAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #3353: storage-target and tuple-valued multi-assignment semantics.
/// </summary>
public sealed class Issue3353MultiAssignmentEmitTests
{
    [Fact]
    public void StorageTargets_EvaluateBeforeRhs_AndWriteLeftToRight()
    {
        var lines = Run("""
            import System

            var order = 0
            var writes = 0

            func Step(n int32) int32 {
                order = (order * 10) + n
                return n
            }

            class Box {
                var Raw int32
                prop Value int32 {
                    get { return Raw }
                    set(v) {
                        writes = (writes * 10) + v
                        Raw = v
                    }
                }
            }

            var first = Box{}
            var second = Box{}
            var values = []int32{0}

            func First() Box {
                Step(1)
                return first
            }

            func Second() Box {
                Step(2)
                return second
            }

            func Index() int32 {
                Step(3)
                return 0
            }

            func Rhs(mark int32, value int32) int32 {
                Step(mark)
                return value
            }

            First().Value, Second().Value, values[Index()] = Rhs(4, 7), Rhs(5, 8), Rhs(6, 9)

            Console.WriteLine(order)
            Console.WriteLine(writes)
            Console.WriteLine(first.Raw)
            Console.WriteLine(second.Raw)
            Console.WriteLine(values[0])
            """);

        Assert.Equal(new[] { "123456", "78", "7", "8", "9" }, lines);
    }

    [Fact]
    public void TargetOrRhsThrow_PreventsAllWrites()
    {
        var lines = Run("""
            import System

            var targetSteps = 0
            var rhsSteps = 0
            var writes = 0

            class Box {
                prop Value int32 {
                    get { return 0 }
                    set(v) { writes = writes + 1 }
                }
            }

            var box = Box{}

            func ThrowingReceiver() Box {
                targetSteps = targetSteps + 1
                throw InvalidOperationException()
            }

            func Target(n int32) Box {
                targetSteps = (targetSteps * 10) + n
                return box
            }

            func Value(n int32) int32 {
                rhsSteps = (rhsSteps * 10) + n
                return n
            }

            func Boom(n int32) int32 {
                rhsSteps = (rhsSteps * 10) + n
                throw InvalidOperationException()
            }

            func ThrowingIndex() int32 {
                targetSteps = (targetSteps * 10) + 9
                throw InvalidOperationException()
            }

            try {
                ThrowingReceiver().Value, box.Value = Value(1), Value(2)
            } catch (e InvalidOperationException) {
            }

            Console.WriteLine(targetSteps)
            Console.WriteLine(rhsSteps)
            Console.WriteLine(writes)

            targetSteps = 0
            rhsSteps = 0
            try {
                Target(1).Value, Target(2).Value = Value(3), Boom(4)
            } catch (e InvalidOperationException) {
            }

            Console.WriteLine(targetSteps)
            Console.WriteLine(rhsSteps)
            Console.WriteLine(writes)

            targetSteps = 0
            rhsSteps = 0
            var values = []int32{0}
            try {
                values[ThrowingIndex()], box.Value = Value(5), Value(6)
            } catch (e InvalidOperationException) {
            }

            Console.WriteLine(targetSteps)
            Console.WriteLine(rhsSteps)
            Console.WriteLine(writes)
            """);

        Assert.Equal(new[] { "1", "0", "0", "12", "34", "0", "9", "0", "0" }, lines);
    }

    [Fact]
    public void AliasingSwaps_UseCapturedStorageLocations()
    {
        var lines = Run("""
            import System

            class Box { var Value int32 }
            struct Pair { var X int32 var Y int32 }
            struct Counter {
                var Raw int32
                prop Value int32 {
                    get { return Raw }
                    set(v) { Raw = v }
                }
            }

            var a = 1
            var b = 2
            a, b = b, a

            var values = []int32{10, 20}
            var i = 0
            var j = 1
            values[i], values[j] = values[j], values[i]
            values[0], values[0] = 30, 40

            var old = Box{Value: 5}
            var current = old
            var replacement = Box{Value: 6}
            current, current.Value = replacement, 9

            var pair = Pair{X: 1, Y: 2}
            var replacementPair = Pair{X: 7, Y: 8}
            pair, pair.X = replacementPair, 9

            var counter = Counter{Raw: 1}
            var replacementCounter = Counter{Raw: 7}
            counter, counter.Value = replacementCounter, 9

            Console.WriteLine((a * 10) + b)
            Console.WriteLine((values[0] * 100) + values[1])
            Console.WriteLine(current.Value)
            Console.WriteLine(old.Value)
            Console.WriteLine((pair.X * 10) + pair.Y)
            Console.WriteLine(counter.Raw)
            """);

        Assert.Equal(new[] { "21", "4010", "6", "9", "98", "9" }, lines);
    }

    [Fact]
    public void TupleRhs_EvaluatesOnce_AndConvertsElements()
    {
        var lines = Run("""
            import System

            var calls = 0

            func Pair() (int32, string?) {
                calls = calls + 1
                return (7, nil)
            }

            func GenericPair[T](left T, right T) (T, T) {
                calls = calls + 1
                return (left, right)
            }

            var wide int64 = 0L
            var text string? = "value"
            wide, text = Pair()

            var first = 0
            var second = 0
            first, second = GenericPair[int32](3, 4)

            var literalA = 0
            var literalB = 0
            literalA, literalB = (5, 6)

            let (declA, declB) = GenericPair[int32](8, 9)

            var nested (int64, int64) = (0L, 0L)
            var tail = 0
            nested, tail = ((1, 2), 3)

            Console.WriteLine(calls)
            Console.WriteLine(wide)
            Console.WriteLine(text == nil)
            Console.WriteLine((first * 10) + second)
            Console.WriteLine((literalA * 10) + literalB)
            Console.WriteLine((declA * 10) + declB)
            Console.WriteLine((nested.Item1 * 100) + (nested.Item2 * 10) + tail)
            """);

        Assert.Equal(new[] { "3", "7", "True", "34", "56", "89", "123" }, lines);
    }

    [Fact]
    public void StaticNestedMapClrIndexerAndDiscardTargets_Work()
    {
        var lines = Run("""
            import System
            import System.Collections.Generic

            class Box { var Value int32 }
            class Holder { var Child Box }
            class Shared {
                shared {
                    public var Value int32
                }
            }

            var holder = Holder{Child: Box{}}
            var values = map[string, int32]{}
            var list = List[int32]{0}
            var calls = 0

            func Mark() int32 {
                calls = calls + 1
                return 4
            }

            Shared.Value, holder.Child.Value, values["key"], list[0], _ = 1, 2, 3, 4, Mark()

            Console.WriteLine(Shared.Value)
            Console.WriteLine(holder.Child.Value)
            Console.WriteLine(values["key"])
            Console.WriteLine(list[0])
            Console.WriteLine(calls)
            """);

        Assert.Equal(new[] { "1", "2", "3", "4", "1" }, lines);
    }

    [Fact]
    public void PointerTarget_PreservesSwapAndAliasing()
    {
        var lines = Run("""
            import System

            unsafe func Run() int32 {
                var left = 1
                var right = 2
                var pointer *int32 = &left
                *pointer, right = right, *pointer
                return (left * 10) + right
            }

            Console.WriteLine(Run())
            """);

        Assert.Equal(new[] { "21" }, lines);
    }

    [Fact]
    public void GenericConstrainedPropertyTarget_WorksForReferenceAndValueTypes()
    {
        var lines = Run("""
            import System

            interface IValue { prop Value int32 { get; set; } }

            class RefBox : IValue {
                prop Value int32 { get; set; }
            }

            struct ValueBox : IValue {
                var Raw int32
                prop Value int32 {
                    get { return Raw }
                    set(v) { Raw = v }
                }
            }

            open class BaseBox {
                prop Value int32 { get; set; }
            }

            class DerivedBox : BaseBox {
            }

            func Assign[T IValue](target T) int32 {
                var other = 0
                target.Value, other = (7, 8)
                return (target.Value * 10) + other
            }

            func AssignClass[T BaseBox](target T) int32 {
                var other = 0
                target.Value, other = (5, 6)
                return (target.Value * 10) + other
            }

            Console.WriteLine(Assign[RefBox](RefBox()))
            Console.WriteLine(Assign[ValueBox](ValueBox{}))
            Console.WriteLine(AssignClass[DerivedBox](DerivedBox()))
            """);

        Assert.Equal(new[] { "78", "78", "56" }, lines);
    }

    [Fact]
    public void ImplicitStructFieldTargets_PreserveExistingIdentifierForm()
    {
        var lines = Run("""
            import System

            struct Pair {
                var Left int32
                var Right int32

                func Swap() {
                    Left, Right = Right, Left
                }
            }

            var pair = Pair{Left: 1, Right: 2}
            pair.Swap()
            Console.WriteLine((pair.Left * 10) + pair.Right)
            """);

        Assert.Equal(new[] { "21" }, lines);
    }

    [Fact]
    public void AwaitedTupleRhs_PreservesCapturedArrayTarget()
    {
        var lines = Run("""
            import System
            import System.Threading.Tasks

            var chosen = 0
            var targetCalls = 0

            func TargetIndex() int32 {
                targetCalls = targetCalls + 1
                return chosen
            }

            async func Pair() (int32, int32) {
                await Task.Yield()
                chosen = 1
                return (7, 2)
            }

            async func Run() int32 {
                var values = []int32{0, 0}
                while chosen == 0 {
                    values[TargetIndex()], chosen = await Pair()
                }
                return (targetCalls * 1000) + (values[0] * 100) + (values[1] * 10) + chosen
            }

            var task = Run()
            task.Wait()
            Console.WriteLine(task.Result)
            """);

        Assert.Equal(new[] { "1702" }, lines);
    }

    [Fact]
    public void AwaitedTupleRhs_PreservesNestedStructStorage()
    {
        var lines = Run("""
            import System
            import System.Threading.Tasks

            struct Inner { var Value int32 }
            struct Outer { var Inner Inner }

            async func Pair() (Outer, int32) {
                await Task.Yield()
                return (Outer{Inner: Inner{Value: 7}}, 9)
            }

            async func Run() int32 {
                var outer = Outer{Inner: Inner{Value: 1}}
                outer, outer.Inner.Value = await Pair()
                return outer.Inner.Value
            }

            var task = Run()
            task.Wait()
            Console.WriteLine(task.Result)
            """);

        Assert.Equal(new[] { "9" }, lines);
    }

    [Fact]
    public void AwaitedRhs_DoesNotRunWhenCapturedArrayAddressIsInvalid()
    {
        var lines = Run("""
            import System
            import System.Threading.Tasks

            var rhsCalls = 0

            async func Pair() (int32, int32) {
                rhsCalls = rhsCalls + 1
                await Task.Yield()
                return (1, 2)
            }

            async func Run() int32 {
                var values = []int32{0}
                var other = 0
                try {
                    values[2], other = await Pair()
                } catch (e IndexOutOfRangeException) {
                    return rhsCalls
                }

                return -1
            }

            var task = Run()
            task.Wait()
            Console.WriteLine(task.Result)
            """);

        Assert.Equal(new[] { "0" }, lines);
    }

    private static string[] Run(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.DoesNotContain(
            result.Diagnostics,
            diagnostic => diagnostic.IsError);
        Assert.Null(result.UnhandledException);
        return result.Output
            .ReplaceLineEndings(Environment.NewLine)
            .TrimEnd(Environment.NewLine.ToCharArray())
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);
    }
}
