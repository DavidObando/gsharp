// <copyright file="StackTraceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Xunit;

namespace GSharp.Compiler.Tests.Acceptance;

/// <summary>
/// Phase 9 acceptance tests for the Portable PDB pipeline (#95 / #50):
/// compile a GSharp program to PE + sidecar Portable PDB, load both into
/// an isolated <see cref="AssemblyLoadContext"/>, invoke a method that
/// throws, and assert that the captured stack trace points back to the
/// original <c>.gs</c> source file at the right line. These verify the
/// end-to-end debugging contract — sequence points, document table, and
/// PE/PDB pairing — that downstream cross-language tooling depends on.
/// </summary>
public class StackTraceTests
{
    [Fact]
    public void StackTrace_SyncThrow_PointsAtThrowingLine()
    {
        var source = string.Join(
            "\n",
            new[]
            {
                "package StackTraceSync",       // line 1
                "",                              // 2
                "import System",                 // 3
                "",                              // 4
                "public func Boom() {",          // 5
                "    throw Exception(\"sync boom\")",  // 6 (throw line)
                "}",                             // 7
                string.Empty,
            });

        var trace = CompileAndCaptureThrow(source, methodName: "Boom", contextName: "sync-throw");

        AssertHasFrame(trace.StackTrace, trace.SourceFile, expectedLine: 6, methodHint: "Boom");
        Assert.Equal("sync boom", trace.Message);
    }

    [Fact]
    public void StackTrace_ThrowInsideNestedCall_PointsAtThrowSite()
    {
        // The .NET JIT is free to inline trivial leaf functions, which would
        // collapse the throwing frame into its caller's IL offset map. Padding
        // `Inner` with a few branches keeps it out of the inliner's threshold
        // so we can validate that the PDB resolves BOTH the throwing site and
        // the call site to the original source lines.
        var source = string.Join(
            "\n",
            new[]
            {
                "package StackTraceNested",      // 1
                "",                              // 2
                "import System",                 // 3
                "",                              // 4
                "func Inner(seed int32) {",        // 5
                "    var acc = 0",               // 6
                "    for i := 0; i < seed; i++ {",  // 7
                "        acc = acc + i",         // 8
                "    }",                         // 9
                "    if acc >= 0 {",             // 10
                "        throw Exception(\"deep boom: \" + acc.ToString())",  // 11
                "    }",                         // 12
                "}",                             // 13
                "",                              // 14
                "public func Outer() {",         // 15
                "    Inner(4)",                  // 16
                "}",                             // 17
                string.Empty,
            });

        var trace = CompileAndCaptureThrow(source, methodName: "Outer", contextName: "nested-throw");

        // PDB must locate at least the throw site OR the call site; both is
        // ideal but JIT inlining behavior is the runtime's prerogative. Either
        // proves the document table + sequence points round-trip correctly.
        var sourceName = Path.GetFileName(trace.SourceFile);
        var matches = Regex.Matches(trace.StackTrace, Regex.Escape(sourceName) + @"[^\n]*?(\d+)");
        var lines = matches
            .Cast<Match>()
            .Select(m => int.Parse(m.Groups[1].Value))
            .ToHashSet();

        Assert.True(
            lines.Contains(11) || lines.Contains(16),
            $"Expected stack-trace frame at {sourceName}:11 (throw) or :16 (call site). Trace:\n{trace.StackTrace}");
        Assert.StartsWith("deep boom:", trace.Message);
    }

    [Fact]
    public void StackTrace_ThrowFromForInBody_PointsAtThrowingLine()
    {
        // Exercises the for-in lowering: the throw lives inside a synthesized
        // foreach over a slice. Phase 1's Syntax-on-BoundNode threading is
        // what keeps the sequence point on the user-visible line, not on the
        // synthesized iteration header.
        var source = string.Join(
            "\n",
            new[]
            {
                "package StackTraceForIn",       // 1
                "",                              // 2
                "import System",                 // 3
                "",                              // 4
                "public func RunForIn() {",      // 5
                "    var items = []int32{1, 2, 3}",// 6
                "    for v in items {",          // 7
                "        throw Exception(\"for-in boom: \" + v.ToString())",  // 8
                "    }",                         // 9
                "}",                             // 10
                string.Empty,
            });

        var trace = CompileAndCaptureThrow(source, methodName: "RunForIn", contextName: "for-in-throw");

        AssertHasFrame(trace.StackTrace, trace.SourceFile, expectedLine: 8, methodHint: "RunForIn");
        Assert.StartsWith("for-in boom:", trace.Message);
    }

