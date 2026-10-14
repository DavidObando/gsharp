// <copyright file="Issue3876ImportedConstructorOpenChannelTests.cs" company="GSharp">
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

/// Issue #3876: a `chan[T]` argument whose element type is OPEN reached no
/// imported constructor. `ChunkReader[T](source, 64)` reported GS0267 with
/// the same argument the sibling static method `Chunks.Of[T](source, 64)`
/// accepted, so ADR-0174 D10's own library had to ship a factory that existed
/// only to route around it (errata 32).
/// @remarks The report reads this as a missing CONVERSION — one probe omitting
/// what its sibling applies. It is not. An `in chan[T]` argument against
/// the `ChannelReader<T>` constructor is IDENTITY, no conversion in
/// sight, and it failed identically. The argument had no CLR shape at all:
/// `ChannelTypeSymbol.MakeClrType` returns null the moment the element has
/// no `ClrType`, and
/// `ExpressionBinder.GetEffectiveArgumentClrTypeForOverloadResolution` —
/// which carries an arm for `[]T` (#2182), `map[K, V]` (#3303),
/// `[N]T` and a symbolic tuple (#3087) — had no arm for a channel. Every
/// probe that ranks candidates on CLR shapes then abandons resolution before
/// examining a single candidate, which is why the diagnostic named no
/// constructor: none was ever looked at.
///
/// The one probe that bound is the imported extension/static path, which
/// since issue #833 falls back to
/// (cref:GSharp.Core.CodeAnalysis.Binding.MemberLookup.TryProjectErasedClrType(GSharp.Core.CodeAnalysis.Symbols.TypeSymbol,System.Type@))
/// — the one place that knows ADR-0174 D2's erasure. The fix puts the channel
/// arm in the shared projection and implements it by asking that same helper,
/// so the two probes cannot disagree again; the imported instance-method path
/// (GS0159 on the same argument) is fixed by the same arm.
///
/// Discrimination (ADR-0154): every executable case moves a value through
/// the constructed object, because an applicability fix that picked the
/// `ChannelReader<T>` overload where `Channel<T>` was
/// meant would still compile. `Relay[T]`'s three constructors are
/// observably different — only the one built from a whole channel can push, and
/// only the ones holding a reader can take — so a wrong choice prints the wrong
/// `Kind` or DEADLOCKS, which is what bounds every run.
open class Issue3876ImportedConstructorOpenChannelTests {
    /// Compiles the C# library, compiles a G# program against it, IL-verifies
    /// it, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func AnOpenElementChannelArgument_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3876_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
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

    /// The calls applicability still refuses, none of which may reach the
    /// emitter (GS9998).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func Applicability_StillRefusesTheseCalls(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3876_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
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

