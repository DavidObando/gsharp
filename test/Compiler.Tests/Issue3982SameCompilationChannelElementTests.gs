// <copyright file="Issue3982SameCompilationChannelElementTests.cs" company="GSharp">
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

/// Issue #3982: a C#-authored generic method over a `ChannelReader<T>`
/// or `ChannelWriter<T>` was invisible whenever the channel's element
/// was declared in the CURRENT compilation — `chan[Pair]` for a G#
/// `struct Pair` — although the identical call over `chan[int32]` had
/// bound since #3877.
/// @remarks Applicability ranks imported candidates on CLR shapes, and a
/// same-compilation element has none: `MemberLookup.TryProjectErasedClrType`
/// presents `Pair` as `System.Object`, so the candidate closes to
/// `CountSoFar<object>(ChannelReader<object>)`. Every other
/// structural shape survives that erasure because the CLR relation still holds
/// at the erased level — `[]Pair` presents as `object[]`, which really
/// does convert to the `IEnumerable<object>` formal LINQ's
/// `Count[TSource]` closes to, which is why the issue's own
/// `[]Pair{…}.Count()` control passed. A channel's only implicit
/// non-identity relation is the ADR-0174 D2 direction lattice, which lives in
/// `Conversion` and demands element IDENTITY, so the applicability probe
/// compared the REAL `chan[Pair]` against the ERASED
/// `ChannelReader[object]`, the elements differed, and the candidate was
/// dropped: GS0159 in receiver position, in argument position, and with an
/// explicit type argument alike.
///
/// Three probes had to learn the same thing, which is why the failure
/// survived #3877 and #3976:
///
/// 1. <b>Applicability.</b> `ChannelViewAppliesAtErasedShape` asks the SAME lattice about the source
/// projected to the erasure the target already carries, so the comparison is like-for-like. Shared by
/// the argument check and the extension-receiver check, so the two can no longer disagree.
/// 2. <b>Symbolic inference.</b> `MemberLookup.UnifyForMethodTypeArgs`'s D2 arm demanded that the
/// actual be a `ChannelTypeSymbol` — a type CLAUSE — and that its direction name the formal's open
/// definition EXACTLY. Errata 3 gives `chan[T](n)` the static type of the runtime class `Chan[T]`,
/// which is neither. It now recognises every channel shape and stays direction-blind, word for word
/// like its CLR twin in `ClrOverloadResolution.UnifyForInference` (#3877).
/// 3. <b>Argument conversion.</b> With `T` recovered as `Pair` the emitted MethodSpec wants a
/// `ChannelReader<Pair>`, but `BindClrParameterConversions` still converted against the erased
/// `ChannelReader[object]` — the lattice refused it, no conversion node was produced, and the raw
/// `Chan<Pair>` was pushed with no `get_Reader` in sight (ilverify StackUnexpected, SIGSEGV at run
/// time). The #1819 slot recovery now fires for a channel whose element is the same-compilation type
/// that erased the slot.
///
/// Discrimination (ADR-0154): every executable case compiles against a
/// separately compiled C# library, IL-verifies, RUNS, and asserts the program's
/// own stdout with a value moved THROUGH the bound member, so picking a reader
/// where a writer was meant is observably wrong rather than merely IL-clean.
/// The rejected cases are red on both sides and hold the fix to its claim that
/// the lattice, not the erasure, still decides.
open class Issue3982SameCompilationChannelElementTests {
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ASameCompilationChannelElement_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3982_").FullName
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

    /// An erasure-tolerant applicability probe must not become a permissive
    /// lattice: each of these is refused, and none of them reaches the emitter
    /// (GS9998).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func TheLattice_StillDecidesApplicability(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3982_neg_").FullName
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

