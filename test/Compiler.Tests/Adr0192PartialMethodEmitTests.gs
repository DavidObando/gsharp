// <copyright file="Adr0192PartialMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// ADR-0192 / issue #4301: end-to-end emit test for partial methods. Compiles a
/// real two-file program through `gsc`, IL-verifies the emitted assembly,
/// and runs it — the bar this repo holds emit changes to, rather than asserting
/// on the syntax tree or on bind diagnostics alone.
///
/// The program deliberately mirrors the motivating `[GeneratedRegex]` shape
/// from issue #4301: a hand-written file declares an attributed, body-less
/// `static partial func` inside `shared { }`, and a second file — the
/// one ADR-0145's generator host would emit under `obj/` — supplies the
/// body. An instance partial method rides along so both member paths are
/// covered, and the program reflects over its own metadata at runtime to prove
/// the two parts collapsed into ONE method carrying the declaring part's
/// attribute.
open class Adr0192PartialMethodEmitTests {
    /// Compiles a two-file partial-method program, IL-verifies it, runs it, and
    /// asserts on both its output and the metadata it reports about itself.
    @Fact
    func PartialMethodAcrossTwoFiles_Verifies_AndEmitsOneAttributedMethod() {
        let tempDir = Directory.CreateTempSubdirectory("gs_adr0192_partial_").FullName
        try {
            let declaringPath = Path.Combine(tempDir, "Shout.gs")
            let implementingPath = Path.Combine(tempDir, "Shout.g.gs")
            File.WriteAllText(declaringPath, DeclaringPartSource)
            File.WriteAllText(implementingPath, ImplementingPartSource)
            let outPath = Path.Combine(tempDir, "PartialMethods.dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(declaringPath)
            args.Add(implementingPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            var compileExit int32
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            // One merged symbol must yield IL that verifies — the merge must not
            // have produced, say, an abstract slot on a non-abstract class or a
            // method with no body.
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(exit == 0, (`the program must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"HELLO!", "== banner ==", "Loud methods: 1", "Obsolete: 1"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// The hand-written part: attributed signatures, no bodies.
        private const DeclaringPartSource string = `package App

import System

partial class Shout {
    @Obsolete("declaring-part attribute")
    partial func Loud(text string) string;

    shared {
        partial func Banner() string;
    }
}`

        /// The generated part: bodies only, no repeated attributes.
        private const ImplementingPartSource string = (`package App

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
// one ` + "`" + `Loud` + "`" + ` method exists, and it carries the attribute that was
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
Console.WriteLine("Obsolete: ${loud!!.GetCustomAttributes(typeof(ObsoleteAttribute), false).Length}")`)

        private const RunTimeoutMilliseconds int32 = 60_000

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeoutMilliseconds) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeoutMilliseconds / 1000}s (deadlock).")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
