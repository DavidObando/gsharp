// <copyright file="Adr0192PartialMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0192 / issue #4301: end-to-end emit test for partial methods. Compiles a
/// real two-file program through <c>gsc</c>, IL-verifies the emitted assembly,
/// and runs it — the bar this repo holds emit changes to, rather than asserting
/// on the syntax tree or on bind diagnostics alone.
/// <para>
/// The program deliberately mirrors the motivating <c>[GeneratedRegex]</c> shape
/// from issue #4301: a hand-written file declares an attributed, body-less
/// <c>static partial func</c> inside <c>shared { }</c>, and a second file — the
/// one ADR-0145's generator host would emit under <c>obj/</c> — supplies the
/// body. An instance partial method rides along so both member paths are
/// covered, and the program reflects over its own metadata at runtime to prove
/// the two parts collapsed into ONE method carrying the declaring part's
/// attribute.
/// </para>
/// </summary>
public class Adr0192PartialMethodEmitTests
{
    /// <summary>The hand-written part: attributed signatures, no bodies.</summary>
    private const string DeclaringPartSource = """
        package App

        import System

        partial class Shout {
            @Obsolete("declaring-part attribute")
            partial func Loud(text string) string;

            shared {
                partial func Banner() string;
            }
        }
        """;

    /// <summary>The generated part: bodies only, no repeated attributes.</summary>
    private const string ImplementingPartSource = """
        package App

        import System

        partial class Shout {
            partial func Loud(text string) string {
                return text.ToUpperInvariant() + "!"
            }

            shared {
                partial func Banner() string {
                    return "== banner =="
                }
            }
        }

        let s = Shout()
        Console.WriteLine(s.Loud("hello"))
        Console.WriteLine(Shout.Banner())

        // Prove the merge happened in METADATA, not just in behaviour: exactly
        // one `Loud` method exists, and it carries the attribute that was
        // written only on the declaring part.
        let t = typeof(Shout)
        var loudCount = 0
        for m in t.GetMethods() {
            if m.Name == "Loud" {
                loudCount = loudCount + 1
            }
        }

        Console.WriteLine("Loud methods: ${loudCount}")
        let loud = t.GetMethod("Loud")
        Console.WriteLine("Obsolete: ${loud.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length}")
        """;

    /// <summary>
    /// Compiles a two-file partial-method program, IL-verifies it, runs it, and
    /// asserts on both its output and the metadata it reports about itself.
    /// </summary>
    [Fact]
    public void PartialMethodAcrossTwoFiles_Verifies_AndEmitsOneAttributedMethod()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_adr0192_partial_").FullName;
        try
        {
            var declaringPath = Path.Combine(tempDir, "Shout.gs");
            var implementingPath = Path.Combine(tempDir, "Shout.g.gs");
            File.WriteAllText(declaringPath, DeclaringPartSource);
            File.WriteAllText(implementingPath, ImplementingPartSource);
            var outPath = Path.Combine(tempDir, "PartialMethods.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(declaringPath);
            args.Add(implementingPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            int compileExit;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            // One merged symbol must yield IL that verifies — the merge must not
            // have produced, say, an abstract slot on a non-abstract class or a
            // method with no body.
            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"the program must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();

            Assert.Equal(
                new[]
                {
                    "HELLO!",
                    "== banner ==",
                    "Loud methods: 1",
                    "Obsolete: 1",
                },
                lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private const int RunTimeoutMilliseconds = 60_000;

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeoutMilliseconds))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeoutMilliseconds / 1000}s (deadlock).");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
