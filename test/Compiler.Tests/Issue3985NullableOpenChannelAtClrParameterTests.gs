// <copyright file="Issue3985NullableOpenChannelAtClrParameterTests.cs" company="GSharp">
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

/// Issue #3985: a `chan[T]?` with an OPEN element was refused at a
/// non-nullable imported `Channel<T>` parameter (GS0155), where the
/// same call with a CLOSED element — and a `string?` at a non-nullable
/// `string` parameter — was accepted.
/// @remarks G# does not enforce a CLR parameter's declared nullability at the call
/// site, in either control, so the rejection was not a rule being applied: it
/// was a symbolic pair reaching no rule at all. Post-#3981
/// `Conversion.TryClassifyChannelConversion` declines a nullable operand
/// deliberately and leaves the pair to the general reference rules. Those
/// rescue the CLOSED form through the #1627 arm — a checked reference
/// conversion that drops the annotation — but that arm is guarded by
/// `IsReferenceLikeTarget`, and `ChannelTypeSymbol.MakeClrType`
/// returns null the moment the element has no CLR backing, so `chan[T]`
/// was reported as NOT reference-like and the pair fell through every arm to
/// `Conversion.None`.
///
/// The fix names the channel in `IsReferenceLikeTarget`, beside the
/// slice/array arm ("CLR array references even while a same-compilation element
/// leaves their ClrType unavailable") and the delegate arm that close the
/// identical hole for `[]T` and for a named delegate. A channel is a CLR
/// class in every direction, so the omission was never defensible; a
/// closed-element channel already answered true through the `ClrType`
/// fallback, which is exactly why only the open spelling was broken.
///
/// <b>Which answer.</b> The issue allows either — accept the open form
/// like the closed one, or enforce nullability at CLR parameters generally —
/// and requires only that the two spellings agree. This takes the lenient
/// answer, because it is what the language already does at every other CLR
/// boundary (control 2's `string?`), because the alternative would be a
/// breaking change to every existing call site, and because the leniency is
/// deliberately confined to CLR boundaries: a G#-DECLARED parameter still
/// reports GS0154 for `chan[int32]?`, untouched by this fix.
///
/// Discrimination (ADR-0154): every executable case compiles against a
/// separately compiled C# library, IL-verifies, RUNS, and asserts the program's
/// own stdout with a value pushed through the constructed object and read back,
/// so a wrong direction would deadlock or print the wrong tag rather than merely
/// verify. The rejected cases hold the fix to its claim that only the
/// annotation was dropped: the direction lattice and element identity still
/// decide.
open class Issue3985NullableOpenChannelAtClrParameterTests {
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ANullableChannelAtAClrParameter_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3985_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
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

    /// Only the ANNOTATION is dropped: direction, element and the G#-declared
    /// null-safety rule all still decide, and none of these reaches the emitter
    /// (GS9998).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func OnlyTheAnnotation_IsDropped(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3985_neg_").FullName
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

        /// The C# library every case links against. Nullable annotations are
        /// ENABLED, which is what makes every parameter below genuinely
        /// non-nullable — with them off a `Channel<int>` imports as
        /// `Channel[int32]?` and the whole question disappears.
        private const LibrarySource string = (`using System;
using System.Threading.Channels;

namespace Interop;

// The three handles are observably different: only the whole channel
// and the writer can push, only the whole channel and the reader can
// take. A wrong choice prints the wrong tag or deadlocks.
public sealed class Relay<T>
{
    private readonly Channel<T> whole;

    public Relay(Channel<T> source, int tag)
    {
        whole = source;
        Kind = tag;
    }

    public int Kind { get; }

    public bool Push(T value) => whole.Writer.TryWrite(value);

    public T Take() => whole.Reader.TryRead(out var item)
        ? item
        : throw new InvalidOperationException("nothing buffered");
}

public sealed class Sink<T>
{
    private readonly ChannelWriter<T> writer;

    public Sink(ChannelWriter<T> writer, int tag)
    {
        this.writer = writer;
        Kind = tag;
    }

    public int Kind { get; }

    public bool Push(T value) => writer.TryWrite(value);
}

public sealed class Source<T>
{
    private readonly ChannelReader<T> reader;

    public Source(ChannelReader<T> reader, int tag)
    {
        this.reader = reader;
        Kind = tag;
    }

    public int Kind { get; }

    public int Count => reader.Count;
}

// A NULLABLE CLR parameter. The ` + "`" + `T? -> U?` + "`" + ` arm is guarded by
// IsReferenceLikeTarget on both underlyings, so an open channel missed
// this boundary too — and it reports whether it actually received a
// null, so the argument cannot be quietly dropped.
public sealed class Adopt<T>
{
    public Adopt(Channel<T>? maybe, int tag)
    {
        Kind = maybe is null ? -tag : tag;
    }

    public int Kind { get; }
}

public static class Strings
{
    public static int Len(string s) => s.Length;
}`)

