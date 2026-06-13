// <copyright file="StaticVirtualInterfaceInterpreterTests.cs" company="GSharp">
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
/// ADR-0089 / issue #755 — interpreter parity for static-virtual
/// interface members. The evaluator must dispatch
/// <c>BoundConstrainedStaticCallExpression</c> the same way the
/// emit pipeline does so a generic method that calls <c>T.Add(...)</c>
/// resolves to the implementer's static method at runtime. The
/// witness-T pattern (carry a value of type <c>T</c> as a parameter)
/// gives the interpreter a concrete handle to find the implementer
/// even though G# generic dispatch is type-erased at the evaluator
/// level (see ADR-0087 R5/R6/R7 deferred work).
/// </summary>
public class StaticVirtualInterfaceInterpreterTests
{
    [Fact]
    public void Generic_Dispatch_Calls_Implementer_Static()
    {
        var source = """
            import System

            sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }

            class Adder : IAdd {
                shared {
                    func Add(a int32, b int32) int32 { return a + b }
                }
            }

            func Compute[T IAdd](w T, a int32, b int32) int32 {
                return T.Add(a, b)
            }

            Console.WriteLine(Compute(Adder{}, 3, 4))
            """;

        Assert.Equal("7\n", Evaluate(source));
    }

    [Fact]
    public void Default_Body_Inherited_When_Implementer_Omits_Override()
    {
        var source = """
            import System

            sealed interface IGreet {
                static func Hello() string { return "default-hello" }
            }

            class Quiet : IGreet {
            }

            func Use[T IGreet](w T) string {
                return T.Hello()
            }

            Console.WriteLine(Use(Quiet{}))
            """;

        Assert.Equal("default-hello\n", Evaluate(source));
    }

    [Fact]
    public void Implementer_Override_Wins_Over_Default()
    {
        var source = """
            import System

            sealed interface IGreet {
                static func Hello() string { return "default-hello" }
            }

            class Loud : IGreet {
                shared {
                    func Hello() string { return "LOUD-hello" }
                }
            }

            func Use[T IGreet](w T) string {
                return T.Hello()
            }

            Console.WriteLine(Use(Loud{}))
            """;

        Assert.Equal("LOUD-hello\n", Evaluate(source));
    }

    [Fact]
    public void Two_Implementers_Resolve_Independently()
    {
        var source = """
            import System

            sealed interface IAdd {
                static func Add(a int32, b int32) int32
            }

            class Plus : IAdd {
                shared { func Add(a int32, b int32) int32 { return a + b } }
            }

            class Times : IAdd {
                shared { func Add(a int32, b int32) int32 { return a * b } }
            }

            func Apply[T IAdd](w T, a int32, b int32) int32 {
                return T.Add(a, b)
            }

            Console.WriteLine(Apply(Plus{}, 3, 4))
            Console.WriteLine(Apply(Times{}, 3, 4))
            """;

        Assert.Equal("7\n12\n", Evaluate(source));
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
