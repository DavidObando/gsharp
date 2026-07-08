// <copyright file="Issue2226EnumZeroLiteralComparisonTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2226: `==` / `!=` between an enum type and the integer literal `0`
/// previously reported GS0129 ("Binary operator '!=' is not defined for
/// types 'System.IO.UnixFileMode' and 'int32'"), blocking the common
/// bitwise-flag-test idiom `(flags &amp; Bit) != 0` — the `&amp;` of two
/// same-typed flags enums already produced an enum-typed result (per the
/// existing <see cref="GSharp.Core.CodeAnalysis.Binding.EnumOperatorTable"/>
/// bitwise arm), but comparing that result against `0` had no adaptation.
/// Per C# §10.2.4, the literal `0` (and only `0`) implicitly converts to any
/// enum type without a cast, so `enum == 0` / `enum != 0` (either operand
/// order) is now accepted for both source-declared G# enums and imported CLR
/// (including `[Flags]`) enums; any other integer literal/constant against an
/// enum is still rejected, matching C#.
/// </summary>
public class Issue2226EnumZeroLiteralComparisonTests
{
    // ── source-declared G# enum ────────────────────────────────────────

    [Fact]
    public void SourceEnum_NotEqualsZero_Binds()
    {
        var source = @"
enum Color { Red, Green, Blue }
let c = Color.Red
c != 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value); // Red == 0
    }

    [Fact]
    public void SourceEnum_EqualsZero_Binds()
    {
        var source = @"
enum Color { Red, Green, Blue }
let c = Color.Green
c == 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value); // Green == 1
    }

    [Fact]
    public void ZeroEqualsSourceEnum_ReversedOperandOrder_Binds()
    {
        var source = @"
enum Color { Red, Green, Blue }
let c = Color.Red
0 == c
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ZeroNotEqualsSourceEnum_ReversedOperandOrder_Binds()
    {
        var source = @"
enum Color { Red, Green, Blue }
let c = Color.Blue
0 != c
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    // ── imported CLR [Flags] enum ───────────────────────────────────────

    [Fact]
    public void ImportedFlagsEnum_NotEqualsZero_Binds()
    {
        var source = @"
import System

let m = ConsoleModifiers.Alt
m != 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImportedFlagsEnum_EqualsZero_Binds()
    {
        var source = @"
import System

let m = ConsoleModifiers.None
m == 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImportedUnixFileMode_NotEqualsZero_Binds()
    {
        var source = @"
import System.IO

let mode = UnixFileMode.UserRead
mode != 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    // ── the actual flags-check idiom: `(flags & Bit) != 0` ──────────────

    [Fact]
    public void FlagsMaskIdiom_BitSet_EvaluatesTrue()
    {
        var source = @"
import System

let m = ConsoleModifiers.Alt | ConsoleModifiers.Shift
let bit = m & ConsoleModifiers.Alt
bit != 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void FlagsMaskIdiom_BitNotSet_EvaluatesFalse()
    {
        var source = @"
import System

let m = ConsoleModifiers.Alt | ConsoleModifiers.Shift
let bit = m & ConsoleModifiers.Control
bit != 0
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(false, result.Value);
    }

    // ── non-zero integer literals against an enum still error ──────────

    [Fact]
    public void SourceEnum_EqualsNonZeroLiteral_StillReportsGS0129()
    {
        var source = @"
enum Color { Red, Green, Blue }
let c = Color.Red
c == 1
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("GS0129", System.StringComparison.Ordinal)
            || d.Message.Contains("is not defined for types", System.StringComparison.Ordinal));
    }

    // ── compiled + executed idiom, using the natural `(flags & Bit) != 0`
    //    shape as written inside a function body (parenthesized inline,
    //    matching the exact idiom migrated from C#) ──────────────────────

    [Fact]
    public void CompiledAndExecuted_FlagsMaskIdiom_MatchesRuntimeBehavior()
    {
        var source = @"
import System

func hasAlt(m ConsoleModifiers) bool {
    return (m & ConsoleModifiers.Alt) != 0
}

Console.WriteLine(hasAlt(ConsoleModifiers.Alt | ConsoleModifiers.Shift))
Console.WriteLine(hasAlt(ConsoleModifiers.Shift | ConsoleModifiers.Control))
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(CompiledAndExecuted_FlagsMaskIdiom_MatchesRuntimeBehavior), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().First(t => t.Name == "<Program>");
            var entry = programType.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            var lines = captured.ToString().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            Assert.Equal(new[] { "True", "False" }, lines);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(syntaxTree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
