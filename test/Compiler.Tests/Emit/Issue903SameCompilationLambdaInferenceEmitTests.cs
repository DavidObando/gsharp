// <copyright file="Issue903SameCompilationLambdaInferenceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #903 — an un-typed arrow lambda passed to a generic LINQ extension
/// method (<c>Single</c>/<c>Where</c>/<c>Select</c>/…) whose receiver's generic
/// element type is a <em>same-compilation</em> user type (a <c>struct</c> or
/// <c>class</c> being compiled, e.g. <c>List[Check]</c> where
/// <c>Check</c> is declared in the same source) must infer its parameter type
/// from that element symbol, resolve the call, and emit verifiable, runnable IL.
/// <para>
/// On the base compiler the lambda parameter could not be inferred because the
/// element type has no CLR <see cref="Type"/> yet (it is still being compiled),
/// so the reflection-driven inference path lost the <c>Check</c> identity and
/// reported <c>GS0159</c> (cannot find function) plus <c>GS0304</c> (cannot infer
/// lambda parameter). The fix recovers the element type <em>symbolically</em>
/// from the receiver's <c>TypeArguments</c> for parameter inference, the call's
/// return type, and the emitted MethodSpec — so a value-type element no longer
/// produces a fatal <c>unbox.any</c> over a struct value on the stack.
/// </para>
/// <para>
/// These cases all construct elements via object initializers on <c>let</c>
/// (read-only) fields. That lowering sets an init-only field outside the
/// declaring type's constructor, which ilverify flags as <c>InitOnly</c>. That
/// behaviour is a pre-existing, unrelated G# object-initializer limitation (it
/// reproduces for a plain <c>Check { Id: "x" }</c> with no LINQ at all), so the
/// verification gate ignores only that code while still catching any new IL
/// regression introduced by this fix (e.g. <c>StackObjRef</c> from a bad
/// value-type erasure).
/// </para>
/// </summary>
public class Issue903SameCompilationLambdaInferenceEmitTests
{
    [Fact]
    public void Struct_UntypedLambda_Single_InfersElementAndRuns()
    {
        // The exact issue repro: Single with an un-typed predicate whose body
        // reads a member of the same-compilation struct element.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            struct CheckSS {
                let Id string
            }

            let checks = List[CheckSS]()
            checks.Add(CheckSS { Id: "audible-api" })
            checks.Add(CheckSS { Id: "network" })

            let net = checks.Single((c) -> c.Id == "network")
            Console.WriteLine(net.Id)
            """;

        Assert.Equal("network\n", CompileAndRun(source));
    }

    [Fact]
    public void Struct_UntypedLambda_SelectProjectingToString_InfersAndRuns()
    {
        // The second issue repro: Select projecting to a different type (string)
        // so TResult is inferred from the body, then ToHashSet over the result.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            struct CheckSSel {
                let Id string
            }

            let checks = List[CheckSSel]()
            checks.Add(CheckSSel { Id: "audible-api" })
            checks.Add(CheckSSel { Id: "network" })

            let ids = checks.Select((c) -> c.Id).ToHashSet()
            Console.WriteLine(ids.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Struct_UntypedLambda_WhereThenToList_InfersAndRuns()
    {
        // Where returns IEnumerable[Check]; the chained ToList must keep the
        // Check element identity (a value-type element cannot up-cast to
        // IEnumerable<object>) and instantiate ToList<Check>.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            struct CheckSWhere {
                let Id string
            }

            let checks = List[CheckSWhere]()
            checks.Add(CheckSWhere { Id: "audible-api" })
            checks.Add(CheckSWhere { Id: "network" })

            let filtered = checks.Where((c) -> c.Id == "network").ToList()
            Console.WriteLine(filtered.Count)
            Console.WriteLine(filtered.Single((c) -> true).Id)
            """;

        Assert.Equal("1\nnetwork\n", CompileAndRun(source));
    }

    [Fact]
    public void Struct_UntypedLambda_SelectWithIndex_InfersAndRuns()
    {
        // The two-parameter (element, index) Select overload must behave like
        // the explicitly-typed parameter form.
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            struct CheckSIdx {
                let Id string
            }

            let checks = List[CheckSIdx]()
            checks.Add(CheckSIdx { Id: "audible-api" })
            checks.Add(CheckSIdx { Id: "network" })

            let indices = checks.Select((c, i) -> i).ToList()
            Console.WriteLine(indices.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Class_UntypedLambda_Single_InfersElementAndRuns()
    {
        // Reference-type element variant: the same recovery must instantiate
        // Single<Check> (the redundant erased object cast is also suppressed).
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            class CheckCS {
                let Id string
            }

            let checks = List[CheckCS]()
            checks.Add(CheckCS { Id: "audible-api" })
            checks.Add(CheckCS { Id: "network" })

            let net = checks.Single((c) -> c.Id == "network")
            Console.WriteLine(net.Id)
            """;

        Assert.Equal("network\n", CompileAndRun(source));
    }

    [Fact]
    public void Class_UntypedLambda_WhereThenToList_InfersAndRuns()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            class CheckCWhere {
                let Id string
            }

            let checks = List[CheckCWhere]()
            checks.Add(CheckCWhere { Id: "audible-api" })
            checks.Add(CheckCWhere { Id: "network" })

            let filtered = checks.Where((c) -> c.Id == "audible-api").ToList()
            Console.WriteLine(filtered.Count)
            """;

        Assert.Equal("1\n", CompileAndRun(source));
    }

    [Fact]
    public void Class_UntypedLambda_SelectProjectingToString_InfersAndRuns()
    {
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            class CheckCSel {
                let Id string
            }

            let checks = List[CheckCSel]()
            checks.Add(CheckCSel { Id: "audible-api" })
            checks.Add(CheckCSel { Id: "network" })

            let ids = checks.Select((c) -> c.Id).ToHashSet()
            Console.WriteLine(ids.Count)
            """;

        Assert.Equal("2\n", CompileAndRun(source));
    }

    [Fact]
    public void Struct_ExplicitlyTypedLambda_Single_StillRuns()
    {
        // The explicitly-typed parameter form must remain correct (and must
        // also emit Single<Check>, not a value-type-erasing object close).
        var source = """
            package P
            import System
            import System.Linq
            import System.Collections.Generic

            struct CheckSExpl {
                let Id string
            }

            let checks = List[CheckSExpl]()
            checks.Add(CheckSExpl { Id: "audible-api" })
            checks.Add(CheckSExpl { Id: "network" })

            let net = checks.Single((c CheckSExpl) -> c.Id == "network")
            Console.WriteLine(net.Id)
            """;

        Assert.Equal("network\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue903_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // Issue #903: ignore the pre-existing, unrelated InitOnly diagnostic
            // produced by object initializers on `let` fields (reproduces with no
            // LINQ at all). The gate still catches any NEW IL regression — most
            // importantly a value-type StackObjRef/StackUnexpected from a faulty
            // type-erased LINQ emit.
            IlVerifier.Verify(outPath, ignoredErrorCodes: new[] { "InitOnly" });

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore failures.
            }
        }
    }
}
