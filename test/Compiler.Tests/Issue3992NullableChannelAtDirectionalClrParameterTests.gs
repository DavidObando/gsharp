// <copyright file="Issue3992NullableChannelAtDirectionalClrParameterTests.cs" company="GSharp">
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

/// Issue #3992: a nullable channel reached an imported `Channel<T>`
/// parameter but not a NON-GENERIC `ChannelWriter<T>` /
/// `ChannelReader<T>` one — `Plain.W(c)` reported GS0159 for a
/// `chan[int32]?` and bound for a `chan[int32]`.
/// @remarks <b>What #3995 left.</b> That PR fixed the CONVERSION for every element
/// spelling (`IsReferenceLikeTarget` and `IsNominalReferenceShape`
/// both learned the channel) and the generic-slot APPLICABILITY
/// (`ChannelViewAppliesAtErasedGenericSlot`). What remained was
/// applicability at a slot no erased-shape probe may answer: a non-generic
/// member on a non-generic type.
///
/// <b>Cause.</b> Applicability ALREADY ignores a reference annotation on
/// the CLR path — `NullableTypeSymbol.ClrType` relays its underlying, so a
/// `chan[int32]?` is presented to `ClrOverloadResolution` as
/// `Chan<int>` and reaches a `Channel[int32]` parameter by
/// ordinary CLR assignability, exactly as a `string?` reaches a
/// `string` parameter. Only ADR-0148's SYMBOLIC fallback
/// (`MakeStructuralProjectionArgumentCheck`, which exists because CLR
/// surrogates cannot see a G# argument's structural shape) re-asked the
/// question on the still-ANNOTATED symbol, and so re-introduced an annotation
/// the rest of the boundary had already dropped. It mattered only where no CLR
/// relation links the two shapes — precisely the ADR-0174 D2 view, since no
/// base class or interface links `Chan<T>` to
/// `ChannelWriter<T>`. The conversion the boundary then performs is
/// classified EXPLICIT on purpose (that is what keeps a G#-declared
/// `chan[int32]` parameter reporting GS0154), and the callback asked for
/// an IMPLICIT one, so the candidate was dropped before the conversion was ever
/// reached.
///
/// <b>Fix.</b> `IsApplicableIgnoringReferenceNullability`: the
/// symbolic fallback also answers yes when the argument's NON-NULLABLE form is
/// applicable. Nothing becomes applicable whose non-nullable form was not, only
/// a REFERENCE nullable is peeled (a value-type `Nullable<T>` keeps
/// its own lifted rules), and `StructuralProjectionPlanner.CanProject` is
/// not re-asked. The leniency stays confined to CLR boundaries, because
/// `BindClrParameterConversions` is the only call path that passes
/// `allowExplicit: true`.
///
/// <b>Discrimination (ADR-0154).</b> Every accepted case compiles against
/// a separately compiled C# library with nullable annotations ENABLED (with
/// them off the parameters import as nullable and the question disappears),
/// IL-VERIFIES, RUNS, and asserts the program's own stdout with a value pushed
/// through the chosen handle and read back — so a reader chosen where a writer
/// was meant, or a raw `Chan<T>` pushed with no `get_Writer`,
/// fails rather than merely verifies. The rejection rows hold the fix to its
/// claim that only the annotation was dropped: direction and element still
/// decide, and a G#-declared parameter still reports GS0154.
open class Issue3992NullableChannelAtDirectionalClrParameterTests {
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ANullableChannelAtADirectionalClrParameter_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3992_").FullName
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

