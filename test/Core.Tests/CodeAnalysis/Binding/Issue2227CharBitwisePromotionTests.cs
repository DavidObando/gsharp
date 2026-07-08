// <copyright file="Issue2227CharBitwisePromotionTests.cs" company="GSharp">
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
/// Issue #2227: the bitwise (<c>^</c>, <c>&amp;</c>, <c>|</c>) and shift
/// (<c>&lt;&lt;</c>, <c>&gt;&gt;</c>) operators must be defined for
/// <c>char</c> operands, matching C# §12.4.7 binary numeric promotion:
/// both operands promote to <c>int32</c> and the result is <c>int32</c>.
/// Discovered migrating a constant-time-comparison idiom
/// (<c>diff |= a[i] ^ b[i]</c>, <c>a</c>/<c>b</c> strings) from C#.
/// </summary>
public class Issue2227CharBitwisePromotionTests
{
    [Fact]
    public void CharXorChar_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var b char = 'b'
var c = a ^ b
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' ^ (int)'b', vars["c"]);
    }

    [Fact]
    public void CharAndChar_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var b char = 'b'
var c = a & b
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' & (int)'b', vars["c"]);
    }

    [Fact]
    public void CharOrChar_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var b char = 'b'
var c = a | b
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' | (int)'b', vars["c"]);
    }

    /// <summary>
    /// Exercises <c>char &amp;^ char</c> (BitClear, lowered to <c>a &amp; ~b</c>),
    /// the one path that makes the <c>char ch =&gt; (char)~ch</c> unary arm in
    /// <c>Evaluator.OnesComplement</c> reachable.
    /// </summary>
    [Fact]
    public void CharBitClearChar_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var b char = 'b'
var c = a &^ b
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' & ~(int)'b', vars["c"]);
    }

    [Fact]
    public void CharShiftLeftInt32_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var c = a << 2
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' << 2, vars["c"]);
    }

    [Fact]
    public void CharShiftRightInt32_PromotesToInt32()
    {
        var (eval, vars) = EvaluateWithVariables(@"
var a char = 'a'
var c = a >> 2
");
        Assert.Empty(eval.Diagnostics);
        Assert.IsType<int>(vars["c"]);
        Assert.Equal((int)'a' >> 2, vars["c"]);
    }

    /// <summary>
    /// The exact idiom from the issue: <c>diff |= a[i] ^ b[i]</c> where
    /// <c>a</c>/<c>b</c> are strings (so <c>a[i]</c>/<c>b[i]</c> are
    /// <c>char</c>), accumulating a constant-time comparison across two
    /// equal-length strings. Verifies both that it compiles and that the
    /// runtime XOR/OR-accumulation value is correct: equal strings leave
    /// <c>diff == 0</c>, a single differing character makes it non-zero.
    /// </summary>
    [Theory]
    [InlineData("abcd", "abcd", 0)]
    [InlineData("abcd", "abcE", ('d' ^ 'E'))]
    public void ConstantTimeCompareIdiom_EvaluatesCorrectDiff(string left, string right, int expectedDiff)
    {
        var (eval, vars) = EvaluateWithVariables($@"
var a string = ""{left}""
var b string = ""{right}""
var diff int32 = 0
var i int32 = 0
while i < 4 {{
    diff |= a[i] ^ b[i]
    i += 1
}}
");
        Assert.Empty(eval.Diagnostics);
        Assert.Equal(expectedDiff, vars["diff"]);
    }

    private static (EvaluationResult Result, Dictionary<string, object> Variables) EvaluateWithVariables(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var variables = new Dictionary<VariableSymbol, object>();
        var result = compilation.Evaluate(variables);

        var namedVars = new Dictionary<string, object>();
        foreach (var kvp in variables)
        {
            namedVars[kvp.Key.Name] = kvp.Value;
        }

        return (result, namedVars);
    }

    /// <summary>
    /// Compiles the exact repro from issue #2227 to IL, loads it, and calls
    /// the compiled <c>constantTimeCompare</c> function directly (no
    /// top-level statements, no <see cref="Console"/> capture) — verifying
    /// the emitter (not just the tree-walking evaluator) produces the
    /// correct `int32` XOR-accumulated result for `char` operands sourced
    /// from string indexing. Asserting on the returned value directly
    /// avoids the process-global <c>Console.SetOut</c> state that would
    /// otherwise race with other tests under xUnit's default parallelization.
    /// </summary>
    [Fact]
    public void CompiledAndExecuted_ConstantTimeCompareIdiom_MatchesRuntimeBehavior()
    {
        var source = @"
func constantTimeCompare(a string, b string) int32 {
    var diff int32 = 0
    var i int32 = 0
    while i < 4 {
        diff |= a[i] ^ b[i]
        i += 1
    }
    return diff
}
";
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var emitResult = compilation.Emit(peStream);
        Assert.True(
            emitResult.Success,
            "compilation should succeed: " + string.Join("; ", emitResult.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(nameof(CompiledAndExecuted_ConstantTimeCompareIdiom_MatchesRuntimeBehavior), isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().First(t => t.Name == "<Program>");
            var constantTimeCompare = programType.GetMethod(
                "constantTimeCompare",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(constantTimeCompare);

            var equal = constantTimeCompare!.Invoke(null, new object[] { "abcd", "abcd" });
            var differing = constantTimeCompare.Invoke(null, new object[] { "abcd", "abcE" });

            Assert.Equal(0, equal);
            Assert.Equal('d' ^ 'E', differing);
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
