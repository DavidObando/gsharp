// <copyright file="Issue3420VarPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Runtime and IL verification for native total <c>var name</c> patterns.</summary>
public sealed class Issue3420VarPatternEmitTests
{
    [Fact]
    public void VarPatternMatrix_VerifiesAndRuns()
    {
        const string Source = """
            package Issue3420
            import System

            class Box {
                prop Value object? { get; init; }
            }

            func Reference(value string?) string {
                if value is var captured {
                    return captured ?? "nil"
                }
                return "unreachable"
            }

            func Value(value int32) int32 {
                if value is var captured {
                    return captured + 1
                }
                return -1
            }

            func NullableValue(value int32?) int32 {
                if value is var captured {
                    return captured ?? -1
                }
                return -2
            }

            func Property(box Box) string {
                if box is { Value: var captured } {
                    return captured == nil ? "nil" : "value"
                }
                return "unreachable"
            }

            func List(values []int32) int32 {
                if values is [var first, ..] {
                    return first
                }
                return -1
            }

            func Negated(value string?) string {
                if !(value is var captured) {
                    return "unreachable"
                }
                return captured ?? "nil"
            }

            func Switch(value object?) string {
                return switch value {
                    case var captured: captured == nil ? "nil" : "value"
                }
            }

            func SwitchStatement(value object?) string {
                switch value {
                    case var captured when captured == nil { return "nil" }
                    case var captured { return "value" }
                }
                return "unreachable"
            }

            func CapturedSwitch(box Box) () -> string {
                return switch box {
                    case { Value: var captured }: () -> captured == nil ? "nil" : "value"
                    default: () -> "unreachable"
                }
            }

            Console.WriteLine(Reference("text"))
            Console.WriteLine(Reference(nil))
            Console.WriteLine(Value(41))
            Console.WriteLine(NullableValue(7))
            Console.WriteLine(NullableValue(nil))
            Console.WriteLine(Property(Box{Value: "member"}))
            Console.WriteLine(Property(Box{Value: nil}))
            Console.WriteLine(List([]int32{5, 6}))
            Console.WriteLine(List([]int32{}))
            Console.WriteLine(Negated("kept"))
            Console.WriteLine(Negated(nil))
            Console.WriteLine(Switch(9))
            Console.WriteLine(Switch(nil))
            Console.WriteLine(SwitchStatement(9))
            Console.WriteLine(SwitchStatement(nil))
            Console.WriteLine(CapturedSwitch(Box{Value: "closure"})())
            """;

        var result = Issue3409PatternVariableEmitTests.CompileAndRun(Source);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(
            string.Join(Environment.NewLine,
            [
                "text",
                "nil",
                "42",
                "7",
                "-1",
                "value",
                "nil",
                "5",
                "-1",
                "kept",
                "nil",
                "value",
                "nil",
                "value",
                "nil",
                "value",
                string.Empty,
            ]),
            result.Stdout);
    }
}
