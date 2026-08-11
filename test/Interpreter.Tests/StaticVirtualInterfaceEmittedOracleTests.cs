// <copyright file="StaticVirtualInterfaceEmittedOracleTests.cs" company="GSharp">
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

/// <summary>
/// Emitted-oracle coverage for static virtual interface.
/// Traceability: ADR-0087 and ADR-0089; issue #755.
/// </summary>
public class StaticVirtualInterfaceEmittedOracleTests
{
    [Fact]
    public void Generic_Dispatch_Calls_Implementer_Static()
    {
        var source = """
            import System

            sealed interface IAdd {
                shared {
                    func Add(a int32, b int32) int32;
                }
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

        Assert.Equal($"7{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void Default_Body_Inherited_When_Implementer_Omits_Override()
    {
        var source = """
            import System

            sealed interface IGreet {
                shared {
                    func Hello() string { return "default-hello" }
                }
            }

            class Quiet : IGreet {
            }

            func Use[T IGreet](w T) string {
                return T.Hello()
            }

            Console.WriteLine(Use(Quiet{}))
            """;

        Assert.Equal($"default-hello{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void Implementer_Override_Wins_Over_Default()
    {
        var source = """
            import System

            sealed interface IGreet {
                shared {
                    func Hello() string { return "default-hello" }
                }
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

        Assert.Equal($"LOUD-hello{Environment.NewLine}", Evaluate(source));
    }

    [Fact]
    public void Two_Implementers_Resolve_Independently()
    {
        var source = """
            import System

            sealed interface IAdd {
                shared {
                    func Add(a int32, b int32) int32;
                }
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

        Assert.Equal($"7{Environment.NewLine}12{Environment.NewLine}", Evaluate(source));
    }

    private static string Evaluate(string source)
    {
        var result = EmittedOracle.Evaluate(source);

        var errors = result.Diagnostics.Where(d => d.IsError).ToList();
        Assert.True(
            errors.Count == 0,
            "evaluation failed:\n" + string.Join("\n", errors.Select(d => d.ToString())));
        return result.Output.ReplaceLineEndings(Environment.NewLine);
    }
}