    /// Only the ANNOTATION is dropped: direction, element, the G#-declared
    /// null-safety rule and unrelated types all still decide, and none of these
    /// reaches the emitter (GS9998).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func OnlyTheAnnotation_IsDropped(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3992_neg_").FullName
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
        /// ENABLED — that is what makes each parameter genuinely non-nullable.
        /// Every member is NON-GENERIC and declared on a NON-GENERIC type, which is
        /// exactly the slot #3995's erased-shape probe may not answer.
        private const LibrarySource string = `using System.Threading.Channels;

namespace OvlLib;

// The three handles are observably different: only a writer can push,
// only a reader can take, and the whole channel reports its own tag.
// A wrong choice prints the wrong value or deadlocks.
public static class Plain
{
    public static int W(ChannelWriter<int> writer) => writer.TryWrite(11) ? 11 : 0;

    public static int R(ChannelReader<int> reader) => reader.TryRead(out var v) ? v : -1;

    public static int C(Channel<int> whole) => 7;

    // A reader-only overload of a DIFFERENT name, so direction is the
    // only thing that can pick it.
    public static int OnlyReader(ChannelReader<int> reader) => 22;

    public static int OnlyWriter(ChannelWriter<int> writer) => 33;
}

// A non-generic type with a non-generic constructor taking a view.
public sealed class PlainSink
{
    public PlainSink(ChannelWriter<int> writer, int tag)
    {
        Kind = writer.TryWrite(tag) ? tag : 0;
    }

    public int Kind { get; }
}`

        /// The rows that must now COMPILE, IL-verify, RUN and print. Each moves a
        /// value THROUGH the view the call selected.
        /// @returns Name, source, and the expected stdout lines.
        func Cases() sequence[[]object] {
            // The corrected repro. `Plain.W` is non-generic on a non-generic type;
            // the non-nullable form already bound, the nullable form did not.
            yield[]object{"the-corrected-repro-a-nullable-channel-reaches-a-non-generic-writer-parameter", `package P
import System
import OvlLib

func plainNonNullable(c chan[int32]) int32 {
    return Plain.W(c)
}

func plainNullable(c chan[int32]?) int32 {
    return Plain.W(c)
}

let ch = chan[int32](4)
Console.WriteLine(plainNonNullable(ch))
Console.WriteLine(plainNullable(ch))
Console.WriteLine(<-ch)
Console.WriteLine(<-ch)`, []string{"11", "11", "11", "11"}}
            // The READER direction of the same view, and it must genuinely take
            // the value the writer put in — so `get_Reader` really was emitted.
            yield[]object{"a-nullable-channel-reaches-a-non-generic-reader-parameter", `package P
import System
import OvlLib

func push(c chan[int32]?) int32 {
    return Plain.W(c)
}

func take(c chan[int32]?) int32 {
    return Plain.R(c)
}

let ch = chan[int32](2)
Console.WriteLine(push(ch))
Console.WriteLine(take(ch))`, []string{"11", "11"}}
            // The fix is not confined to a non-generic enclosing scope: the same
            // call binds from inside a generic function. NOTE the element axis
            // cannot be exercised at this kind of slot at all — a NON-generic C#
            // `ChannelWriter<int>` parameter can only ever take a closed `int`
            // element — which is itself the reason this issue is a different axis
            // from #3985 rather than the same one.
            yield[]object{"the-same-call-binds-from-inside-a-generic-function", `package P
import System
import OvlLib

func plainNullable(c chan[int32]?) int32 {
    return Plain.OnlyWriter(c)
}

func openish[T](c chan[T]?, w chan[int32]?) int32 {
    return Plain.OnlyWriter(w)
}

let ch = chan[int32](1)
Console.WriteLine(plainNullable(ch))
Console.WriteLine(openish[int32](ch, ch))`, []string{"33", "33"}}
            // Direction still selects: a reader-only member and a writer-only
            // member are both reachable from the SAME nullable bidirectional
            // handle, and they answer differently.
            yield[]object{"direction-still-selects-from-one-nullable-bidirectional-handle", `package P
import System
import OvlLib

func both(c chan[int32]?) int32 {
    return Plain.OnlyReader(c) + Plain.OnlyWriter(c)
}

Console.WriteLine(both(chan[int32](1)))`, []string{"55"}}
            // A non-generic CONSTRUCTOR on a non-generic type takes the view too.
            yield[]object{"a-non-generic-constructor-takes-a-directional-view-from-a-nullable-channel", `package P
import System
import OvlLib

func make(c chan[int32]?) int32 {
    return PlainSink(c, 6).Kind
}

let ch = chan[int32](2)
Console.WriteLine(make(ch))
Console.WriteLine(<-ch)`, []string{"6", "6"}}
            // Control 1 (from the issue): the WHOLE-channel parameter was never
            // broken — it binds by ordinary CLR assignability.
            yield[]object{"control-the-whole-channel-parameter-was-never-broken", `package P
import System
import OvlLib

func toWhole(c chan[int32]?) int32 {
    return Plain.C(c)
}

Console.WriteLine(toWhole(chan[int32](1)))`, []string{"7"}}
            // Control 2 (from the issue): `!!` was and remains the remedy.
            yield[]object{"control-the-bang-bang-remedy-still-works", `package P
import System
import OvlLib

func bang(c chan[int32]?) int32 {
    return Plain.W(c!!)
}

let ch = chan[int32](1)
Console.WriteLine(bang(ch))
Console.WriteLine(<-ch)`, []string{"11", "11"}}
            // Control 3: the non-nullable form, which always bound. Carried so a
            // regression that broke it cannot hide behind the new rows.
            yield[]object{"control-the-non-nullable-channel-still-reaches-both-directions", `package P
import System
import OvlLib

func w(c chan[int32]) int32 {
    return Plain.OnlyWriter(c)
}

func r(c chan[int32]) int32 {
    return Plain.OnlyReader(c)
}

let ch = chan[int32](1)
Console.WriteLine(w(ch))
Console.WriteLine(r(ch))`, []string{"33", "22"}}
            // Control 4: a DECLARED directional nullable reaches its own view by
            // identity, with no annotation-dropping needed.
            yield[]object{"control-a-declared-directional-nullable-reaches-its-own-parameter", `package P
import System
import OvlLib

func w(c out chan[int32]?) int32 {
    return Plain.OnlyWriter(c)
}

func r(c in chan[int32]?) int32 {
    return Plain.OnlyReader(c)
}

let ch = chan[int32](1)
Console.WriteLine(w(ch))
Console.WriteLine(r(ch))`, []string{"33", "22"}}
        }

