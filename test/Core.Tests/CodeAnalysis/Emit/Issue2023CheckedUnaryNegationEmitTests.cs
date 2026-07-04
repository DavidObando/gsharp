// <copyright file="Issue2023CheckedUnaryNegationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #2023: follow-up to #1881 — unary negation (<c>-x</c>) did not honor
/// a <c>checked</c> context at all: the emitter always emitted the plain
/// <c>neg</c> opcode (2's-complement negation, which silently wraps
/// <c>MinValue</c> back to itself) regardless of context. These tests
/// exercise the compiled (emit) backend; <see
/// cref="GSharp.Core.Tests.CodeAnalysis.Binding.Issue2023CheckedUnaryNegationInterpreterTests"/>
/// exercises the interpreter and asserts the two backends agree.
/// </summary>
public class Issue2023CheckedUnaryNegationEmitTests
{
    [Fact]
    public void CheckedNegation_Int32MinValue_Throws()
    {
        const string Source = @"package Issue2023Int32
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var caught = ""no""
    try {
        var boom = checked(-minInt)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Int32");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedNegation_Int64MinValue_Throws()
    {
        const string Source = @"package Issue2023Int64
import System

func run() {
    var minLong int64 = -9223372036854775807 - 1
    var caught = ""no""
    try {
        var boom = checked(-minLong)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Int64");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedNegation_Int8MinValue_Throws()
    {
        const string Source = @"package Issue2023Int8
import System

func run() {
    var minI8 int8 = -128
    var caught = ""no""
    try {
        var boom = checked(-minI8)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Int8");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedNegation_Int16MinValue_Throws()
    {
        const string Source = @"package Issue2023Int16
import System

func run() {
    var minI16 int16 = -32768
    var caught = ""no""
    try {
        var boom = checked(-minI16)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Int16");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedNegation_OrdinaryValue_ReturnsNegated()
    {
        const string Source = @"package Issue2023Ordinary
import System

func run() {
    var five int32 = 5
    var negated = checked(-five)
    Console.WriteLine(negated)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Ordinary");
        Assert.Contains("-5", output);
    }

    [Fact]
    public void UncheckedNegation_Int32MinValue_Wraps()
    {
        const string Source = @"package Issue2023Unchecked
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var wrapped = unchecked(-minInt)
    Console.WriteLine(wrapped)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Unchecked");
        Assert.Contains("-2147483648", output);
    }

    [Fact]
    public void DefaultContext_NegationOfInt32MinValue_Wraps()
    {
        // Issue #1881 established unchecked as the project default when no
        // explicit checked/unchecked context is in scope; negation must match.
        const string Source = @"package Issue2023Default
import System

func run() {
    var minInt int32 = -2147483647 - 1
    var wrapped = -minInt
    Console.WriteLine(wrapped)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Default");
        Assert.Contains("-2147483648", output);
    }

    [Fact]
    public void CheckedNegation_Float64_NoOverflowEverOccurs()
    {
        const string Source = @"package Issue2023Float
import System

func run() {
    var big float64 = -1.7976931348623157e308
    var negated = checked(-big)
    Console.WriteLine(negated)
}

run()
";
        var output = CompileAndRun(Source, "Issue2023Float");
        Assert.Contains("1.7976931348623157E+308", output);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
