// <copyright file="Issue3784NilUsingResourceTests.cs" company="GSharp">
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

/// Issue #3784: a `using` resource that is legitimately `nil` must be
/// a no-op at cleanup, exactly as C#'s
/// `using (var s = cond ? null : File.Create(p))` is. Before the fix the
/// finally block issued an unconditional `Dispose()` and the statement
/// threw a (cref:NullReferenceException) on the very path the language
/// defines as doing nothing.
///
/// This is the defect behind the migrated compiler's `GS9998`: the
/// self-migration translation of `src/Compiler/Program.cs` carries
/// `using let refStream = if string.IsNullOrEmpty(refOutputPath) {
/// default(FileStream?) } else { File.Create(refOutputPath!!) }` — three
/// such optional streams, one per `/refout`, `/pdb` and
/// `/doc` — so EVERY `gsc /out:` invocation of the MIGRATED compiler
/// faulted in the finally, whatever it was asked to compile.
///
/// Every case EXECUTES: the divergence is invisible to binding and to
/// ILVerify — the unguarded `callvirt` is perfectly verifiable IL — so
/// only running the program can see it.
open class Issue3784NilUsingResourceTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output — the only assertion that can see this
    /// class of defect.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func NilUsingResource_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3784_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(
                exit == 0,
                "'$name' must run to completion (this is the #3784 assertion; a " +
                    (`NullReferenceException here is the unguarded nil cleanup). Exit ` + "$exit" + `:
` + "$output")
            )
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The reduction of the defect: a nilable resource that IS nil.
            yield[]object{"nil-resource-is-a-no-op", `
package P
import System
import System.IO

func Run() string {
    using let s FileStream? = nil
    return "ran"
}

Console.WriteLine(Run())
`, []string{"ran"}}
            // The exact shape the migrated src/Compiler/Program.cs carries: a
            // conditional whose nil arm is spelled `default(T?)`, nested two deep
            // so the inner cleanup runs inside the outer protected region.
            yield[]object{"optional-stream-pair-both-nil", `
package P
import System
import System.IO

func Emit(refPath string?, docPath string?) string {
    using let refStream = if string.IsNullOrEmpty(refPath) { default(FileStream?) } else { File.Create(refPath!!) }
    {
        using let docStream = if string.IsNullOrEmpty(docPath) { default(FileStream?) } else { File.Create(docPath!!) }
        return "emitted"
    }
}

Console.WriteLine(Emit(nil, nil))
`, []string{"emitted"}}
            // ANTI-VACUITY: a real resource must still be disposed exactly once,
            // and the nil sibling in the same statement list must still be skipped.
            yield[]object{"real-resource-still-disposed-once", `
package P
import System
import System.IO

class Probe {
    var Count int32 = 0

    func Dispose() {
        Count = Count + 1
        Console.WriteLine("disposed")
    }
}

let probe = Probe()

func Run(p Probe) string {
    using let a = p
    {
        using let b FileStream? = nil
        return "body"
    }
}

Console.WriteLine(Run(probe))
Console.WriteLine(probe.Count.ToString())
`, []string{"disposed", "body", "1"}}
            // ANTI-VACUITY: an exception thrown inside the protected region still
            // reaches the caller, and the nil cleanup does not mask it with an NRE
            // of its own.
            yield[]object{"throw-through-a-nil-resource", `
package P
import System
import System.IO

func Boom() {
    using let s FileStream? = nil
    throw InvalidOperationException("boom")
}

try {
    Boom()
} catch (ex InvalidOperationException) {
    Console.WriteLine(ex.Message)
}
`, []string{"boom"}}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
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
