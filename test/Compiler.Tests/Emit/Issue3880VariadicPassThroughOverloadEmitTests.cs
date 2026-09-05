// <copyright file="Issue3880VariadicPassThroughOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3880: a single argument that already IS the variadic carrier binds
/// the candidate in NORMAL form (C# §12.6.4.2), so it ranks against the
/// carrier type, not the element type. Overload ranking used to classify that
/// argument as an expanded-form tail slot against the element type, which both
/// mis-rated the conversion and left the slot's parameter type unset, so the
/// "better conversion target" tie-break could not run: the migrated
/// <c>Cs2Gs.Tests</c> pair
/// <c>AssertBindsAgainstGsCore(printedSources ...string)</c> /
/// <c>AssertBindsAgainstGsCore(refs IReadOnlyList[string]?, printedSources ...string)</c>
/// called with one <c>[]string</c> tied and reported a spurious GS0266 where
/// C# picks the first. Pinned end to end, not merely bound, so the selected
/// overload is witnessed at runtime.
/// </summary>
public class Issue3880VariadicPassThroughOverloadEmitTests
{
    [Fact]
    public void CarrierPassThrough_PrefersTheNormalFormOverload()
    {
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            class Asserts {
                shared {
                    func Bind(printedSources ...string) int32 { return printedSources.Length }
                    func Bind(refs IReadOnlyList[string]?, printedSources ...string) int32 { return 100 + printedSources.Length }
                }
            }

            func run() {
                let printed = []string{"a", "b"}

                // Normal form: `printed` IS the carrier, so the one-parameter
                // overload wins on an identity conversion.
                Console.WriteLine(Asserts.Bind(printed))

                // Expanded form still packs into the same overload.
                Console.WriteLine(Asserts.Bind("a", "b", "c"))

                // The two-parameter overload is still reachable.
                Console.WriteLine(Asserts.Bind(nil, "a"))
            }

            run()
            """);

        Assert.Equal($"2{Environment.NewLine}3{Environment.NewLine}101{Environment.NewLine}", output);
    }

    [Fact]
    public void CarrierPassThrough_BeatsAWideningSiblingOnTheSameArity()
    {
        // The sibling is NOT variadic at the pass-through slot, so the fix must
        // rank the carrier candidate's identity conversion above the sibling's
        // implicit reference conversion rather than penalising it as expanded.
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            class Pick {
                shared {
                    func Take(values ...string) string { return "carrier" }
                    func Take(values IEnumerable[string]) string { return "sequence" }
                }
            }

            func run() {
                let arr = []string{"a"}
                Console.WriteLine(Pick.Take(arr))
                Console.WriteLine(Pick.Take("a", "b"))
            }

            run()
            """);

        Assert.Equal($"carrier{Environment.NewLine}carrier{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericCarrierPassThrough_ClosesTheCarrierBeforeRanking()
    {
        // Review finding on PR #3964, confirmed against csc: a GENERIC variadic
        // candidate declares its carrier open (`[]T`). Ranking `[]string`
        // against `[]T` classifies an identity as a reference conversion, and
        // the call is handed to a fixed sibling. C# picks the generic carrier
        // in both shapes below (verified with csc on net10.0); gsc picked
        // "sequence" and "two-param" — a SILENT wrong-overload selection that
        // bound clean, verified clean and returned the wrong answer at
        // runtime, which is why this test executes rather than asserting a
        // successful bind. The carrier is now closed through the candidate's
        // inferred substitution, exactly as the non-tail slots already were.
        var output = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic

            class Pick {
                shared {
                    func Take[T](values ...T) string { return "generic-carrier" }
                    func Take(values IEnumerable[string]) string { return "sequence" }

                    func Two[T](values ...T) string { return "generic-carrier" }
                    func Two(refs IReadOnlyList[string], values ...string) string { return "two-param" }
                }
            }

            func run() {
                let arr = []string{"a"}
                Console.WriteLine(Pick.Take(arr))
                Console.WriteLine(Pick.Two(arr))
            }

            run()
            """);

        Assert.Equal($"generic-carrier{Environment.NewLine}generic-carrier{Environment.NewLine}", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3880_overload_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            RunGsc(new[] { "/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath });
            IlVerifier.Verify(outPath);

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet")
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

            using var proc = System.Diagnostics.Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static void RunGsc(string[] args)
    {
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
