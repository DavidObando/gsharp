// <copyright file="Issue3815GenericDerivedImportedGenericBaseTests.cs" company="GSharp">
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

/// Issue #3815: inside a GENERIC class deriving from an imported generic base
/// (`class Wrap[T] : Channel[T]`), the base's inherited members must be
/// seen at the derived type's own type arguments.
///
/// The base's arguments are carried symbolically on
/// `StructSymbol.ImportedBaseType`; its reflected `ClrType` is the
/// ERASED `Channel<object>`. The inherited-member WRITE paths
/// (issues #319/#1582) reflected the member off that erased type and read its
/// type straight from metadata, with no receiver to project through, so
/// `Reader` bound as `ChannelReader[object]` and the assignment failed
/// with GS0155. The read path already projected correctly
/// (`GetInheritedClrMemberType`); the two now agree.
///
/// Every case EXECUTES and round-trips a value through the BASE-typed
/// reference, so a setter that wrote the wrong slot — or a store that type-
/// checked only because both sides had been erased to `object` — is
/// observable.
open class Issue3815GenericDerivedImportedGenericBaseTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func GenericDerivedFromImportedGenericBase_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3815_").FullName
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

    /// Asserts the guard rails: shapes the projection must NOT admit.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("RejectedCases")
    func InvalidShape_IsStillRejected(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3815_neg_").FullName
        try {
            let (exit, stdout, stderr) = Compile(tempDir, name, source)
            Assert.True(exit != 0, "'$name' must NOT compile — the #3815 projection recovers the base's real " + (`type arguments, it does not erase them.
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
            // The ClrBaseline shape: `GoChan[T] : Channel[T]` installing the
            // inner channel's reader/writer through the base's protected setters.
            yield[]object{"generic-derived-from-imported-generic-base", `
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[int32]()
let w = Wrap[int32](inner)
let asBase Channel[int32] = w
asBase.Writer.TryWrite(41)
var got = 0
if asBase.Reader.TryRead(&got) {
    Console.WriteLine((got + 1).ToString())
}
`, []string{"42"}}
            // The `this.`-qualified write is a different binder path than the bare
            // name; both must project the inherited member through the base.
            yield[]object{"generic-derived-this-qualified-write", `
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        this.Reader = inner.Reader
        this.Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[string]()
let w = Wrap[string](inner)
let asBase Channel[string] = w
asBase.Writer.TryWrite("hi")
var got = ""
if asBase.Reader.TryRead(&got) {
    Console.WriteLine(got)
}
`, []string{"hi"}}
            // The same generic definition instantiated at TWO different arguments in
            // one program: each construction must see its own T, not a shared
            // erasure.
            yield[]object{"one-generic-definition-two-instantiations", `
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let wi Channel[int32] = Wrap[int32](Channel.CreateUnbounded[int32]())
wi.Writer.TryWrite(7)
var gotI = 0
if wi.Reader.TryRead(&gotI) {
    Console.WriteLine(gotI.ToString())
}

let ws Channel[string] = Wrap[string](Channel.CreateUnbounded[string]())
ws.Writer.TryWrite("seven")
var gotS = ""
if ws.Reader.TryRead(&gotS) {
    Console.WriteLine(gotS)
}
`, []string{"7", "seven"}}
            // Reading the inherited member inside the generic derived type must
            // give `ChannelReader[T]`, not `ChannelReader[object]` — proved by
            // handing it to a T-typed local and round-tripping the value.
            yield[]object{"inherited-member-read-inside-the-generic-derived-type", `
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }

    func Echo(value T) T {
        let w ChannelWriter[T] = Writer
        let r ChannelReader[T] = Reader
        w.TryWrite(value)
        var got T
        if r.TryRead(&got) {
            return got
        }

        return value
    }
}

let w = Wrap[int32](Channel.CreateUnbounded[int32]())
Console.WriteLine(w.Echo(99).ToString())
`, []string{"99"}}
            // ANTI-VACUITY (passes on `origin/main` too, since #3813): the
            // NON-generic derived class already worked and must keep working.
            yield[]object{"non-generic-derived-from-constructed-imported-base-still-works", `
package P
import System
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
        }

        /// Gets the cases that must still be REJECTED, so the projection did not
        /// silently widen what an inherited member accepts. Each is (name, source).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // The whole point: the inherited member is `ChannelReader[T]`, so a
            // `ChannelReader[string]` must NOT be assignable to it inside
            // `Wrap[T]`. Before the fix both sides were `object`-erased, which is
            // exactly the unsound direction this could have been "fixed" into.
            yield[]object{"wrong-instantiation-still-rejected", `
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(other Channel[string]) {
        Reader = other.Reader
    }
}

Console.WriteLine("unreachable")
`}
            // ANTI-VACUITY: `protected` stays out of reach from a NON-derived type
            // (the #3813 guard rail, re-asserted for the generic shape).
            yield[]object{"protected-setter-not-reachable-from-outside", `
package P
import System
import System.Threading.Channels

func Break[T](c Channel[T]) {
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