        /// The C# library every case links against. Compiled with nullable
        /// annotations ENABLED on purpose: an oblivious signature imports a
        /// `Channel<int>` as `Channel[int32]?`, and that is ordinary
        /// G# nullability, unrelated to this issue.
        private const LibrarySource string = (`using System;
using System.Threading.Channels;

namespace Interop;

public static class ReaderExtensions
{
    // The issue's own extension, verbatim.
    public static int CountSoFar<T>(this ChannelReader<T> reader) => reader.Count;

    // Moves a value THROUGH the reader view, so a wrong element or a
    // wrong direction is observable in stdout and not only in the IL.
    public static T TakeFirst<T>(this ChannelReader<T> reader)
        => reader.TryRead(out var item)
            ? item
            : throw new InvalidOperationException("nothing buffered");

    // A reader extension over a DIFFERENT element, for invariance.
    public static int TakeTextLength(this ChannelReader<string> reader)
        => reader.TryRead(out var item) ? item.Length : -1;

    // Nothing to do with channels.
    public static int Unrelated(this string text) => text.Length;
}

public static class WriterExtensions
{
    // ` + "`" + `T` + "`" + ` is reachable ONLY from the receiver: the value arrives boxed,
    // so a reader/writer confusion cannot be papered over by the
    // argument.
    public static int PushBoxed<T>(this ChannelWriter<T> writer, object value)
        => writer.TryWrite((T)value) ? 1 : 0;
}

public static class StaticProbes
{
    // The same conversion in plain ARGUMENT position.
    public static int CountOf<T>(ChannelReader<T> reader) => reader.Count;

    public static int PushOf<T>(ChannelWriter<T> writer, object value)
        => writer.TryWrite((T)value) ? 1 : 0;
}

// The CONSTRUCTOR form. A generic class's constructor is not a
// MethodInfo, so it reaches a different slot-recovery path than the
// extension and static cases above (#3876's family, with a
// same-compilation element instead of an open one).
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

public static class ObjectProbes
{
    // NOT generic: ` + "`" + `object` + "`" + ` here is a genuine element, not an erasure.
    // A ` + "`" + `chan[Pair]` + "`" + ` must never reach it.
    public static int CountObjectReader(ChannelReader<object> reader) => reader.Count;
}

// The review's overload set: a genuine ` + "`" + `object` + "`" + ` overload declared
// BESIDE the generic one. The two return observably different values,
// so a wrong winner prints 9xx where 1xx was required.
public static class Overloaded
{
    public static int Pick<T>(ChannelReader<T> reader) => 100 + reader.Count;

    public static int Pick(ChannelReader<object> reader) => 900 + reader.Count;
}

public static class OverloadedExtensions
{
    public static int PickOn<T>(this ChannelReader<T> reader) => 100 + reader.Count;

    public static int PickOn(this ChannelReader<object> reader) => 900 + reader.Count;
}`)

        /// Gets the cases that must compile, verify and run: each is (name, G#
        /// consumer source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The report's three failing lines, verbatim, plus a value moved
            // through the reader view so a wrong element would print the wrong
            // field rather than merely verify.
            yield[]object{"the-reported-repro-binds-on-a-same-compilation-element", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](4)
ch <- Pair{a: 11, b: 22}
Console.WriteLine(ch.CountSoFar())
Console.WriteLine(ch.CountSoFar[Pair]())
Console.WriteLine(StaticProbes.CountOf(ch))
let taken = ch.TakeFirst()
Console.WriteLine(taken.a)
Console.WriteLine(taken.b)
Console.WriteLine(ch.CountSoFar())`, []string{"1", "1", "1", "11", "22", "0"}}
            // The writer half. `PushBoxed[T]` recovers `T` only from the receiver,
            // so the unbox-any it performs is wrong unless `T` really is `Pair`.
            yield[]object{"a-writer-extension-binds-on-a-same-compilation-element", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](4)
Console.WriteLine(ch.PushBoxed(Pair{a: 33, b: 44}))
Console.WriteLine(StaticProbes.PushOf(ch, Pair{a: 55, b: 66}))
let first = ch.TakeFirst()
let second = ch.TakeFirst()
Console.WriteLine(first.a)
Console.WriteLine(second.b)`, []string{"1", "1", "33", "66"}}
            // The CONSTRUCTOR form of the same gap: `Sink[Pair](ch, 5)` takes a
            // `ChannelWriter[T]`, so the bidirectional argument must be VIEWED, and
            // the view is exactly what the erasure hid. The two handles are
            // observably different — only the sink can push, only the source can
            // count — so a wrong choice does not merely verify.
            yield[]object{"an-imported-generic-constructor-takes-a-directional-view", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](4)
