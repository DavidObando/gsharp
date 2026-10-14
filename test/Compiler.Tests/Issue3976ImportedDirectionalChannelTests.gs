// <copyright file="Issue3976ImportedDirectionalChannelTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3976: a directional channel in an IMPORTED signature was unusable, so
/// ADR-0174 D2's lattice stopped at the assembly boundary and a library could
/// not expose a channel in its public surface.
/// @remarks Both operands lose their type clause on the way in. A channel in
/// metadata is the BCL type the clause binds to — `chan[T]` is
/// `Channel<T>`, `out chan[T]` is `ChannelWriter<T>`,
/// `in chan[T]` is `ChannelReader<T>` — and errata 3 gives
/// `let ch = chan[T](n)` the static type of the runtime class
/// `Chan[T]`. `Conversion.TryClassifyChannelConversion` required at
/// least one side to be a `ChannelTypeSymbol`, a clause written in THIS
/// compilation, so neither side qualified and no channel conversion was
/// classified.
///
/// Why it hid for so long: `Chan[T]` and `Channel[T]` are a
/// real CLR subclass pair, so an ordinary implicit reference conversion rescued
/// every BIDIRECTIONAL case — (cref:Adr0174SuspendCrossAssemblyTests)
/// passes a constructed channel to imported `chan[int32]` parameters and
/// always has. `ChannelReader<T>` and `ChannelWriter<T>`
/// are base classes of nothing, so only the directional half broke. That file's
/// own `Reader.Take(ch in chan[int32])` / `Fill(ch out chan[int32], n)`
/// library was exercised from a C# consumer and never from a G# one, which is
/// exactly the case (cref:Cases) restores.
///
/// The fix drops the spelling test. ADR-0158 identity says `chan[T]`
/// IS `Channel<T>`, so which name the author wrote is not a fact the
/// lattice may consult; being channel-shaped on both sides is the whole
/// precondition. The lattice itself is untouched, which is what
/// (cref:RejectedCases) holds it to.
///
/// Discrimination (ADR-0154): the executable cases fail on the parent
/// commit at overload resolution (GS0159) or assignment (GS0155). The
/// bidirectional control is green on both sides and names the CLR subtyping
/// that masked the bug; the four rejected cases are red on both sides and pin
/// every edge the lattice still denies.
open class Issue3976ImportedDirectionalChannelTests {
    /// Compiles the library, compiles a G# consumer against it, IL-verifies the
    /// consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# consumer source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func AnImportedDirectionalChannel_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3976_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", Library, libPath, "/target:library")
            Assert.True(File.Exists(libPath), (`library compile failed for '` + "$name" + `':
` + "$libLog"))
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`consumer compile failed for '` + "$name" + `':
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
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

    /// Every edge the lattice denies stays denied once both operands are
    /// imported, and none of them reaches the emitter (GS9998).
    /// @param name The case name.
    /// @param source The G# consumer source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func TheLattice_StillDeniesTheseEdges(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3976_neg_").FullName
        try {
            let libPath = Path.Combine(tempDir, "Lib.dll")
            let libLog = Compile(tempDir, "Lib.gs", Library, libPath, "/target:library")
            Assert.True(File.Exists(libPath), (`library compile failed for '` + "$name" + `':
` + "$libLog"))
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The same gap against a plain C# assembly, which is where it bites an
    /// author with no G# library in sight: a `Chan[T]` reaches a
    /// `ChannelWriter<int>` parameter, and a
    /// `Channel<int>` the C# side handed back reaches one too.
    /// @remarks The library is compiled with nullable annotations ENABLED on purpose. An
    /// oblivious C# signature imports its return as `Channel[int32]?`, and
    /// a nullable source does not convert to a non-nullable channel — ordinary
    /// G# nullability, unrelated to this issue, and unchanged by it.
    @Fact
    func AConstructedChannel_ReachesACSharpChannelWriterParameter() {
        let tempDir = Directory.CreateTempSubdirectory("gs_3976_csharp_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", `package P
import System
import Interop

func run() int32 {
    var total = 0
    scope {
        let mine = chan[int32](4)
        total = total + Sink.Send(mine, 1)

        let theirs = Sink.Make(4)
        total = total + Sink.Send(theirs, 2)
        total = total + Sink.Count(theirs)
    }

    return total
}

Console.WriteLine(run())`, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), "consumer compile failed:\n" + appLog)
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the consumer must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("3", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as deadlocked.
        private const RunTimeout int32 = 60_000

        /// The library every case links against. Its `Reader` is deliberately
        /// the same shape as (cref:Adr0174SuspendCrossAssemblyTests)'s, whose
        /// directional parameters only ever had a C# consumer.
        private const Library string = `package Lib

public class Reader {
    public func Take(ch in chan[int32]) int32 {
        return <-ch
    }

