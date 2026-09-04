// <copyright file="Adr0176RethrowEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0176 (issue #3897): <c>rethrow</c> re-raises the exception the enclosing
/// <c>catch</c> handler is processing, emitting <c>ILOpCode.Rethrow</c> and
/// preserving the original throw site.
/// </summary>
/// <remarks>
/// <para>The evidence these tests are built to produce is a <b>stack trace</b>,
/// not a successful compile. Both <c>throw</c> and <c>rethrow</c> are valid,
/// ILVerify-clean IL that raise the same exception object — the only observable
/// difference is whether <see cref="Exception.StackTrace"/> still names the
/// frame that originally threw. So every behavioural test here has a paired
/// anti-vacuity test asserting that <c>throw e</c> in the same position still
/// <i>loses</i> that frame, plus an opcode assertion so a behavioural
/// coincidence cannot pass.</para>
/// </remarks>
public class Adr0176RethrowEmitTests
{
    // ECMA-335 III.4.24: `rethrow` is the two-byte prefixed opcode 0xFE 0x1A.
    private const byte RethrowPrefix = 0xFE;
    private const byte RethrowSuffix = 0x1A;

    // ECMA-335 III.4.31: `throw` is the single-byte opcode 0x7A.
    private const byte ThrowOpCode = 0x7A;

    /// <summary>
    /// The load-bearing test: after a <c>rethrow</c>, the exception's stack
    /// trace still names <c>deepThrow</c>, the frame that originally threw.
    /// </summary>
    [Fact]
    public void Rethrow_PreservesTheOriginalThrowSite()
    {
        const string Source = @"package RethrowPreserves
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException(""boom"")
}

func middle() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        rethrow
    }
}

try {
    middle()
} catch (outer Exception) {
    Console.WriteLine(outer.StackTrace)
}
";
        var output = CompileAndRun(Source, "RethrowPreserves");
        Assert.Contains("deepThrow", output);
        Assert.Contains("middle", output);
    }

    /// <summary>
    /// Anti-vacuity guard for <see cref="Rethrow_PreservesTheOriginalThrowSite"/>:
    /// the identical program written with <c>throw e</c> must still <i>reset</i>
    /// the trace, or "the fix" could be some unrelated reason both forms keep
    /// their frames.
    /// </summary>
    [Fact]
    public void ThrowOfCaughtVariable_StillResetsTheStackTrace()
    {
        const string Source = @"package RethrowAntiVacuity
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException(""boom"")
}

func middle() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        throw e
    }
}

try {
    middle()
} catch (outer Exception) {
    Console.WriteLine(outer.StackTrace)
}
";
        var output = CompileAndRun(Source, "RethrowAntiVacuity");
        Assert.DoesNotContain("deepThrow", output);
        Assert.Contains("middle", output);
    }

    /// <summary>
    /// The opcode assertion: <c>rethrow</c> must emit <c>ILOpCode.Rethrow</c>,
    /// not a <c>throw</c> of the caught variable that happens to behave the same
    /// way for some other reason. ILVerify cannot make this distinction — both
    /// forms are valid IL.
    /// </summary>
    [Fact]
    public void Rethrow_EmitsTheRethrowOpCode()
    {
        const string Source = @"package RethrowOpCode
import System

func middle() {
    try {
        throw InvalidOperationException(""boom"")
    } catch (e Exception) {
        rethrow
    }
}

middle()
";
        var il = EmitAndGetMethodIl(Source, "middle");
        Assert.True(ContainsRethrow(il), "the emitted body must contain the two-byte `rethrow` opcode 0xFE 0x1A.");
    }

    /// <summary>
    /// Anti-vacuity guard for the opcode assertion: <c>throw e</c> in the same
    /// position emits the single-byte <c>throw</c> and no <c>rethrow</c>.
    /// </summary>
    [Fact]
    public void ThrowOfCaughtVariable_EmitsTheThrowOpCodeAndNoRethrow()
    {
        const string Source = @"package ThrowOpCode
import System

func middle() {
    try {
        throw InvalidOperationException(""boom"")
    } catch (e Exception) {
        throw e
    }
}

middle()
";
        var il = EmitAndGetMethodIl(Source, "middle");
        Assert.False(ContainsRethrow(il), "`throw e` must not emit `rethrow`.");
        Assert.Contains(ThrowOpCode, il);
    }

    /// <summary>
    /// Nesting rule (matching the CLR and C#): a <c>rethrow</c> re-raises the
    /// exception of the <i>lexically innermost</i> enclosing catch.
    /// </summary>
    [Fact]
    public void Rethrow_InNestedCatch_RaisesTheInnerException()
    {
        const string Source = @"package RethrowNestedCatch
import System

func run() {
    try {
        throw InvalidOperationException(""outer"")
    } catch (e Exception) {
        try {
            throw ArgumentException(""inner"")
        } catch (inner Exception) {
            rethrow
        }
    }
}

try {
    run()
} catch (caught Exception) {
    Console.WriteLine(caught.Message)
}
";
        var output = CompileAndRun(Source, "RethrowNestedCatch");
        Assert.Contains("inner", output);
        Assert.DoesNotContain("outer", output);
    }

    /// <summary>
    /// A nested <c>try</c> <i>block</i> (not handler) inside a catch does not
    /// introduce a new handler, so a <c>rethrow</c> in it still re-raises the
    /// enclosing catch's exception — and still preserves its throw site.
    /// </summary>
    [Fact]
    public void Rethrow_InsideNestedTryBlockWithinCatch_RaisesTheEnclosingCatchException()
    {
        const string Source = @"package RethrowNestedTryBlock
import System

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException(""boom"")
}