        /// The rows that must stay REJECTED. Only the ANNOTATION is dropped:
        /// direction and element still decide, and a G#-declared parameter still
        /// enforces nullability.
        /// @returns Name, source, and a substring the diagnostics must name.
        func RejectedCases() sequence[[]object] {
            // Direction is not dropped: a send-only nullable handle cannot become
            // a reader.
            yield[]object{"a-send-only-nullable-cannot-reach-a-reader-parameter", `package P
import System
import OvlLib

func bad(c out chan[int32]?) int32 {
    return Plain.OnlyReader(c)
}

Console.WriteLine(bad(chan[int32](1)))`, "OnlyReader"}
            // ...nor a receive-only handle a writer.
            yield[]object{"a-receive-only-nullable-cannot-reach-a-writer-parameter", `package P
import System
import OvlLib

func bad(c in chan[int32]?) int32 {
    return Plain.OnlyWriter(c)
}

Console.WriteLine(bad(chan[int32](1)))`, "OnlyWriter"}
            // The element is not dropped either. `ChannelWriter<T>` is invariant.
            yield[]object{"the-element-still-has-to-match", `package P
import System
import OvlLib

func bad(c chan[string]?) int32 {
    return Plain.OnlyWriter(c)
}

Console.WriteLine(bad(chan[string](1)))`, "OnlyWriter"}
            // The split #3985 settled on is preserved: the leniency is a CLR
            // boundary rule, and a G#-DECLARED parameter still reports GS0154.
            yield[]object{"a-gsharp-declared-directional-parameter-still-enforces-nullability", `package P
import System
import OvlLib

func takes(c out chan[int32]) int32 {
    return 1
}

func bad(c chan[int32]?) int32 {
    return takes(c)
}

Console.WriteLine(bad(chan[int32](1)))`, "GS0154"}
            // An unrelated non-channel parameter is not made applicable by the
            // peel: only a pair whose NON-NULLABLE form was already applicable is.
            yield[]object{"a-nullable-string-does-not-become-applicable-to-a-writer-parameter", `package P
import System
import OvlLib

func bad(s string?) int32 {
    return Plain.OnlyWriter(s)
}

Console.WriteLine(bad("x"))`, "OnlyWriter"}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "OvlLib",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "OvlLib.dll")
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
            // read asynchronously and bound the wait.
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