    shared {
        /// How long a compiled case may run before it counts as deadlocked.
        private const RunTimeout int32 = 60_000

        /// The C# library the cases link against. `Relay<T>` is
        /// deliberately shaped so the three constructors cannot be confused for one
        /// another at run time: `Kind` names the one that ran, only the
        /// `Channel<T>` and `ChannelWriter<T>` forms can
        /// `Push`, and only the `Channel<T>` and
        /// `ChannelReader<T>` forms can `Take`. This is what
        /// `Gsharp.Concurrency.ChunkReader<T>` — whose two constructors
        /// agree, one delegating to the other — cannot test.
        private const LibrarySource string = `using System.Threading.Channels;

namespace Interop;

public sealed class Relay<T>
{
    private readonly ChannelReader<T>? reader;
    private readonly ChannelWriter<T>? writer;

    public Relay(Channel<T> source, int tag)
    {
        this.reader = source.Reader;
        this.writer = source.Writer;
        this.Kind = 1;
        this.Tag = tag;
    }

    public Relay(ChannelReader<T> source, int tag)
    {
        this.reader = source;
        this.writer = null;
        this.Kind = 2;
        this.Tag = tag;
    }

    public Relay(ChannelWriter<T> sink, int tag)
    {
        this.reader = null;
        this.writer = sink;
        this.Kind = 3;
        this.Tag = tag;
    }

    public int Kind { get; }

    public int Tag { get; }

    public int Push(T value) => this.writer is not null && this.writer.TryWrite(value) ? 1 : 0;

    public T Take() => this.reader!.ReadAsync().AsTask().GetAwaiter().GetResult();
}

public sealed class WriteOnly<T>
{
    private readonly ChannelWriter<T> sink;

    public WriteOnly(ChannelWriter<T> sink) => this.sink = sink;

    public int Push(T value) => this.sink.TryWrite(value) ? 1 : 0;
}

public class OpenRelay<T>
{
    public int Adopt(Channel<T> other) => 11;

    public int Adopt(ChannelReader<T> other) => 22;

    public static int Static(Channel<T> other) => 33;
}

public static class Relays
{
    public static Relay<T> Of<T>(Channel<T> source, int tag) => new(source, tag);
}`

        /// Gets the cases that must compile, IL-verify and run: each is (name, G#
        /// source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The issue's own shape, made observable. The `Channel<T>` constructor
            // is the one that must win: it is the only one that keeps a writer, so
            // `Push` is what proves the choice, and the value is then received from
            // the ORIGINAL channel — a `ChannelReader<T>` constructor would push
            // nothing and the receive would block forever.
            yield[]object{"an-open-element-channel-reaches-an-imported-constructor", `package P
import System
import Interop

func roundTrip[T](source chan[T], value T) T {
    let relay = Relay[T](source, 7)
    Console.WriteLine(relay.Kind)
    Console.WriteLine(relay.Tag)
    Console.WriteLine(relay.Push(value))
    return <-source
}

let ch = chan[int32](4)
Console.WriteLine(roundTrip[int32](ch, 41))`, []string{"1", "7", "1", "41"}}
            // Direction is carried through the projection, so each open spelling
            // reaches its own BCL type: `out chan[T]` takes the writer constructor
            // (Kind 3) and pushes, `in chan[T]` takes the reader constructor
            // (Kind 2) and takes what was pushed. Both were GS0267 before, and both
            // are IDENTITY conversions — which is what rules out the report's
            // "a missing conversion" reading.
            yield[]object{"the-open-directional-spellings-pick-their-own-constructors", `package P
import System
import Interop

func pushOne[T](sink out chan[T], value T) int32 {
    let relay = Relay[T](sink, 5)
    Console.WriteLine(relay.Kind)
    return relay.Push(value)
}

func takeOne[T](source in chan[T]) T {
    let relay = Relay[T](source, 3)
    Console.WriteLine(relay.Kind)
    return relay.Take()
}

let ch = chan[int32](4)
Console.WriteLine(pushOne[int32](ch, 9))
Console.WriteLine(takeOne[int32](ch))`, []string{"3", "1", "2", "9"}}
            // The same hole in the imported INSTANCE-method probe, which reported
            // GS0159 on the identical argument. It is listed here because the fix
            // is one arm in the shared projection rather than a patch at the
            // constructor site: 11 is `Adopt(Channel<T>)` (not 22, the reader
            // overload) and 33 is the static, which never broke.
            yield[]object{"an-open-channel-reaches-an-imported-instance-method", `package P
import System
import Interop

func viaInstance[T](source chan[T]) int32 {
    let r = OpenRelay[T]()
    return r.Adopt(source) + OpenRelay[T].Static(source)
}

Console.WriteLine(viaInstance[int32](chan[int32](1)))`, []string{"44"}}
            // The issue's literal repro, against the real
            // `Gsharp.Concurrency.ChunkReader[T]` — and then actually read from,
            // so the constructed reader is not merely bound. Three elements are
            // sent and the first batch hands all three over at once.
            yield[]object{"the-reported-chunkreader-repro-runs", `package P
import System
import Gsharp.Concurrency

func firstBatchLength[T](source chan[T], size int32) int32 {
    var reader in chan[ReadOnlyMemory[T]] = ChunkReader[T](source, size)
    let (batch, ok) = <-reader
    if !ok {
        return -1
    }

    return batch.Length
}

let ch = chan[int32](8)
ch <- 1
ch <- 2
ch <- 3
ch.Close()
Console.WriteLine(firstBatchLength[int32](ch, 4))`, []string{"3"}}
            // A nullable open channel, spelled the way a caller spells it. `!!` is
            // the portable form here: a BARE `chan[T]?` argument is refused by the
            // conversion (GS0155) where the closed `chan[int32]?` is accepted,
            // because G# is lenient about a CLR parameter's nullability at a call
            // site and the symbolic pair reaches no rule that says so. That
            // asymmetry lives in the conversion classifier, predates this fix and
            // is untouched by it (issue #3985) — before, both spellings were
            // hidden behind the blanket GS0267 — so what is pinned here is the
            // shape that works.
            yield[]object{"a-nullable-open-channel-reaches-the-constructor-through-a-bang", `package P
import System
import Interop

func maybe[T](source chan[T]?, value T) T {
    let relay = Relay[T](source!!, 1)
    Console.WriteLine(relay.Kind)
    Console.WriteLine(relay.Push(value))
    return relay.Take()
}

Console.WriteLine(maybe[int32](chan[int32](2), 8))`, []string{"1", "1", "8"}}
            // Control, green on both sides: the identical constructor with a CLOSED
            // element. `chan[int32]` has a real `ClrType`, so the projection never
            // had to run and applicability always saw `Channel<int>`.
            yield[]object{"a-closed-element-was-never-broken", `package P
import System
import Interop

func roundTripInt(source chan[int32], value int32) int32 {
    let relay = Relay[int32](source, 7)
    Console.WriteLine(relay.Kind)
    Console.WriteLine(relay.Tag)
    Console.WriteLine(relay.Push(value))
    return <-source
}

let ch = chan[int32](4)
Console.WriteLine(roundTripInt(ch, 41))`, []string{"1", "7", "1", "41"}}
            // Control, green on both sides: the static-factory workaround the gap
            // forced on ADR-0174 D10. It binds through the one probe that already
            // consulted the shared erasure, and it must keep binding — the fix adds
            // an arm to the projection, it does not move the fallback.
            yield[]object{"the-static-factory-workaround-still-binds", `package P
import System
import Interop

func viaFactory[T](source chan[T], value T) T {
    let relay = Relays.Of[T](source, 7)
    Console.WriteLine(relay.Kind)
    Console.WriteLine(relay.Push(value))
    return <-source
}

let ch = chan[int32](4)
Console.WriteLine(viaFactory[int32](ch, 41))`, []string{"1", "1", "41"}}
            // Control, green on both sides: a USER-declared generic class with a
            // `chan[T]` constructor parameter. Its constructor is resolved against
            // G# symbols, never against CLR shapes, so it never needed the
            // projection — which is what rules out "open generics" and "the
            // constructor form" as the cause.
            yield[]object{"a-user-declared-generic-class-was-never-broken", `package P
import System
import Interop

class Holder[T] {
    var source chan[T]?
    var tag int32

    init(source chan[T], tag int32) {
        this.source = source
        this.tag = tag
    }
}

func viaUserClass[T](source chan[T]) int32 {
    let h = Holder[T](source, 5)
    return h.tag
}

Console.WriteLine(viaUserClass[int32](chan[int32](1)))`, []string{"5"}}
        }

