// <copyright file="Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2016 / issue #4223: the non-generic sibling of #1940. A NON-generic local function
/// (<c>let Name = func (...) ... {...}</c>, no <c>[T, ...]</c> of its own) that captures no outer
/// variables is hoisted to a top-level static method (issue #1469's zero-capture fast path) UNLESS
/// it is nested inside a user type purely for accessibility
/// (<c>ClosureEmitter.SynthesizeClosures</c>). Before issue #2118 / #4223, a direct reference to an
/// enclosing type parameter in the local function's OWN parameter type, return type, or body had no
/// corresponding CLR slot on that hoisted method and silently emitted invalid IL that crashed at run
/// time with <see cref="BadImageFormatException"/> — GS0468 (issue #2016) turned that into a
/// compile-time diagnostic instead of fixing the capability. Issue #4223 finishes the job:
/// <c>UserTokenResolver.TryPromoteNonCapturingGenericLambda</c> (issue #2118) now reifies every
/// referenced enclosing type parameter as an additional method type parameter of the hoisted method,
/// so these shapes compile AND run correctly — GS0468 no longer fires for them. These tests assert
/// the positive capability (correct compilation and runtime behavior, verified across multiple type
/// arguments where the shape allows it) and retain the diagnostic only for genuinely unsupported
/// shapes (a CAPTURING local function, tested separately).
/// </summary>
public class Issue2016NonGenericLocalFunctionEnclosingTypeParameterTests
{
    [Fact]
    public void NonGenericLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        var source = """
            package P

            func Outer[U](seed U) U {
                let Local = func (x U) U {
                    return x
                }
                Console.WriteLine(Local(seed))
                return seed
            }
            Outer("hi")
            Outer(42)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}42{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_VarDeclared_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // Follow-up review of #2024: the original #2016 fix's gate only fired
        // for `let`-bound locals (`syntax.Keyword?.Kind == SyntaxKind.LetKeyword`).
        // A `var`-declared local function of the exact same zero-capture shape
        // bypassed the diagnostic entirely and reproduced the ORIGINAL #2016
        // crash (compiles clean, then BadImageFormatException at run time) —
        // the emitter's zero-capture hoisting path doesn't distinguish let/var.
        // Issue #4223 makes the shape itself correct, so `var` and `let` both
        // compile and run the same way.
        var source = """
            package P

