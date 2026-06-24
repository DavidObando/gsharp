// <copyright file="Issue1030InterfaceStaticMembersInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0089 / issue #1030 — interpreter parity for interface static *state*
/// and default-bodied static-virtual interface *properties* (follow-up to
/// #1019). The evaluator must (a) store/read an interface static field as
/// shared state, (b) inline interface <c>const</c> reads, and (c) dispatch a
/// <c>T.Prop</c> read to the interface's default getter body when the
/// implementer does not override it.
/// </summary>
public class Issue1030InterfaceStaticMembersInterpreterTests
{
    [Fact]
    public void InterfaceStaticState_ReadWrite_And_Const_AreSharedState()
    {
        var source = """
            import System

            interface ICounter {
                shared {
                    var Count int32
                    const Max int32 = 100
                }
            }

            ICounter.Count = ICounter.Count + 7
            Console.WriteLine(ICounter.Count)
            Console.WriteLine(ICounter.Max)
            """;

        Assert.Equal("7\n100\n", Evaluate(source));
    }

    [Fact]
    public void InterfaceStaticState_SharedAcrossConstraintDispatch()
    {
        var source = """
            import System

            sealed interface ICounter {
                shared {
                    var Count int32
                    func Bump() {
                        Count = Count + 1
                    }
                    func Get() int32 {
                        return Count
                    }
                }
            }

            struct C : ICounter {
            }

            func Run[T ICounter](witness T) int32 {
                T.Bump()
                T.Bump()
                return T.Get()
            }

            Console.WriteLine(Run(C{}))
            Console.WriteLine(ICounter.Count)
            """;

        Assert.Equal("2\n2\n", Evaluate(source));
    }

    [Fact]
    public void DefaultBodiedStaticProperty_UsesInterfaceDefault()
    {
        var source = """
            import System

            sealed interface IData {
                shared {
                    prop Name string { get { return "default-name" } }
                }
            }

            struct Apple : IData {
            }

            func Describe[T IData](witness T) string {
                return T.Name
            }

            Console.WriteLine(Describe(Apple{}))
            """;

        Assert.Equal("default-name\n", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);

        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var variables = new Dictionary<VariableSymbol, object>();
            var result = compilation.Evaluate(variables);

            var errors = result.Diagnostics.Where(d => d.IsError).ToList();
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
