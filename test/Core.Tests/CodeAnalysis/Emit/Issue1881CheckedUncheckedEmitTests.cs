// <copyright file="Issue1881CheckedUncheckedEmitTests.cs" company="GSharp">
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
/// Issue #1881: G# had no <c>checked</c>/<c>unchecked</c> support at all — a
/// <c>checked { }</c> statement translated (by cs2gs) to a plain block,
/// silently erasing overflow-trap semantics, and <c>checked(...)</c>/
/// <c>unchecked(...)</c> expressions had no G# equivalent whatsoever. This
/// adds the language feature to gsc itself (syntax, binding, emission,
/// interpreter) so cs2gs can translate faithfully. These tests exercise the
/// compiled (emit) backend; <see cref="GSharp.Core.Tests.CodeAnalysis.Binding.Issue1881CheckedUncheckedInterpreterTests"/>
/// exercises the interpreter and asserts the two backends agree.
/// </summary>
public class Issue1881CheckedUncheckedEmitTests
{
    [Fact]
    public void CheckedExpression_Int32Addition_OverflowThrows()
    {
        const string Source = @"package Issue1881Add
import System

func run() {
    var maxInt int32 = 2147483647
    var one int32 = 1
    var caught = ""no""
    try {
        var boom = checked(maxInt + one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881Add");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void UncheckedExpression_Int32Addition_Wraps()
    {
        const string Source = @"package Issue1881Wrap
import System

func run() {
    var maxInt int32 = 2147483647
    var one int32 = 1
    var wrapped = unchecked(maxInt + one)
    Console.WriteLine(wrapped)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881Wrap");
        Assert.Contains("-2147483648", output);
    }

    [Fact]
    public void CheckedStatement_BlockContainingOverflow_Throws()
    {
        // The exact silent-divergence shape from the issue: a `checked { }`
        // block around a plain `+` inside a try/catch(OverflowException).
        const string Source = @"package Issue1881Block
import System

func run() {
    var caught = ""no""
    checked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        try {
            var boom = maxInt + one
            Console.WriteLine(boom)
        } catch (e OverflowException) {
            caught = ""yes""
        }
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881Block");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void UncheckedStatement_BlockContainingOverflow_Wraps()
    {
        const string Source = @"package Issue1881BlockWrap
import System

func run() {
    unchecked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        var wrapped = maxInt + one
        Console.WriteLine(wrapped)
    }
}

run()
";
        var output = CompileAndRun(Source, "Issue1881BlockWrap");
        Assert.Contains("-2147483648", output);
    }

    [Fact]
    public void CheckedExpression_UnsignedInt32Addition_OverflowThrows()
    {
        const string Source = @"package Issue1881UAdd
import System

func run() {
    var maxU uint32 = 4294967295
    var one uint32 = 1
    var caught = ""no""
    try {
        var boom = checked(maxU + one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881UAdd");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void UncheckedExpression_UnsignedInt32Addition_Wraps()
    {
        const string Source = @"package Issue1881UWrap
import System

func run() {
    var maxU uint32 = 4294967295
    var one uint32 = 1
    var wrapped = unchecked(maxU + one)
    Console.WriteLine(wrapped)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881UWrap");
        Assert.Contains("0", output);
    }

    [Fact]
    public void CheckedExpression_Int64Multiplication_OverflowThrows()
    {
        const string Source = @"package Issue1881LongMul
import System

func run() {
    var big int64 = 9223372036854775807
    var two int64 = 2
    var caught = ""no""
    try {
        var boom = checked(big * two)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881LongMul");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedExpression_UInt64Subtraction_UnderflowThrows()
    {
        const string Source = @"package Issue1881ULongSub
import System

func run() {
    var zero uint64 = 0
    var one uint64 = 1
    var caught = ""no""
    try {
        var boom = checked(zero - one)
        Console.WriteLine(boom)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881ULongSub");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedExpression_NarrowingByteConversion_OverflowThrows()
    {
        const string Source = @"package Issue1881ByteNarrow
import System

func run() {
    var big int32 = 300
    var caught = ""no""
    try {
        var narrow = checked(byte(big))
        Console.WriteLine(narrow)
    } catch (e OverflowException) {
        caught = ""yes""
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881ByteNarrow");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void UncheckedExpression_NarrowingByteConversion_Truncates()
    {
        const string Source = @"package Issue1881ByteWrap
import System

func run() {
    var wide = unchecked(byte(300))
    Console.WriteLine(wide)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881ByteWrap");
        Assert.Contains("44", output);
    }

    [Fact]
    public void NestedContexts_InnermostUncheckedInsideChecked_Wraps()
    {
        const string Source = @"package Issue1881NestUnchecked
import System

func run() {
    checked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        unchecked {
            var wrapped = maxInt + one
            Console.WriteLine(wrapped)
        }
    }
}

run()
";
        var output = CompileAndRun(Source, "Issue1881NestUnchecked");
        Assert.Contains("-2147483648", output);
    }

    [Fact]
    public void NestedContexts_InnermostCheckedInsideUnchecked_Throws()
    {
        const string Source = @"package Issue1881NestChecked
import System

func run() {
    var caught = ""no""
    unchecked {
        var maxInt int32 = 2147483647
        var one int32 = 1
        try {
            checked {
                var boom = maxInt + one
                Console.WriteLine(boom)
            }
        } catch (e OverflowException) {
            caught = ""yes""
        }
    }
    Console.WriteLine(caught)
}

run()
";
        var output = CompileAndRun(Source, "Issue1881NestChecked");
        Assert.Contains("yes", output);
    }

    [Fact]
    public void CheckedExpression_FloatingPointOverflow_DoesNotThrow()
    {
        // C# float/double never trap on overflow regardless of checked context.
        const string Source = @"package Issue1881Float
import System

func run() {
    var big float64 = 1.0e308
    var ten float64 = 10.0
    var result = checked(big * ten)
    Console.WriteLine(Double.IsPositiveInfinity(result))
}

run()
";
        var output = CompileAndRun(Source, "Issue1881Float");
        Assert.Contains("True", output);
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
