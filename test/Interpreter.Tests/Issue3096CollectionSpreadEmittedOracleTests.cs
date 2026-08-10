// <copyright file="Issue3096CollectionSpreadEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #3096: Emitted-oracle coverage for collection spread.
/// </summary>
public sealed class Issue3096CollectionSpreadEmittedOracleTests
{
    [Fact]
    public void ArraySpread_EvaluatesOnceInLexicalOrderAndConvertsElements()
    {
        const string Source = """
            import System

            var calls = 0
            var trace = ""

            func Mark(value int32, marker string) int32 {
                trace = trace + marker
                return value
            }

            func Source() []int32 {
                calls++
                trace = trace + "B"
                return []int32{ 2, 3 }
            }

            let values = []int64{
                int64(Mark(1, "A")),
                ...Source(),
                ...[]int32{},
                int64(Mark(4, "C")),
            }

            Console.WriteLine(trace)
            Console.WriteLine(calls)
            Console.WriteLine(values.Length)
            Console.WriteLine(values[0])
            Console.WriteLine(values[1])
            Console.WriteLine(values[2])
            Console.WriteLine(values[3])
            """;

        Assert.Equal($"ABC{Environment.NewLine}1{Environment.NewLine}4{Environment.NewLine}1{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}4{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void CollectionAndFieldInitializerSpreads_PreserveContents()
    {
        const string Source = """
            import System
            import System.Collections.Generic

            interface IStaticValues {
                shared {
                    var Count int32 = []int32{ 6, ...[]int32{ 7 } }.Length
                }
            }

            class Holder {
                let Values []int32 = []int32{ 5, ...[]int32{}, 6 }

                shared {
                    public var StaticCalls int32 = 0
                    public var StaticTrace int32 = 0
                    public let StaticValues []int32 = []int32{ 4, ...MakeStaticValues() }

                    func MakeStaticValues() []int32 {
                        StaticCalls++
                        return []int32{ 5 }
                    }

                    init {
                        StaticTrace = StaticCalls + 10
                    }
                }
            }

            let list = List[int32](){ 0, ...[]int32{ 1, 2 }, 3 }
            let widened = List[int64](){ ...[]int32{ 7 } }
            let set = HashSet[int32](){ ...[]int32{ 1, 1, 2 } }
            let holder = Holder()

            Console.WriteLine(list.Count)
            Console.WriteLine(list[0])
            Console.WriteLine(list[3])
            Console.WriteLine(widened[0])
            Console.WriteLine(set.Count)
            Console.WriteLine(IStaticValues.Count)
            Console.WriteLine(Holder.StaticValues[1])
            Console.WriteLine(Holder.StaticCalls)
            Console.WriteLine(Holder.StaticTrace)
            Console.WriteLine(holder.Values.Length)
            Console.WriteLine(holder.Values[1])
            """;

        Assert.Equal($"4{Environment.NewLine}0{Environment.NewLine}3{Environment.NewLine}7{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}5{Environment.NewLine}1{Environment.NewLine}11{Environment.NewLine}2{Environment.NewLine}6{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void FaultedStaticSpreadInitializer_IsNotRetried()
    {
        const string Source = """
            import System

            var attempts = 0

            class Broken {
                shared {
                    let Values []int32 = []int32{ ...Fail() }

                    func Fail() []int32 {
                        attempts++
                        throw InvalidOperationException("boom")
                    }
                }
            }

            func Read() {
                try {
                    let ignored = Broken.Values
                } catch (ex TypeInitializationException) {
                    Console.WriteLine(ex.InnerException is InvalidOperationException)
                }
            }

            Read()
            Read()
            Console.WriteLine(attempts)
            """;

        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}1{Environment.NewLine}", Evaluate(Source));
    }

    [Fact]
    public void StaticInitialization_RunsAfterCallArguments()
    {
        const string Source = """
            import System

            func Argument() int32 {
                Console.Write("A")
                return 1
            }

            class Ordered {
                shared {
                    init {
                        Console.Write("I")
                    }

                    func Use(value int32) {
                        Console.Write("M")
                    }
                }
            }

            Ordered.Use(Argument())
            """;

        // Issue #3203 resolution (ADR-0140 §4): an explicit `shared { init }`
        // block emits a real `.cctor` with C# static-constructor timing —
        // `beforefieldinit` cleared — so the initializer is guaranteed to run
        // at the first static access (the `Use` invocation), after its call
        // arguments. The original field-initializer-only form of this repro
        // keeps `beforefieldinit` (aligned with C#) and its timing is
        // CLR-unspecified; that half of the contract is pinned by the
        // Issue3203SharedInitializerCctorTests metadata tests in Core.Tests.
        // Migrated off the evaluator pin per ADR-0156 Phase 3b (#3176).
        Assert.Equal("AIM", Evaluate(Source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
        Assert.True(
            errors.Length == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));

        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
