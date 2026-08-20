// <copyright file="Issue3463StringCharConcatTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #3463: native string and char concatenation.</summary>
public class Issue3463StringCharConcatTests
{
    [Fact]
    public void StringCharForms_BindWithoutDiagnostics()
    {
        const string source = """
            func F(ns string?, ch char) {
                var s = "text"
                var a = s + ch
                var b = ch + s
                var c = ns + ch
                var d = ch + ns
                s += ch
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("\"left\" + '!'", "left!")]
    [InlineData("'!' + \"right\"", "!right")]
    [InlineData("var s string? = nil\ns + 'x'", "x")]
    [InlineData("\"a\" + 'b' + 'c'", "abc")]
    public void StringCharExpressions_EmitAndRun(string source, string expected)
    {
        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(expected, result.Value);
    }

    [Fact]
    public void DirectorySeparatorChar_CompoundAssignment_EmitsAndRuns()
    {
        var result = EmittedOracle.Evaluate(
            """
            import System.IO

            var normalizedDirectory = "root"
            normalizedDirectory += Path.DirectorySeparatorChar
            normalizedDirectory
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("root" + Path.DirectorySeparatorChar, result.Value);
    }

    [Fact]
    public void ConstantStringAndCharConcat_FoldsAndEmits()
    {
        var result = EmittedOracle.Evaluate(
            """
            class Values {
                const Separator char = 'b'
                const Text string = "a" + Separator
            }

            Values.Text
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ab", result.Value);
    }

    [Fact]
    public void PropertyCompoundAssignment_EvaluatesReceiverOnce()
    {
        var result = EmittedOracle.Evaluate(
            """
            class Box {
                var value string = "a"
                prop Text string { get { return value } set { this.value = value } }
            }

            func GetBox() Box {
                calls += 1
                return box
            }

            var calls = 0
            let box = Box()
            GetBox().Text += 'x'
            "${box.Text}:$calls"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ax:1", result.Value);
    }

    [Fact]
    public void IndexerCompoundAssignment_EvaluatesReceiverAndIndexOnce()
    {
        var result = EmittedOracle.Evaluate(
            """
            import System.Collections.Generic

            func GetValues() Dictionary[int32, string] {
                receiverCalls += 1
                return values
            }

            func GetIndex() int32 {
                indexCalls += 1
                return 0
            }

            var receiverCalls = 0
            var indexCalls = 0
            let values = Dictionary[int32, string]()
            values[0] = "a"
            GetValues()[GetIndex()] += 'x'
            "${values[0]}:$receiverCalls:$indexCalls"
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("ax:1:1", result.Value);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        return Binder.BindProgram(globalScope).Diagnostics.ToImmutableArray();
    }
}