func run() {
    try {
        deepThrow(3)
    } catch (e Exception) {
        try {
            rethrow
        } finally {
            Console.WriteLine(""finally-ran"")
        }
    }
}

try {
    run()
} catch (caught Exception) {
    Console.WriteLine(caught.Message)
    Console.WriteLine(caught.StackTrace)
}
";
        var output = CompileAndRun(Source, "RethrowNestedTryBlock");
        Assert.Contains("finally-ran", output);
        Assert.Contains("boom", output);
        Assert.Contains("deepThrow", output);
    }

    /// <summary>
    /// A catch handler containing an <c>await</c> is lifted out of the CLR
    /// protected region by <c>AsyncExceptionHandlerRewriter</c>, so its
    /// <c>rethrow</c> becomes <c>ExceptionDispatchInfo.Capture(e).Throw()</c> —
    /// which must still preserve the original throw site.
    /// </summary>
    [Fact]
    public void Rethrow_InAnAwaitingCatchHandler_StillPreservesTheOriginalThrowSite()
    {
        const string Source = @"package RethrowAsyncCatch
import System
import System.Threading.Tasks

func deepThrow(depth int32) {
    if depth > 0 {
        deepThrow(depth - 1)
        return
    }

    throw InvalidOperationException(""boom"")
}

async func middle() int32 {
    try {
        deepThrow(3)
    } catch (e Exception) {
        let _ = await Task.FromResult(1)
        rethrow
    }
    return 0
}

let t = middle()
try {
    t.Wait()
} catch (agg Exception) {
    Console.WriteLine(agg.InnerException!!.StackTrace)
}
";
        var output = CompileAndRun(Source, "RethrowAsyncCatch");
        Assert.Contains("deepThrow", output);
    }

    /// <summary>GS0570: a <c>rethrow</c> with no enclosing catch handler.</summary>
    [Fact]
    public void Rethrow_OutsideAnyCatchHandler_ReportsGS0570()
    {
        const string Source = @"package RethrowNoHandler
import System

func run() {
    rethrow
}

run()
";
        Assert.Contains("GS0570", CompileForDiagnostics(Source));
    }

    /// <summary>
    /// GS0570 in a lambda declared inside a catch: the lambda is emitted as its
    /// own method, so at run time it is not inside any handler.
    /// </summary>
    [Fact]
    public void Rethrow_InLambdaInsideCatch_ReportsGS0570()
    {
        const string Source = @"package RethrowInLambda
import System

func run() {
    try {
        throw InvalidOperationException(""boom"")
    } catch (e Exception) {
        let f = () -> {
            rethrow
        }
        f()
    }
}

run()
";
        Assert.Contains("GS0570", CompileForDiagnostics(Source));
    }

    /// <summary>
    /// GS0571: a <c>finally</c> nested inside the catch has already left the
    /// handler, so <c>rethrow</c> there would be unverifiable IL.
    /// </summary>
    [Fact]
    public void Rethrow_InFinallyNestedInsideCatch_ReportsGS0571()
    {
        const string Source = @"package RethrowInNestedFinally
import System

func run() {
    try {
        throw InvalidOperationException(""boom"")
    } catch (e Exception) {
        try {
            Console.WriteLine(""work"")
        } finally {
            rethrow
        }
    }
}

run()
";
        Assert.Contains("GS0571", CompileForDiagnostics(Source));
    }

    /// <summary>
    /// A <c>finally</c> with no enclosing catch at all gets the plainer GS0570,
    /// because there is no exception being handled anywhere.
    /// </summary>
    [Fact]
    public void Rethrow_InFinallyWithNoEnclosingCatch_ReportsGS0570()
    {
        const string Source = @"package RethrowBareFinally
import System

func run() {
    try {
        Console.WriteLine(""work"")
    } finally {
        rethrow
    }
}

run()
";
        Assert.Contains("GS0570", CompileForDiagnostics(Source));
    }

    private static bool ContainsRethrow(byte[] il)
    {
        for (var i = 0; i + 1 < il.Length; i++)
        {
            if (il[i] == RethrowPrefix && il[i + 1] == RethrowSuffix)
            {
                return true;
            }
        }

        return false;
    }

    private static string CompileForDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        return string.Join("; ", result.Diagnostics.Select(d => $"{d.Id} {d.Message}"));
    }

    private static byte[] EmitAndGetMethodIl(string source, string methodName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var pe = new PEReader(peStream);
        var md = pe.GetMetadataReader();
        foreach (var th in md.TypeDefinitions)
        {
            var type = md.GetTypeDefinition(th);
            foreach (var mh in type.GetMethods())
            {
                var method = md.GetMethodDefinition(mh);
                if (md.GetString(method.Name) != methodName || method.RelativeVirtualAddress == 0)
                {
                    continue;
                }

                var body = pe.GetMethodBody(method.RelativeVirtualAddress);
                return body.GetILBytes() ?? Array.Empty<byte>();
            }
        }

        Assert.Fail($"method '{methodName}' not found in emitted assembly");
        return Array.Empty<byte>();
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
            catch (TargetInvocationException tie)
            {
                Console.SetOut(stdout);
                throw new InvalidOperationException(
                    $"Entry point threw: {tie.InnerException?.GetType().Name}: {tie.InnerException?.Message}",
                    tie.InnerException);
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