let sink = Sink[Pair](ch, 5)
Console.WriteLine(sink.Push(Pair{a: 1, b: 2}))
Console.WriteLine(sink.Kind)
let source = Source[Pair](ch, 6)
Console.WriteLine(source.Count)
Console.WriteLine(source.Kind)`, []string{"True", "5", "1", "6"}}
            // The review's case (PR #3995): an `object` overload declared BESIDE
            // the generic one must not steal the call. Both rank against the same
            // erased `ChannelReader[object]`, and betterness prefers the concrete
            // non-generic overload — so if applicability admitted it, merely ADDING
            // an `object` overload to a library would turn the repaired call back
            // into a diagnostic. `Pick[T]` returns 100 + Count and `Pick(object)`
            // returns 900 + Count, so the winner is visible in stdout.
            yield[]object{"an-object-overload-beside-the-generic-one-does-not-steal-the-call", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](4)
ch <- Pair{a: 1, b: 2}
Console.WriteLine(Overloaded.Pick(ch))
Console.WriteLine(ch.PickOn())`, []string{"101", "101"}}
            // Control (green on both sides), and the sharpest statement of the
            // cause. A DECLARED `in chan[Pair]` erases to exactly the
            // `ChannelReader[object]` the formal closed to, so the CLR probe
            // answered by IDENTITY and the structural check was never consulted —
            // no erasure comparison was needed because nothing had to be VIEWED.
            // Only the bidirectional receiver, which must cross the D2 lattice to
            // reach a reader or a writer, ever failed.
            yield[]object{"control-the-declared-directional-spellings-already-bound", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func drain(r in chan[Pair]) int32 {
    return r.TakeFirst().a
}

func fill(w out chan[Pair], v int32) int32 {
    return w.PushBoxed(Pair{a: v, b: v + 1})
}

let ch = chan[Pair](4)
Console.WriteLine(fill(ch, 77))
Console.WriteLine(drain(ch))`, []string{"1", "77"}}
            // A same-compilation CLASS element erases to `object` too, but through
            // `StructSymbol { IsClass: true }`'s imported-base arm rather than the
            // plain struct arm.
            yield[]object{"a-same-compilation-class-element-binds", `package P
import System
import Interop

class Node {
    var name string
}

let ch = chan[Node](4)
ch <- Node{name: "leaf"}
Console.WriteLine(ch.CountSoFar())
Console.WriteLine(ch.TakeFirst().name)`, []string{"1", "leaf"}}
            // An OPEN element inside a generic function: the element is a type
            // parameter rather than a same-compilation type, and it erases exactly
            // the same way.
            yield[]object{"an-open-element-inside-a-generic-function-binds", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func countOf[T](ch chan[T]) int32 {
    return ch.CountSoFar()
}

func staticCountOf[T](ch chan[T]) int32 {
    return StaticProbes.CountOf[T](ch)
}

func takeOf[T](ch chan[T]) T {
    return ch.TakeFirst()
}

let ch = chan[Pair](4)
ch <- Pair{a: 88, b: 99}
Console.WriteLine(countOf[Pair](ch))
Console.WriteLine(staticCountOf[Pair](ch))
Console.WriteLine(takeOf[Pair](ch).b)`, []string{"1", "1", "99"}}
            // Control (green on both sides): nothing erases for a built-in element,
            // so the lattice compared like with like and the call always bound.
            yield[]object{"control-a-closed-element-was-never-broken", `package P
import System
import Interop

let ch = chan[int32](4)
ch <- 7
Console.WriteLine(ch.CountSoFar())
Console.WriteLine(ch.TakeFirst())`, []string{"1", "7"}}
            // Control (green on both sides), and the issue's own control 2: a
            // same-compilation element under an imported generic extension is fine
            // in general — `[]Pair` erases to `object[]`, which really does convert
            // to `IEnumerable<object>`. This is what pins the cause to the channel
            // formal rather than to erasure as such.
            yield[]object{"control-the-linq-count-over-a-same-compilation-element", `package P
import System
import System.Linq
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = []Pair{Pair{a: 1, b: 2}, Pair{a: 3, b: 4}}
Console.WriteLine(items.Count())`, []string{"2"}}
            // Control (green on both sides), and the issue's own control 3: the
            // facade routes through ChannelRuntimeBinder, never through CLR
            // overload resolution.
            yield[]object{"control-the-channel-facade-still-binds", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](4)
