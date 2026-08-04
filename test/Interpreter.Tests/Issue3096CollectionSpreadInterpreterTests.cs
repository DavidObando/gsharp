// <copyright file="Issue3096CollectionSpreadInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>Interpreter coverage for native array/collection spreads.</summary>
public sealed class Issue3096CollectionSpreadInterpreterTests
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

        Assert.Equal("ABC\n1\n4\n1\n2\n3\n4\n", Evaluate(Source));
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

        Assert.Equal("4\n0\n3\n7\n2\n2\n5\n1\n11\n2\n6\n", Evaluate(Source));
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

        Assert.Equal("True\nTrue\n1\n", Evaluate(Source));
    }

    [Fact]
    public void StaticInitialization_RunsAfterCallArguments()
    {
        const string Source = """
            import System

            var trace = ""

            func Argument() int32 {
                trace = trace + "A"
                return 1
            }

            class Ordered {
                shared {
                    let Initialized int32 = Initialize()

                    func Initialize() int32 {
                        trace = trace + "I"
                        return 0
                    }

                    func Use(value int32) {
                        trace = trace + "M"
                    }
                }
            }

            Ordered.Use(Argument())
            Console.WriteLine(trace)
            """;

        // ADR-0156 Phase 3b (#3176): stays on Compilation.Evaluate — issue
        // #3203 pins the divergence this test exposed: the EVALUATOR runs
        // shared initializers eagerly at first static use ("AIM"), while
        // emitted execution is CLR-beforefieldinit lazy and never runs the
        // initializer here ("AM"). Realigns with #3203's resolution.
        Assert.Equal("AIM\n", EvaluateWithEvaluator(Source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);
        var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
        Assert.True(
            errors.Length == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));

        return result.Output.Replace("\r\n", "\n", StringComparison.Ordinal);
    }

    // Evaluator-pinned twin of Evaluate for the #3203 test above; delete with
    // the evaluator (Phase 3c) or when #3203 aligns the engines.
    private static string EvaluateWithEvaluator(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(source));

        using var output = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(output);
        try
        {
            var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
            var errors = result.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(diagnostic => diagnostic.ToString())));
        }
        finally
        {
            Console.SetOut(previous);
        }

        return output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