    [Fact]
    public async Task StackTrace_AsyncThrowAfterAwait_PointsAtThrowingLine()
    {
        // Exercises Phase 5 + Phase 6 (async state-machine sequence points):
        // throwing AFTER an await suspends + resumes through MoveNext. The
        // sequence-point table must restore the user-visible line on the
        // post-await path, so the captured stack trace must still cite the
        // .gs source location even though execution went through a generated
        // state-machine type.
        var source = string.Join(
            "\n",
            new[]
            {
                "package StackTraceAsync",       // 1
                "",                              // 2
                "import System",                 // 3
                "import System.Threading.Tasks", // 4
                "",                              // 5
                "public async func AsyncBoom() {",                  // 6
                "    await Task.Delay(1)",                          // 7
                "    throw Exception(\"async boom\")",          // 8
                "}",                                                 // 9
                string.Empty,
            });

        var compiled = CompileWithPdb(source, contextName: "async-throw");
        try
        {
            var method = compiled.ProgramType.GetMethod(
                "AsyncBoom",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(method);

            Exception caught = null;
            try
            {
                var task = (Task)method!.Invoke(null, parameters: null);
                Assert.NotNull(task);
                await task!;
            }
            catch (TargetInvocationException tie) when (tie.InnerException is not null)
            {
                caught = tie.InnerException;
            }
            catch (Exception ex)
            {
                caught = ex;
            }

            Assert.NotNull(caught);
            Assert.Equal("async boom", caught!.Message);
            AssertHasFrame(caught.StackTrace, compiled.SourceFile, expectedLine: 8, methodHint: "AsyncBoom");
        }
        finally
        {
            compiled.LoadContext.Unload();
            try { Directory.Delete(compiled.WorkDir, recursive: true); } catch { }
        }
    }

    private static ThrowTrace CompileAndCaptureThrow(string source, string methodName, string contextName)
    {
        var compiled = CompileWithPdb(source, contextName);
        try
        {
            var method = compiled.ProgramType.GetMethod(
                methodName,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(method);

            try
            {
                method!.Invoke(null, parameters: null);
            }
            catch (TargetInvocationException tie) when (tie.InnerException is not null)
            {
                return new ThrowTrace(
                    tie.InnerException.Message,
                    tie.InnerException.StackTrace ?? string.Empty,
                    compiled.SourceFile);
            }
            catch (Exception ex)
            {
                return new ThrowTrace(ex.Message, ex.StackTrace ?? string.Empty, compiled.SourceFile);
            }

            throw new Xunit.Sdk.XunitException(
                $"Method '{methodName}' returned without throwing.");
        }
        finally
        {
            compiled.LoadContext.Unload();
            try { Directory.Delete(compiled.WorkDir, recursive: true); } catch { }
        }
    }

    private static CompiledProgram CompileWithPdb(string source, string contextName)
    {
        var workDir = Directory.CreateTempSubdirectory($"gs_stacktrace_{contextName}_").FullName;
        var srcPath = Path.Combine(workDir, $"{contextName}.gs");
        var asmPath = Path.Combine(workDir, $"{contextName}.dll");
        var pdbPath = Path.ChangeExtension(asmPath, ".pdb");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + asmPath,
                "/target:library",
                "/targetframework:net10.0",
                "/debug:portable",
                "/pdb:" + pdbPath,
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
        IlVerifier.Verify(asmPath, ignoredErrorCodes: IlVerifier.KnownIssues.AsyncStateMachine);
        Assert.True(File.Exists(asmPath), $"missing PE: {asmPath}");
        Assert.True(File.Exists(pdbPath), $"missing PDB: {pdbPath}");

        var peBytes = File.ReadAllBytes(asmPath);
        var pdbBytes = File.ReadAllBytes(pdbPath);

        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        using var peStream = new MemoryStream(peBytes);
        using var pdbStream = new MemoryStream(pdbBytes);
        var asm = loadContext.LoadFromStream(peStream, pdbStream);

        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);

        return new CompiledProgram(loadContext, programType!, srcPath, workDir);
    }

    private static void AssertHasFrame(string stackTrace, string sourceFile, int expectedLine, string methodHint)
    {
        Assert.False(string.IsNullOrEmpty(stackTrace), "stack trace was empty — was the PDB attached?");

        // The CLR formats stack frames as " in <path>:line <N>" (culture-invariant
        // "line " literal in en-US; localized in other locales). Match the
        // shape "<file>:line <number>" with the source path appearing somewhere
        // on the same line — we don't tie ourselves to the exact culture
        // formatting.
        var sourceName = Path.GetFileName(sourceFile);
        var pattern = new Regex(
            Regex.Escape(sourceName) + @"[^\n]*?(\d+)",
            RegexOptions.CultureInvariant);

        var matched = false;
        foreach (Match m in pattern.Matches(stackTrace))
        {
            if (int.TryParse(m.Groups[1].Value, out var line) && line == expectedLine)
            {
                matched = true;
                break;
            }
        }

        Assert.True(
            matched,
            $"Expected stack-trace frame for {sourceName}:{expectedLine} (method '{methodHint}'). Full trace:\n{stackTrace}");
    }

    private sealed record CompiledProgram(
        AssemblyLoadContext LoadContext,
        Type ProgramType,
        string SourceFile,
        string WorkDir);

    private sealed record ThrowTrace(string Message, string StackTrace, string SourceFile);
}