            func Outer[U](seed U) U {
                var Local = func (x U) U {
                    return x
                }
                Console.WriteLine(Local(seed))
                return seed
            }
            Outer("hi")
            Outer(42)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}42{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_ConstDeclared_ParameterReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // Same zero-capture shape via `const` — the third variable-declaration
        // keyword. The check keys off the bound initializer being a
        // BoundFunctionLiteralExpression, not the declaring keyword, so all
        // three (`let`/`var`/`const`) must be covered.
        var source = """
            package P

            func Outer[U](seed U) U {
                const Local = func (x U) U {
                    return x
                }
                Console.WriteLine(Local(seed))
                return seed
            }
            Outer("hi")
            Outer(42)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}42{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericAsyncLocalFunction_ParameterReferencesEnclosingMethodTypeParameter_StillReportsGS0468()
    {
        // Follow-up review of #2024: an earlier revision short-circuited this
        // check for `literal.Function.IsAsync`, assuming an async local
        // function's state-machine hoisting reifies the enclosing type
        // parameter safely. Verified false AT THE TIME: the zero-capture async
        // local function's kickoff method was the un-parameterized top-level
        // static method, and its synthesized state-machine struct never
        // re-declared the enclosing type parameter either.
        //
        // Issue #4223 fixes the BODY/RETURN-TYPE shape of this for real (see
        // NonGenericAsyncLocalFunction_BodyOrReturnTypeReferencesEnclosingMethodTypeParameter_RunsCorrectlyForMultipleTypes
        // below): ReflectionMetadataEmitter.RegisterStateMachineEnclosingGenerics
        // now aliases each ORIGINAL enclosing type parameter promoted by
        // TryPromoteNonCapturingGenericLambda onto the state machine's own
        // class slot (mirroring the analogous ITERATOR fix already applied by
        // RegisterGeneratedGenericRemaps).
        //
        // This exact PARAMETER-referencing shape is a different, still-unsafe
        // route: it goes through the async "erased delegate" adapter (predates
        // #2118, used whenever a function-literal's declared type mentions an
        // open type parameter), not through RegisterStateMachineEnclosingGenerics.
        // That adapter's parameter-unboxing conversion has a confirmed defect
        // for a value-typed instantiation — confirmed by direct repro: this
        // exact source, if allowed to compile, runs `Outer("hi")` successfully
        // but throws `NullReferenceException` for `Outer(42)` (identical to an
        // already-legal CAPTURING async lambda of the same shape, so the
        // adapter defect itself is pre-existing and unrelated to #4223 — but
        // relaxing GS0468 here would trade this shape's previous compile-time
        // rejection for a runtime crash on a per-instantiation basis, which the
        // issue's own guidance rules out: "Relax GS0468 only for routes with
        // proven valid emission"). GS0468 is retained for exactly this
        // combination (see LambdaBinder.CheckAsyncNonGenericLocalFunctionEnclosingTypeParameterInParameter).
        var source = """
            package P

            func Outer[U](seed U) U {
                let Local = async func (x U) U {
                    return x
                }
                return Local(seed).Result
            }
            Outer("hi")
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0468", stdout + stderr);
    }

    [Fact]
    public void NonGenericAsyncLocalFunction_BodyOrReturnTypeReferencesEnclosingMethodTypeParameter_RunsCorrectlyForMultipleTypes()
    {
        // The safe sibling of the still-rejected parameter-referencing shape
        // above: the enclosing type parameter appears only in the RETURN type
        // and the BODY (a local variable declaration), never in Local's own
        // parameter list, so this does not touch the async erased-delegate
        // adapter at all. Verified for both a reference type and a VALUE type
        // instantiation to rule out the exact defect the parameter-referencing
        // shape hits.
        var source = """
            package P

            func Outer[U](seed U) U {
                let Local = async func () U {
                    let z U = seed
                    return z
                }
                return Local().Result
            }
            Console.WriteLine(Outer("hi"))
            Console.WriteLine(Outer(42))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}42{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_ReturnTypeReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        var source = """
            package P

            func Outer[U]() U {
                let Local = func () U {
                    return default
                }
                return Local()
            }
            Console.WriteLine(Outer[string]())
            Console.WriteLine(Outer[int32]())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{Environment.NewLine}0{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_BodyReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        var source = """
            package P

            func Outer[U]() {
                let Local = func () {
                    let z U = default
                    Console.WriteLine(z)
                }
                Local()
            }
            Outer[string]()
            Outer[int32]()
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"{Environment.NewLine}0{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_ReferencesEnclosingGenericClassTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        var source = """
            package P

            class Box[U] {
                func Run(seed U) {
                    let Local = func (x U) U {
                        return x
                    }
                    Console.WriteLine(Local(seed))
                }
            }
            let b1 = Box[string]{}
            b1.Run("hi")
            let b2 = Box[int32]{}
            b2.Run(7)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}7{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_CapturesOuterVariableAndReferencesEnclosingTypeParameterInOwnParameter_CompilesAndRunsWithoutGS0468()
    {
        // A NON-generic local function that BOTH captures an outer variable
        // AND directly references an enclosing type parameter in its OWN
        // parameter type routes through ClosureEmitter's ordinary (pre-#4221)
        // capturing closure path — SynthesizeDisplayClass already reifies any
        // enclosing type parameter referenced by the literal's parameters,
        // return type, or body, regardless of capture status. Must not
        // false-positive.
        var source = """
            package P

            func Outer[U](seed U) U {
                var count = 0
                let Local = func (x U) U {
                    count = count + 1
                    return x
                }
                Console.WriteLine(Local(seed))
                return seed
            }
            Console.WriteLine(Outer("hi"))
            Console.WriteLine(Outer(7))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}hi{Environment.NewLine}7{Environment.NewLine}7{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_NoEnclosingGeneric_CompilesAndRunsWithoutGS0468()
    {
        // No enclosing generic method/class in scope at all — must not false-positive.
        var source = """
            package P

            func Foo() int32 {
                let Local = func (x int32) int32 {
                    return x
                }
                return Local(42)
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"42{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_CapturesOuterVariableOfEnclosingTypeParameterType_CompilesAndRunsWithoutGS0468()
    {
        // A local function that CAPTURES an outer variable (of the enclosing type
        // parameter's type) routes through the already-reified closure path
        // (issues #1477/#1512), not the zero-capture fast path — must not
        // false-positive.
        var source = """
            package P

            func Outer[U](seed U) U {
                let Echo = func () {
                    var z U = seed
                    Console.WriteLine(z)
                }
                Echo()
                return seed
            }
            Console.WriteLine(Outer("hi"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}hi{Environment.NewLine}", output);
    }

    [Fact]
    public void NonGenericLocalFunction_InNonGenericClassMemberReferencesEnclosingMethodTypeParameter_CompilesAndRunsWithoutGS0468()
    {
        // The zero-capture local function is nested inside a NON-generic user
        // type (for accessibility, issue #1469); that nested display class is
        // already reified over the enclosing generic method's own type
        // parameter, so this genuinely compiles and runs correctly — must not
        // false-positive.
        var source = """
            package P

            class Box {
                func Run[U](seed U) {
                    let Local = func (x U) U {
                        return x
                    }
                    Console.WriteLine(Local(seed))
                }
            }
            let b = Box{}
            b.Run("hi")
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"hi{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_2016_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            if (!expectSuccess)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.ReplaceLineEndings(Environment.NewLine), stderr.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
