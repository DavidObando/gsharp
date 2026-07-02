// <copyright file="Issue1652DefaultValueInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #1652: <c>Evaluator.DefaultValue</c> only special-cased
/// <c>bool</c>/<c>int32</c>/<c>string</c>/enum/struct and fell back to
/// <c>null</c> for every other primitive (int64, the unsigned/sized integer
/// family, float32/float64, decimal, char, nint/nuint) — diverging from the
/// emitted IL, which always produces the CLR-correct zero for a value type
/// (e.g. <c>0L</c> for int64, <c>0.0</c> for float64). These tests cover
/// map-miss defaults, struct/class field defaults, auto-property defaults,
/// and enum defaults for every affected primitive, proving interpreter/
/// compiled parity (a `nil` default would either throw or misbehave in the
/// arithmetic/comparison below, so a correct numeric result demonstrates the
/// fix).
/// </summary>
public class Issue1652DefaultValueInterpreterTests
{
    [Theory]
    [InlineData("int64", "5")]
    [InlineData("uint64", "5")]
    [InlineData("uint32", "5")]
    [InlineData("int16", "5")]
    [InlineData("uint16", "5")]
    [InlineData("int8", "5")]
    [InlineData("uint8", "5")]
    [InlineData("nint", "5")]
    [InlineData("nuint", "5")]
    public void MapMiss_IntegerDefault_AddsAsTypedZero(string typeName, string expected)
    {
        // Repro from the issue: reading a missing map key must yield the
        // CLR zero for the value type, not `nil` (which would blow up or
        // silently no-op the `+`).
        var source = $$"""
            var m = map[string,{{typeName}}]{}
            let v = m["missing"]
            v + {{typeName}}(5)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains(expected, output);
    }

    [Fact]
    public void MapMiss_Float32Default_AddsAsZero()
    {
        var source = """
            var m = map[string,float32]{}
            let v = m["missing"]
            v + float32(1.5)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("1.5", output);
    }

    [Fact]
    public void MapMiss_Float64Default_AddsAsZero()
    {
        var source = """
            var m = map[string,float64]{}
            let v = m["missing"]
            v + 1.5
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("1.5", output);
    }

    [Fact]
    public void MapMiss_CharDefault_IsNulChar()
    {
        // char's CLR default is '\0'; comparing against it must succeed
        // (previously `nil` would fail the comparison / throw).
        var source = """
            var m = map[string,char]{}
            let v = m["missing"]
            v == char(0)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("True", output);
    }

    [Fact]
    public void MapMiss_BoolDefault_IsFalse()
    {
        var source = """
            var m = map[string,bool]{}
            m["missing"]
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("False", output);
    }

    [Fact]
    public void StructField_Int64Default_AddsAsZero()
    {
        var source = """
            struct Counter {
                var Value int64
            }
            let c = Counter{}
            c.Value + int64(7)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("7", output);
    }

    [Fact]
    public void ClassField_Float64Default_AddsAsZero()
    {
        var source = """
            class Sample {
                var Amount float64
            }
            let s = Sample{}
            s.Amount + 2.25
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("2.25", output);
    }

    [Fact]
    public void AutoProperty_UInt32Default_AddsAsZero()
    {
        var source = """
            class Foo {
                prop Count uint32
            }
            let f = Foo{}
            f.Count + uint32(9)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("9", output);
    }

    [Fact]
    public void AutoProperty_CharDefault_IsNulChar()
    {
        var source = """
            class Foo {
                prop Letter char
            }
            let f = Foo{}
            f.Letter == char(0)
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("True", output);
    }

    [Fact]
    public void UserEnum_DefaultValue_EqualsZeroMember()
    {
        // User-defined enums have no ClrType at interpret time (their
        // members are raw int literals — see EnumMemberSymbol.Value), so
        // default(Color) must equal the boxed int backing Color.Red (the
        // first, auto-numbered-0 member), not `nil`.
        var source = """
            package p
            enum Color { Red, Green, Blue }
            class Box {
                var C Color
            }
            let b = Box{}
            b.C == Color.Red
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("True", output);
    }

    [Fact]
    public void ImportedEnum_DefaultValue_IsZeroMember()
    {
        // Imported enums (real CLR System.Enum types, e.g. DayOfWeek) DO
        // have a ClrType, so their default must be a properly-typed boxed
        // enum zero via Enum.ToObject, not a raw int — printing the zero
        // member's name ("Sunday"), and arithmetic off it produces the
        // next real enum member ("Monday"), exactly as compiled code would.
        var source = """
            import System
            struct Meeting {
                var Day DayOfWeek
            }
            let m = Meeting{}
            Console.WriteLine(m.Day)
            Console.WriteLine(m.Day + int32(1))
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("Sunday", output);
        Assert.Contains("Monday", output);
    }

    [Fact]
    public void NullableInt32Default_IsNilNotZero()
    {
        // Regression guard: NullableTypeSymbol.ClrType aliases the
        // underlying type's ClrType, so the value-type fallback must not
        // swallow it — default(int32?) is nil, not boxed 0.
        var source = """
            class Foo {
                var Count int32?
            }
            let f = Foo{}
            f.Count == nil
            """;
        var output = RunSubmission(source);
        Assert.DoesNotContain("error GS", output);
        Assert.Contains("True", output);
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString();
    }
}
