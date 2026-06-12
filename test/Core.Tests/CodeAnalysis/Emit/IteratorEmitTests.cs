// <copyright file="IteratorEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for iterator functions (ADR-0040: sequence[T] and yield).
/// </summary>
public class IteratorEmitTests
{
    [Fact]
    public void Iterator_KickoffOnly_DoesNotThrow()
    {
        // Minimal test: call the iterator but don't iterate.
        // Validates the kickoff body IL is well-formed.
        var source = @"
package IterTest
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

var n = numbers()
Console.WriteLine(""ok"")
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_KickoffOnly_DoesNotThrow));
        Assert.Contains("ok", output);
    }

    [Fact]
    public void Iterator_Sequence_EnumeratesYieldedValues()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func numbers() sequence[int32] {
    yield 1
    yield 2
    yield 3
}

for x in numbers() {
    Console.WriteLine(x)
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_Sequence_EnumeratesYieldedValues));
        Assert.Contains("1", output);
        Assert.Contains("2", output);
        Assert.Contains("3", output);
    }

    [Fact]
    public void Iterator_IEnumerable_EnumeratesYieldedValues()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func numbers() IEnumerable[int32] {
    yield 1
    yield 2
    yield 3
}

for x in numbers() {
    Console.WriteLine(x)
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_IEnumerable_EnumeratesYieldedValues));
        Assert.Contains("1", output);
        Assert.Contains("2", output);
        Assert.Contains("3", output);
    }

    [Fact]
    public void Iterator_Fib_ProducesExpectedSequence()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func fib(max int32) sequence[int32] {
    var a = 0
    var b = 1
    for a <= max {
        yield a
        a, b = b, a+b
    }
}

for x in fib(20) {
    Console.Write(x)
    Console.Write("" "")
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_Fib_ProducesExpectedSequence));
        Assert.Contains("0 1 1 2 3 5 8 13", output);
    }

    [Fact]
    public void Iterator_With_Yield_Inside_Conditional_Works()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func evens(max int32) sequence[int32] {
    var i = 0
    for i <= max {
        if i % 2 == 0 {
            yield i
        }
        i = i + 1
    }
}

for x in evens(10) {
    Console.Write(x)
    Console.Write("" "")
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_With_Yield_Inside_Conditional_Works));
        Assert.Contains("0 2 4 6 8 10", output);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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
