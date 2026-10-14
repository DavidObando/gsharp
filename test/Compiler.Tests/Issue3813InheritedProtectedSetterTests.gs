// <copyright file="Issue3813InheritedProtectedSetterTests.cs" company="GSharp">
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

/// Issue #3813: a G# class deriving from an imported CLR base may write that
/// base's `protected` property, exactly as C# does.
///
/// `ClrMemberVisibility` (issue #3705) admits only `public` and
/// friend-`internal` accessors, and every write path routed its
/// settable-ness question through it — including the paths whose own comments
/// promise inherited `protected` members (issues #319/#1582, which already
/// delivered it for `protected` <em>fields</em>). A
/// `{ get; protected set; }` base property was therefore reported
/// `GS0127 "read-only and cannot be assigned to"` inside the derived type's
/// own constructor.
///
/// This is one of the two errors walling
/// `bench/concurrency/clr/ClrBaseline` out of the issue #3501
/// self-migration gate: its `GoChan<T> : Channel<T>` constructor
/// writes `Reader` and `Writer`, whose setters
/// `System.Threading.Channels.Channel<T>` declares
/// `protected`.
///
/// Every case EXECUTES. Binding alone cannot see whether the emitted
/// `call`/`callvirt` to a `family` setter is the right slot, and
/// a wrong one is still verifiable IL; only running the program observes the
/// value that was actually stored.
open class Issue3813InheritedProtectedSetterTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func InheritedProtectedSetter_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3813_").FullName
        try {
            let outPath = CompileOrThrow(tempDir, name, source)
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
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

    /// Asserts the guard rails: writes the fix must NOT have opened up.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("RejectedCases")
    func UnreachableSetter_IsStillRejected(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3813_neg_").FullName
        try {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit != 0, "'$name' must NOT compile — the #3813 widening is scoped to inherited " + (`protected accessors on the derived type's own base.
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The ClrBaseline shape, reduced: a derived channel installs its own
            // reader/writer through the base's `protected set` accessors, and the
            // value written must be observable through the BASE-typed reference —
            // i.e. the setter really wrote the base's backing slot.
            yield[]object{"protected-setter-through-bare-name", `
package P
import System
import System.Threading
import System.Threading.Channels

class Wrap : Channel[int32] {
    init(inner Channel[int32]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[int32]()
let w = Wrap(inner)
let asBase Channel[int32] = w
asBase.Writer.TryWrite(41)
var got = 0
if asBase.Reader.TryRead(&got) {
    Console.WriteLine((got + 1).ToString())
}
`, []string{"42"}}
            // The `this.`-qualified spelling takes a different binder path than the
            // bare name; both must agree.
            yield[]object{"protected-setter-through-this", `
package P
import System
import System.Threading
import System.Threading.Channels

class Wrap : Channel[string] {
    init(inner Channel[string]) {
        this.Reader = inner.Reader
        this.Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[string]()
let w = Wrap(inner)
let asBase Channel[string] = w
asBase.Writer.TryWrite("hi")
var got = ""
if asBase.Reader.TryRead(&got) {
    Console.WriteLine(got)
}
`, []string{"hi"}}
        }

        /// Gets the cases that must still be REJECTED, so the fix widens exactly
        /// the inherited-protected hole and nothing else. Each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // ANTI-VACUITY: a genuinely get-only inherited property is still
            // read-only. `Task.IsCompleted` has no setter at all.
            yield[]object{"get-only-inherited-property-still-rejected", `
package P
import System
import System.Threading.Tasks

class Bad : TaskCompletionSource {
    func Break() {
        this.Task = nil
    }
}

Console.WriteLine("unreachable")
`}
            // ANTI-VACUITY: `protected` stays out of reach from a NON-derived type.
            // The widening is keyed on the inherited-base write paths only.
            yield[]object{"protected-setter-not-reachable-from-outside", `
package P
import System
import System.Threading.Channels

func Break(c Channel[int32]) {
    c.Reader = nil
}

Console.WriteLine("unreachable")
`}
        }

        private func CompileOrThrow(tempDir string, name string, source string) string {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit == 0, (`gsc failed for '` + "$name" + `':
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return Path.Combine(tempDir, name + ".dll")
        }

        private func Compile(tempDir string, name string, source string)(Exit int32, Stdout string, Stderr string) {
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
            try {
                return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
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