ch <- Pair{a: 5, b: 6}
ch.Close()
let (v, ok) = <-ch
Console.WriteLine(v.a)
Console.WriteLine(ok)`, []string{"5", "True"}}
        }

        /// Gets the cases that must stay REJECTED: each is (name, G# consumer
        /// source, a substring the diagnostics must name).
        /// @returns The case data.
        func RejectedCases() sequence[[]object] {
            // Erasure-tolerant applicability must not become a direction-tolerant
            // lattice: a reader extension stays invisible on a send-only handle.
            yield[]object{"a-reader-extension-is-invisible-on-a-send-only-receiver", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func bad(w out chan[Pair]) int32 {
    return w.CountSoFar()
}

Console.WriteLine(bad(chan[Pair](1)))`, "CountSoFar"}
            // ...and a writer extension stays invisible on a receive-only handle.
            yield[]object{"a-writer-extension-is-invisible-on-a-receive-only-receiver", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func bad(r in chan[Pair]) int32 {
    return r.PushBoxed(Pair{a: 1, b: 2})
}

Console.WriteLine(bad(chan[Pair](1)))`, "PushBoxed"}
            // An element that DOES have CLR identity is still compared on its own
            // terms, so an explicit type argument naming the wrong one is refused.
            yield[]object{"an-explicit-type-argument-still-has-to-match-the-element", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](1)
Console.WriteLine(ch.CountSoFar[int32]())`, "CountSoFar"}
            // `Channel<T>` is invariant; the closed-element mismatch is untouched.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import Interop

let ch = chan[int32](1)
Console.WriteLine(ch.TakeTextLength())`, "TakeTextLength"}
            // The constructor path is held to the lattice too: a send-only handle
            // is not applicable to a `ChannelReader[T]` constructor parameter.
            yield[]object{"a-send-only-receiver-is-not-applicable-to-a-reader-constructor", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func bad(w out chan[Pair]) int32 {
    return Source[Pair](w, 6).Kind
}

Console.WriteLine(bad(chan[Pair](1)))`, "Source"}
            // The `object` overload on its own is still not applicable: nothing
            // here made a genuine `ChannelReader[object]` parameter reachable from
            // a `chan[Pair]`, so this stays exactly the GS0159 it was before.
            yield[]object{"an-object-only-overload-is-still-not-applicable", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](1)
Console.WriteLine(Overloaded.Pick[object](ch))`, "Pick"}
            // The fix widened a channel-shaped comparison, not member lookup.
            yield[]object{"an-unrelated-extension-stays-member-not-found", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](1)
Console.WriteLine(ch.Unrelated())`, "Unrelated"}
            // The sharpest one. `ChannelReader<object>` on a NON-generic method is
            // a genuine element, not an erasure, and the applicability gate says so
            // by refusing to answer for a slot whose OPEN declaration mentions no
            // generic parameter. So this call is refused exactly as it was before
            // the fix, by the same GS0159, and the erasure ambiguity never gets a
            // chance to pick it.
            yield[]object{"a-genuine-object-reader-parameter-is-not-applicable", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

let ch = chan[Pair](1)
Console.WriteLine(ObjectProbes.CountObjectReader(ch))`, "CountObjectReader"}
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
