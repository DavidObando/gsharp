// <copyright file="IteratorTryFinallyEmitTests.cs" company="GSharp">
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
/// End-to-end emit tests for iterator functions that contain
/// <c>yield</c> statements inside <c>try</c>/<c>finally</c> blocks
/// (issue #419 — P0-3).
/// </summary>
public class IteratorTryFinallyEmitTests
{
    [Fact]
    public void Iterator_YieldInsideTryFinally_RunsFinallyAfterFullEnumeration()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
    } finally {
        Console.WriteLine(""dispose"")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_YieldInsideTryFinally_RunsFinallyAfterFullEnumeration));
        Assert.Contains("1", output);
        Assert.Contains("2", output);
        Assert.Contains("dispose", output);
        // Finally must run AFTER the last yielded value.
        var idx1 = output.IndexOf("1", StringComparison.Ordinal);
        var idx2 = output.IndexOf("2", StringComparison.Ordinal);
        var idxFinally = output.IndexOf("dispose", StringComparison.Ordinal);
        Assert.True(idx1 < idx2);
        Assert.True(idx2 < idxFinally);
    }

    [Fact]
    public void Iterator_YieldInsideTryWithCatch_IsRejected_Issue836()
    {
        // Issue #836: per C# §15.14 / ECMA-335, `yield` lexically inside
        // a `try` block that has any `catch` clause is rejected. The
        // iterator state machine cannot resume into a protected region
        // that also acts as a CLR exception-handler frame. Pure
        // try/finally remains supported.
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 10
        yield 20
    } catch (e Exception) {
        Console.WriteLine(""caught"")
    } finally {
        Console.WriteLine(""done"")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.False(result.Success, "compilation must fail when yield appears inside try with catch.");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0367");
    }

    [Fact]
    public void Iterator_NestedTryFinally_RunsBothFinallies_InCorrectOrder()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            Console.WriteLine(""inner"")
        }
    } finally {
        Console.WriteLine(""outer"")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_NestedTryFinally_RunsBothFinallies_InCorrectOrder));
        Assert.Contains("1", output);
        Assert.Contains("2", output);
        var idxInner = output.IndexOf("inner", StringComparison.Ordinal);
        var idxOuter = output.IndexOf("outer", StringComparison.Ordinal);
        Assert.True(idxInner > 0, "inner finally must run");
        Assert.True(idxOuter > 0, "outer finally must run");
        Assert.True(idxInner < idxOuter, "inner finally runs before outer finally");
    }

    [Fact]
    public void Iterator_EarlyBreak_TriggersDispose_WhichRunsFinally()
    {
        // foreach in G# desugars to a for-range loop that disposes the
        // enumerator on early exit. Break out after the first yield and
        // verify the finally still runs.
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 1
        yield 2
        yield 3
    } finally {
        Console.WriteLine(""dispose"")
    }
}

for v in gen() {
    Console.WriteLine(v)
    if v == 1 {
        break
    }
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_EarlyBreak_TriggersDispose_WhichRunsFinally));
        Assert.Contains("1", output);
        Assert.DoesNotContain("2", output);
        Assert.Contains("dispose", output);
    }

    [Fact]
    public void Iterator_NestedEarlyBreak_RunsInnerThenOuterFinally()
    {
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        try {
            yield 1
            yield 2
        } finally {
            Console.WriteLine(""inner"")
        }
    } finally {
        Console.WriteLine(""outer"")
    }
}

for v in gen() {
    Console.WriteLine(v)
    if v == 1 {
        break
    }
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_NestedEarlyBreak_RunsInnerThenOuterFinally));
        var idx1 = output.IndexOf("1", StringComparison.Ordinal);
        var idxInner = output.IndexOf("inner", StringComparison.Ordinal);
        var idxOuter = output.IndexOf("outer", StringComparison.Ordinal);
        Assert.True(idx1 >= 0);
        Assert.True(idxInner > idx1);
        Assert.True(idxOuter > idxInner);
        Assert.DoesNotContain("2", output);
    }

    [Fact]
    public void Iterator_YieldInTryFinally_ResumesAcrossYields()
    {
        // Verifies the resume path: each MoveNext must correctly re-enter
        // the protected region via the synthesized entry label and pick
        // up after the prior yield without the CLR rejecting the IL.
        var source = @"
package IterTest
import System
import System.Collections.Generic

func gen() IEnumerable[int32] {
    try {
        yield 100
        Console.WriteLine(""mid"")
        yield 200
    } finally {
        Console.WriteLine(""fin"")
    }
}

for v in gen() {
    Console.WriteLine(v)
}
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Iterator_YieldInTryFinally_ResumesAcrossYields));
        var idx1 = output.IndexOf("100", StringComparison.Ordinal);
        var idxMid = output.IndexOf("mid", StringComparison.Ordinal);
        var idx2 = output.IndexOf("200", StringComparison.Ordinal);
        var idxFin = output.IndexOf("fin", StringComparison.Ordinal);
        Assert.True(idx1 >= 0);
        Assert.True(idxMid > idx1, "user code between yields must execute");
        Assert.True(idx2 > idxMid);
        Assert.True(idxFin > idx2);
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