        /// Gets the calls that must STILL be refused: each is (name, G# source, a
        /// substring the failure must name).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // Projecting an erased shape must not make everything applicable: a
            // second argument no constructor accepts is still no overload.
            yield[]object{"a-wrong-argument-type-is-still-not-applicable", `package P
import System
import Interop

func bad[T](source chan[T]) int32 {
    let relay = Relay[T](source, "x")
    return relay.Kind
}

Console.WriteLine(bad[int32](chan[int32](1)))`, "GS0267"}
            // `Channel<T>` is invariant and the erased element is `object`, so a
            // `chan[string]` argument does not satisfy `Relay[T]`'s parameter for
            // an unrelated `T`. Red on both sides: `chan[string]` has a real
            // `ClrType`, so this pair always reached resolution and was always
            // declined.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import Interop

func mismatched[T](strings chan[string]) int32 {
    let relay = Relay[T](strings, 1)
    return relay.Kind
}

Console.WriteLine(mismatched[int32](chan[string](1)))`, "GS0267"}
            // The direction lattice is not widened by being projected: a
            // receive-only handle does not reach a class whose only constructor
            // takes a writer.
            yield[]object{"receive-only-does-not-reach-a-send-only-constructor", `package P
import System
import Interop

func readerIntoWriteOnly[T](source in chan[T]) int32 {
    let sink = WriteOnly[T](source)
    return 0
}

Console.WriteLine(readerIntoWriteOnly[int32](chan[int32](1)))`, "GS0267"}
        }

        private func CompileCSharpLibrary(tempDir string) string {
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
            // Picking the wrong channel view leaves a handle whose counterpart
            // never completes, so a wrong overload fails by DEADLOCKING rather than
            // by erroring. Read asynchronously and bound the wait, or the read is
            // what hangs and takes the whole run with it.
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