        /// Gets the cases that must compile, verify and run: each is (name, G#
        /// consumer source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The report's repro, plus a value pushed through the constructed
            // object and read back, so the whole-channel handle is the one that
            // was really bound.
            yield[]object{"the-reported-repro-runs", `package P
import System
import Interop

func maybe[T](source chan[T]?, value T) int32 {
    let relay = Relay[T](source, 1)
    Console.WriteLine(relay.Push(value))
    Console.WriteLine(relay.Take())
    return relay.Kind
}

Console.WriteLine(maybe[int32](chan[int32](4), 41))`, []string{"True", "41", "1"}}
            // Nullability is dropped, direction is NOT: each open nullable
            // spelling still reaches its own BCL parameter and no other.
            yield[]object{"the-directional-open-nullable-spellings-reach-their-own-parameters", `package P
import System
import Interop

func sinkOf[T](w out chan[T]?, value T) int32 {
    let s = Sink[T](w, 5)
    Console.WriteLine(s.Push(value))
    return s.Kind
}

func sourceOf[T](r in chan[T]?) int32 {
    let s = Source[T](r, 6)
    Console.WriteLine(s.Count)
    return s.Kind
}

let ch = chan[int32](4)
Console.WriteLine(sinkOf[int32](ch, 9))
Console.WriteLine(sourceOf[int32](ch))`, []string{"True", "5", "1", "6"}}
            // The NULLABLE-to-nullable boundary. `Adopt[T]` declares
            // `Channel<T>?`, so no annotation has to be dropped at all — and the
            // open channel still missed it, because the `T? -> U?` arm is guarded
            // by the same `IsReferenceLikeTarget` on both underlyings. The
            // constructed object reports whether it received a null, so a dropped
            // argument would print `-9` rather than `9`.
            yield[]object{"a-nullable-open-channel-reaches-a-nullable-clr-parameter", `package P
import System
import Interop

func optOpen[T](c chan[T]?) int32 {
    return Adopt[T](c, 9).Kind
}

func optClosed(c chan[int32]?) int32 {
    return Adopt[int32](c, 10).Kind
}

let ch = chan[int32](2)
Console.WriteLine(optOpen[int32](ch))
Console.WriteLine(optClosed(ch))`, []string{"9", "10"}}
            // The DIRECTIONAL parameter with a BIDIRECTIONAL nullable source: the
            // annotation is dropped AND the D2 view applies, both at once. The
            // #3843 widening arm is what admits it, and that arm is gated by
            // `IsNominalReferenceShape` — the sibling of `IsReferenceLikeTarget`
            // with the identical `ClrType` hole, which is why the closed spelling
            // was rescued and the open one was not. Both spellings are asserted
            // side by side here, which is the agreement the issue asks for.
            yield[]object{"a-bidirectional-nullable-channel-reaches-a-directional-parameter", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func sinkOpen[T](c chan[T]?, value T) int32 {
    let s = Sink[T](c, 5)
    Console.WriteLine(s.Push(value))
    return s.Kind
}

func sinkClosed(c chan[int32]?) int32 {
    let s = Sink[int32](c, 6)
    Console.WriteLine(s.Push(3))
    return s.Kind
}

func sourcePair(c chan[Pair]?) int32 {
    return Source[Pair](c, 7).Kind
}

Console.WriteLine(sinkOpen[int32](chan[int32](4), 1))
Console.WriteLine(sinkClosed(chan[int32](4)))
Console.WriteLine(sourcePair(chan[Pair](4)))`, []string{"True", "5", "True", "6", "7"}}
            // Control (green on both sides), and the issue's own control 1: the
            // closed element was rescued by the #1627 arm all along, because its
            // `ClrType` is a real class.
            yield[]object{"control-the-closed-element-was-always-accepted", `package P
import System
import Interop

func maybeInt(source chan[int32]?) int32 {
    let relay = Relay[int32](source, 2)
    Console.WriteLine(relay.Push(7))
    Console.WriteLine(relay.Take())
    return relay.Kind
}

Console.WriteLine(maybeInt(chan[int32](4)))`, []string{"True", "7", "2"}}
            // Control (green on both sides), and the issue's own control 2: this is
            // the behaviour the open channel now matches. G# does not enforce a CLR
            // parameter's declared nullability.
            yield[]object{"control-a-nullable-reference-of-any-other-kind", `package P
import System
import Interop

func lenOf(s string?) int32 {
    return Strings.Len(s)
}

Console.WriteLine(lenOf("abc"))`, []string{"3"}}
            // Control (green on both sides since #3876): the NON-nullable open
            // channel reaches the same constructor, which is what pins the cause to
            // the nullable wrapper rather than to the open element.
            yield[]object{"control-a-non-nullable-open-channel-reaches-the-same-constructor", `package P
import System
import Interop

func certain[T](source chan[T], value T) int32 {
    let relay = Relay[T](source, 3)
    Console.WriteLine(relay.Push(value))
    return relay.Kind
}

Console.WriteLine(certain[int32](chan[int32](4), 8))`, []string{"True", "3"}}
            // Control (green on both sides): the `!!` the issue names as the
            // pre-fix remedy keeps working, so nothing depending on it breaks.
            yield[]object{"control-the-bang-bang-remedy-still-works", `package P
import System
import Interop

func viaBang[T](source chan[T]?, value T) int32 {
    let relay = Relay[T](source!!, 4)
    Console.WriteLine(relay.Push(value))
    return relay.Kind
}

Console.WriteLine(viaBang[int32](chan[int32](4), 6))`, []string{"True", "4"}}
            // A same-compilation element is the other way a channel loses its CLR
            // identity (#3982), and the nullable form of it lands on this same arm.
            yield[]object{"a-nullable-channel-over-a-same-compilation-element-reaches-the-parameter", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func maybePair(source chan[Pair]?) int32 {
    let relay = Relay[Pair](source, 12)
    Console.WriteLine(relay.Push(Pair{a: 3, b: 4}))
    Console.WriteLine(relay.Take().b)
    return relay.Kind
}

Console.WriteLine(maybePair(chan[Pair](4)))`, []string{"True", "4", "12"}}
        }

        /// Gets the cases that must stay REJECTED: each is (name, G# consumer
        /// source, a substring the diagnostics must name).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // Dropping the annotation must not drop the direction: a send-only
            // handle still cannot become a reader.
            yield[]object{"a-send-only-nullable-cannot-reach-a-reader-parameter", `package P
import System
import Interop

func bad[T](w out chan[T]?) int32 {
    let s = Source[T](w, 6)
    return s.Kind
}

Console.WriteLine(bad[int32](chan[int32](1)))`, "Source"}
            // ...nor a receive-only handle a writer.
            yield[]object{"a-receive-only-nullable-cannot-reach-a-writer-parameter", `package P
import System
import Interop

func bad[T](r in chan[T]?) int32 {
    let s = Sink[T](r, 5)
    return s.Kind
}

Console.WriteLine(bad[int32](chan[int32](1)))`, "Sink"}
            // ...nor the element. `Channel<T>` is invariant.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import Interop

func bad(source chan[string]?) int32 {
    let relay = Relay[int32](source, 1)
    return relay.Kind
}

Console.WriteLine(bad(chan[string](1)))`, "Relay"}
            // The leniency is a CLR-boundary rule and stays one: a G#-DECLARED
            // parameter still enforces nullability, exactly as it did before.
            yield[]object{"a-gsharp-declared-parameter-still-enforces-nullability", `package P
import System
import Interop

func takes(c chan[int32]) int32 {
    return 1
}

func bad(source chan[int32]?) int32 {
    return takes(source)
}

Console.WriteLine(bad(chan[int32](1)))`, "GS0154"}
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
            // A wrong channel view fails by DEADLOCKING rather than erroring, so
            // read asynchronously and bound the wait — otherwise the read is what
            // hangs and takes the whole run with it.
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
