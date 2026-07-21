// <copyright file="Issue2616CharNumericPromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #2616: ECMA numeric promotion for char expressions.</summary>
public class Issue2616CharNumericPromotionTests
{
    [Fact]
    public void ExactOahuKeyCharSubtraction_BindsAsInt32()
    {
        const string Source = """
            package Oahu.Cli.Tui
            import System

            func tabIndex(key ConsoleKeyInfo) int32 {
                let idx = key.KeyChar - '1'
                return idx
            }
            """;

        Assert.Empty(Errors(Source));
    }

    [Fact]
    public void UnaryBinaryNullableAndCompoundCharForms_Bind()
    {
        const string Source = """
            package P

            func promoted(a char, b char, u uint32, d float64) float64 {
                let unary int32 = +a - -b + ^a
                let chars int32 = a + b * a - b / a + b % a
                let mixed uint32 = a + u
                return d + a
            }

            func lifted(a char?, b char?) int32? {
                return a - b
            }

            func liftedShift(a char?, count char?) int32? {
                return a << count
            }

            func compound(input char, other char) char {
                var ch = input
                ch += other
                ch -= '1'
                ch *= other
                ch /= other
                ch %= other
                ch &= other
                ch |= other
                ch ^= other
                ch <<= 1
                ch >>= 1
                return ch
            }

            func liftedCompound(left char?, right char?) char? {
                var value = left
                value += right
                value -= right
                return value
            }
            """;

        Assert.Empty(Errors(Source));
    }

    [Fact]
    public void NonAdditiveCompoundOnInParameter_PreservesGs0237()
    {
        var errors = Errors("func bad(in ch char) { ch *= 2 }");
        Assert.Contains(errors, d => d.Id == "GS0237");
        Assert.DoesNotContain(errors, d => d.Id == "GS0127");
    }

    [Theory]
    [InlineData("int8", "int32")]
    [InlineData("uint8", "int32")]
    [InlineData("int16", "int32")]
    [InlineData("uint16", "int32")]
    [InlineData("int32", "int32")]
    [InlineData("uint32", "uint32")]
    [InlineData("int64", "int64")]
    [InlineData("uint64", "uint64")]
    [InlineData("nint", "nint")]
    [InlineData("nuint", "nuint")]
    [InlineData("float32", "float32")]
    [InlineData("float64", "float64")]
    [InlineData("decimal", "decimal")]
    public void CharWithNumericPrimitive_UsesEcmaPromotionTarget(string operandType, string resultType)
    {
        Assert.Empty(Errors($"let result {resultType} = 'A' + {operandType}(1)"));
    }

    [Theory]
    [InlineData("true")]
    [InlineData("\"x\"")]
    public void NonNumericCharOperand_StillReportsGs0129(string operand)
    {
        Assert.Contains(Errors($"let bad = 'a' - {operand}"), d => d.Id == "GS0129");
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var pe = new MemoryStream();
        return compilation.Emit(pe).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