    public func Fill(ch out chan[int32], n int32) {
        for i in 1 ... n + 1 {
            ch <- i
        }
    }
}

public struct Slot {
    public var sink out chan[int32]?
    public var source in chan[int32]?
    public var tag int32
}

public func produce() chan[int32] {
    return chan[int32](8)
}

public func writerOf(ch chan[int32]) out chan[int32] {
    return ch
}

public func sendOne(w out chan[int32], v int32) {
    w <- v
}

public func receiveOne(r in chan[int32]) int32 {
    return <-r
}

public func both(ch chan[int32]) int32 {
    return 100
}

public func sendStr(w out chan[string], v string) int32 {
    return 200
}`

        /// Gets the cases that must compile, verify and run: each is (name, G#
        /// consumer source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The methods ADR-0174's own cross-assembly library already declares,
            // consumed from G# for the first time. `Fill` takes `out chan[int32]`
            // and `Take` takes `in chan[int32]`; the argument is an inferred local
            // whose static type is the runtime class (errata 3), so before the fix
            // NEITHER operand was a type clause and overload resolution found no
            // candidate at all.
            yield[]object{"directional-methods-on-an-imported-class", `package P
import System
import Lib

func run() int32 {
    var got = 0
    scope {
        let ch = produce()
        let rd = Reader()
        rd.Fill(ch, 3)
        got = rd.Take(ch) + rd.Take(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"3"}}
            // Free functions, and the round trip a library exposing a channel needs:
            // a `chan[T]` RETURN comes back as `Channel<T>`, and passing it to a
            // directional parameter is the conversion that was missing.
            yield[]object{"a-channel-returned-by-a-library-flows-into-its-directional-functions", `package P
import System
import Lib

func run() int32 {
    var got = 0
    scope {
        let ch = produce()
        sendOne(ch, 6)
        got = receiveOne(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"6"}}
            // GS0520's advice taken across a boundary. The imported field type is
            // `ChannelWriter[int32]?` / `ChannelReader[int32]?`, so this is also the
            // one case whose target carries metadata nullability rather than a
            // source `?`: `TryGetChannelShape` looks through both wrapper kinds,
            // which is why the emitter arm now asks IT rather than pattern-matching
            // a `NullableTypeSymbol` over a `ChannelTypeSymbol`.
            yield[]object{"nullable-directional-fields-on-an-imported-struct", `package P
import System
import Lib

func run() int32 {
    var got = 0
    scope {
        let ch = produce()
        var s = Slot{}
        s.tag = 40
        s.sink = ch
        s.source = ch
        s.sink!! <- 2
        got = <-s.source!! + s.tag
    }

    return got
}

Console.WriteLine(run())`, []string{"42"}}
            // A directional handle the LIBRARY produced, narrowed no further: the
            // same-direction arm over two imported spellings, which used to reach
            // the emitter's unsupported-conversion throw rather than a no-op.
            yield[]object{"an-imported-directional-handle-passes-straight-through", `package P
import System
import Lib

func run() int32 {
    var got = 0
    scope {
        let ch = produce()
        let w = writerOf(ch)
        sendOne(w, 5)
        got = receiveOne(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"5"}}
            // Control, green before and after, and the reason the bug survived: a
            // BIDIRECTIONAL imported parameter is `Channel<T>`, and the runtime's
            // `Chan<T>` derives from it, so an ordinary implicit reference
            // conversion always covered this row without the lattice's help.
            yield[]object{"an-imported-bidirectional-parameter-was-never-broken", `package P
import System
import Lib

func run() int32 {
    var got = 0
    scope {
        let ch = produce()
        got = both(ch)
    }

    return got
}

Console.WriteLine(run())`, []string{"100"}}
            yield[]object{"an-explicit-downcast-from-channel-to-chan-emits-castclass", `package P
import System
import System.Threading.Channels
import Gsharp.Concurrency

let baseChannel Channel[int32] = Chan[int32](1)
let concrete = cast[Chan[int32]](baseChannel)
Console.WriteLine(concrete.IsClosed)`, []string{"False"}}
        }

        /// Gets the pairs the lattice still denies: each is (name, consumer source,
        /// the substring the failure must mention).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // `out` -> bidirectional. A `ChannelWriter<T>` cannot widen back, and
            // now that both operands are imported this is the lattice's answer
            // rather than an accident of the guard.
            yield[]object{"imported-out-does-not-widen-to-bidirectional", `package P
import System
import Lib

let ch = produce()
let w = writerOf(ch)
Console.WriteLine(both(w))`, "both"}
            // `in` -> `out`. This is what makes channel ownership checkable
            // (ADR-0174 pattern 9), so it has to survive the widening.
            yield[]object{"receive-only-does-not-become-send-only", `package P
import System
import Lib

var r in chan[int32] = produce()
Reader().Fill(r, 2)`, "Fill"}
            // A mismatched element. `Channel<T>` is invariant, and the element
            // check runs before the direction lattice.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import Lib

let ch = produce()
Console.WriteLine(sendStr(ch, "x"))`, "sendStr"}
            // Nullability is not part of the lattice: looking through a wrapper to
            // emit the view must not become looking past nil safety.
            yield[]object{"a-nullable-imported-field-does-not-convert-to-a-non-nullable-slot", `package P
import System
import Lib

let ch = produce()
var s = Slot{}
s.sink = ch
var w out chan[int32] = s.sink`, "GS0156"}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            const LibrarySource = `using System.Threading.Channels;

namespace Interop;

public static class Sink
{
    public static Channel<int> Make(int capacity) => Channel.CreateBounded<int>(capacity);

    public static int Send(ChannelWriter<int> writer, int value) => writer.TryWrite(value) ? 1 : 0;

    public static int Count(ChannelReader<int> reader) => reader.Count;
}`
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "Interop",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "Interop.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
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
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            // A wrong view emits a handle whose counterpart never completes, so
            // these programs fail by DEADLOCKING. Read asynchronously and bound the
            // wait, or the read is what hangs and takes the whole run with it.
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s (deadlock).")
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
