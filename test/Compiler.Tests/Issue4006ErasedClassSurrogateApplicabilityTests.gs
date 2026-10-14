// <copyright file="Issue4006ErasedClassSurrogateApplicabilityTests.cs" company="GSharp">
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

/// Issue #4006: a same-compilation CLASS erases to its IMPORTED BASE, so
/// `List[Derived]` bound to a parameter that genuinely is
/// `List<ImportedBase>` and emitted IL ILVerify rejects
/// (`List<T>` is invariant).
/// @remarks <b>Two routes to the same unsound bind, and one gate that now covers
/// both.</b> The issue named one mechanism and gave one repro; they turned out
/// to be different paths.
///
/// 1. <b>The reported repro (<c>List[Derived]</c>).</b> The argument's CLR projection is the ADR-0004
/// `List<object>`, so `ClassifyImplicit(List<ImportedBase>, List<object>)` is `None` and the candidate
/// is not applicable by CLR shape — which is why #3989's gate never saw it (that gate is consulted only
/// where the CLR comparison already matched). It was admitted by the `conv == None` fallback instead:
/// the ADR-0148 `structuralProjectionArgumentCheck` asks `StructuralProjectionPlanner.CanProject`
/// DIRECTLY, and the planner — which only asks "can the target be built from the source's public member
/// surface?" — said yes, because `List<Derived>` and `List<ImportedBase>` both have a public
/// parameterless constructor and a settable `Capacity`. `Conversion` refuses that pair outright (at the
/// #2735/#3962 symbolic-type-argument identity gate, before its own projection arm is reached), so the
/// layer that EMITS projections produced no node and the raw `List<Derived>` was pushed at an INVARIANT
/// slot. `ClrOverloadResolution` now asks the erased-argument question on that arm too.
/// 2. <b>The map spelling (<c>map[string, Derived]</c>).</b> Found while checking the fix above. Here
/// the argument's CLR projection is `Dictionary<string, ImportedBase>` — the imported base surrogate,
/// not `object` — so the CLR comparison reports IDENTITY against a parameter that genuinely is
/// `Dictionary<string, ImportedBase>`, #3989's gate IS consulted, and it declined because its
/// `ContainsNestedObject` test found no `object` anywhere. That test is now surrogate-aware, deriving
/// the set from the ARGUMENT.
///
/// <b>A narrowing that was tried and reverted.</b> Making the ADR-0148
/// callback itself require `Conversion.Classify(...).Exists` before
/// trusting the planner also closed the first case — and refused
/// `enumAction(List[Mode]{…})` at a `System.Action[List[Mode]]`,
/// whose `Invoke` parameter erases to `List<int>`
/// (`Issue2889LambdaThunkNestedGenericTests`). That slot's `int` DID
/// come from erasure, which is precisely what
/// `IsErasedGenericParameterSlot` exists to exempt — so the verdict has to
/// be asked per SLOT, where that exemption is in scope, not inside a callback
/// that cannot see the candidate.
///
/// <b>The enum surrogate has no hole, and is deliberately not in the
/// set.</b> A `List[MyEnum]` at a genuine `List<int>` parameter
/// is refused with `GS0159` both before and after this change —
/// `MemberLookup.ExcludeErasureOnlyEnumCandidates` pre-filters it, a
/// dedicated defence the class surrogate never had. Adding `int` to the
/// surrogate set would make every nested `int` position suspect for any
/// argument carrying a user enum, and buy nothing. It is a red row on both
/// sides on purpose: the asymmetry between surrogates is the thing this issue
/// says not to assume.
///
/// <b>The green rows are the point.</b> A fix that only stops accepting
/// things is not a fix. Covariance still binds — both the
/// `IEnumerable<ImportedBase>` sequence and, for
/// `[]Derived` at an `ImportedBase[]` parameter, real CLR array
/// covariance, which trips the same surrogate suspicion and is saved by the
/// verdict. A genuine `List[ImportedBase]` or
/// `Dictionary[string, ImportedBase]` still binds, an inferred generic
/// slot is never second-guessed, a real ADR-0148 projection at an imported
/// method parameter still binds AND emits, and
/// `Task.ContinueWith[TResult](Func[Task, TResult])` — one concrete nested
/// position beside one open one, the counterexample that reverted #4004's
/// attempted per-position redesign — stays green.
open class Issue4006ErasedClassSurrogateApplicabilityTests {
    /// An erased class surrogate that reached a genuine imported-base slot is
    /// now refused, rather than emitting IL that does not verify.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func AnErasedClassSurrogateAtAGenuineImportedSlot_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4006_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every legitimate neighbour of the refused bind still compiles,
    /// IL-verifies, runs, and prints what it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("LegitimateCases")
    func ALegitimateNeighbour_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4006_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
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

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library every fixture case links against.
        private const LibrarySource string = (`using System.Collections.Generic;

namespace Interop;

public class ImportedBase
{
    public string Name { get; set; } = "base";
}

public sealed class Point
{
    public Point(int x, int y)
    {
        this.X = x;
        this.Y = y;
    }

    public int X { get; }

    public int Y { get; }
}

public static class Probes
{
    // The reported slot: genuinely ` + "`" + `List<ImportedBase>` + "`" + `, invariant.
    public static string CountBaseList(List<ImportedBase> items)
        => "baselist:" + items.Count;

    // The covariant sibling: genuinely valid for a ` + "`" + `List[Derived]` + "`" + `.
    public static string CountBaseSeq(IEnumerable<ImportedBase> items)
    {
        var n = 0;
        foreach (var unused in items)
        {
            n++;
        }

        return "baseseq:" + n;
    }

    // The map spelling of the same slot, one level in.
    public static string CountBaseMap(Dictionary<string, ImportedBase> entries)
        => "basemap:" + entries.Count;

    // The array spelling. CLR arrays ARE covariant, so this one is a
    // legal reference conversion and must keep binding.
    public static string TakeBaseArray(ImportedBase[] items)
        => "basearray:" + items.Length;

    // An inferred generic slot: exactly what the erasure exists to
    // serve, and never second-guessed.
    public static string CountAny<T>(List<T> items) => "any:" + items.Count;

    // The enum surrogate's slot.
    public static string CountIntList(List<int> items) => "intlist:" + items.Count;

    // A genuine ADR-0148 projection target at an imported METHOD
    // PARAMETER — the exact path this change edits.
    public static string DescribePoint(Point p) => "point:" + p.X + "," + p.Y;
}`)

        /// The rejection cases: the unsound binds that used to compile.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The issue's own repro. Compiled on `main`, printed `baselist:1`, and
            // ilverify reported StackUnexpected
            // [found List`1<P.Derived>] [expected List`1<Interop.ImportedBase>].
            yield[]object{"the-reported-repro-is-rejected", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let derived = List[Derived]()
derived.Add(Derived{})
Console.WriteLine(Probes.CountBaseList(derived))`, "GS0159"}
            // The map spelling: a DIFFERENT path (the argument erases to the
            // imported base, not to `object`, so the CLR comparison reports
            // identity and #3989's gate is the one that has to refuse it).
            yield[]object{"the-map-spelling-of-the-same-hole-is-rejected", `package P
import System
import Interop

class Derived : ImportedBase {
}

let entries = map[string, Derived]{}
entries["k"] = Derived{}
Console.WriteLine(Probes.CountBaseMap(entries))`, "GS0159"}
            // The same unsound bind reached from inside a G# function rather than
            // from a local: the argument's type is spelled by a parameter, so the
            // refusal cannot depend on how the value was introduced.
            yield[]object{"a-derived-list-does-not-reach-a-genuine-base-list-through-a-generic-function", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

func hand(items List[Derived]) string {
    return Probes.CountBaseList(items)
}

Console.WriteLine(hand(List[Derived]()))`, "GS0159"}
            // The enum surrogate control. Refused BEFORE this change too, by
            // `ExcludeErasureOnlyEnumCandidates` — pinned so the asymmetry between
            // surrogates stays measured rather than assumed.
            yield[]object{"the-enum-surrogate-was-and-remains-refused", `package P
import System
import System.Collections.Generic
import Interop

enum MyEnum {
    A
    B
}

let values = List[MyEnum]()
values.Add(MyEnum.A)
Console.WriteLine(Probes.CountIntList(values))`, "GS0159"}
        }

        /// Every legitimate neighbour that must keep binding.
        /// @returns Case name, G# source, expected stdout lines.
        func LegitimateCases() sequence[[]object] {
            // The covariant sibling: `IEnumerable<T>` IS covariant and `Derived`
            // IS an `ImportedBase`, so this conversion is real and must survive.
            // A genuine `List[ImportedBase]` at the invariant slot must too, and an
            // inferred generic slot is never second-guessed.
            yield[]object{"covariance-a-genuine-argument-and-an-inferred-slot-all-still-bind", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let derived = List[Derived]()
derived.Add(Derived{})
Console.WriteLine(Probes.CountBaseSeq(derived))

let bases = List[ImportedBase]()
bases.Add(ImportedBase{})
Console.WriteLine(Probes.CountBaseList(bases))

Console.WriteLine(Probes.CountAny[Derived](derived))`, []string{"baseseq:1", "baselist:1", "any:1"}}
            // The genuine neighbour of the refused map row: a dictionary that
            // really holds imported bases reaches the genuine slot untouched. The
            // widened surrogate test is derived from the ARGUMENT, and this
            // argument erased nothing, so it never reaches the test at all.
            //
            // Spelled `Dictionary[string, ImportedBase]` rather than
            // `map[string, ImportedBase]{}` because the map LITERAL over an
            // imported element hits an unrelated emit failure (GS9998,
            // "TypeBuilder generic instantiation does not support resolving
            // members"), measured identical on `main` and filed as #4015.
            // ADR-0104: the two spellings are one type, so the binding under test
            // is the same.
            //
            // The inferred-slot neighbour is carried by the `List` spelling in the
            // row above (`CountAny[Derived]`). The `map` spelling of it did not
            // bind when this fixture was written, for a reason of its own — #4016,
            // the explicit type-argument placeholder disagreeing with the argument
            // erasure — which is now fixed. That row, and the slice and array
            // spellings that failed with it, live in
            // `Issue4016ExplicitTypeArgumentErasureTests` rather than being
            // duplicated here; the rejections below are what THIS issue pins.
            yield[]object{"a-genuine-imported-base-dictionary-still-binds", `package P
import System
import System.Collections.Generic
import Interop

let genuine = Dictionary[string, ImportedBase]()
genuine["k"] = ImportedBase{}
Console.WriteLine(Probes.CountBaseMap(genuine))`, []string{"basemap:1"}}
            // The ADR-0148 projection doing its real job, at an imported METHOD
            // PARAMETER — the exact callback this change edits. Without this row
            // the fix would only have been shown to say no.
            yield[]object{"a-genuine-structural-projection-at-an-imported-parameter-still-binds", `package P
import System
import Interop

class PtSource {
    var x int32
    var y int32
}

Console.WriteLine(Probes.DescribePoint(PtSource{x: 3, y: 4}))`, []string{"point:3,4"}}
            // The ARRAY spelling of the same surrogate — and the row that shows
            // the widened suspicion is only a suspicion. A `[]Derived` erases to
            // `ImportedBase[]` exactly as the map erased to
            // `Dictionary<string, ImportedBase>`, so it trips the same test; but
            // CLR arrays are COVARIANT, so `Conversion` reports a real conversion
            // and the verdict lets it through. Invariance is what made the map row
            // unsound, not the erasure.
            yield[]object{"the-covariant-array-spelling-still-binds", `package P
import System
import Interop

class Derived : ImportedBase {
}

Console.WriteLine(Probes.TakeBaseArray([]Derived{Derived{}}))
Console.WriteLine(Probes.TakeBaseArray([]ImportedBase{ImportedBase{}}))`, []string{"basearray:1", "basearray:1"}}
            // ADR-0148 projection at an ASSIGNMENT, onto an imported CLR target
            // built through its public member surface. This is the arm of
            // `Conversion.Classify` that reports `StructuralProjection` — the
            // conversion layer performing the projection the row above only asks
            // applicability about, and the reason the erased-argument gate takes
            // `Conversion.Classify(...).Exists` as its verdict rather than
            // second-guessing the planner: a real projection EXISTS, so the gate
            // lets it through.
            yield[]object{"a-genuine-projection-onto-an-imported-clr-target-still-lowers", `package P
import System
import System.Text

class CapSource {
    var Capacity int32
    var Length int32
}

let builder StringBuilder = CapSource{Capacity: 24, Length: 0}
Console.WriteLine(builder.Capacity.ToString())`, []string{"24"}}
            // The SECOND counterexample, and the one that reverted this issue's
            // first attempted fix. An imported delegate's `Invoke` parameter is the
            // open `!0` of `Action<T>`, so a `System.Action[List[Mode]]` over a
            // same-compilation enum presents it as `List<int>` — a slot whose `int`
            // DID come from erasure, exempted by `IsErasedGenericParameterSlot`.
            // Narrowing the ADR-0148 callback itself (requiring
            // `Conversion.Classify(...).Exists` before trusting the planner) closed
            // the `List[Derived]` case and broke this one, because a callback
            // cannot see the candidate and so cannot apply that exemption. Asking
            // the erased-argument question at the SLOT instead is what keeps both
            // right. Also in `Issue2889LambdaThunkNestedGenericTests`; kept here
            // because it is this change's counterexample, not that one's.
            yield[]object{"an-imported-delegates-erased-invoke-slot-still-accepts-a-user-enum-list", `package P
import System
import System.Collections.Generic

enum Mode { First, Second }

let enumAction System.Action[List[Mode]] =
    (items List[Mode]) -> Console.WriteLine(items.Count.ToString())
enumAction(List[Mode]{ Mode.Second })`, []string{"1"}}
            // THE counterexample. `Task.ContinueWith[TResult](Func[Task, TResult])`
            // has one concrete nested position (`Task`) beside one open one
            // (`TResult`) — position for position the same shape as
            // `Dictionary[T, List[object]]`. #4004 implemented a per-position
            // version of #3989's gate, this broke, and it was reverted. Kept green
            // here so any future per-position attempt trips over it immediately.
            yield[]object{"task-continuewith-keeps-its-one-concrete-and-one-open-position", `package P
import System
import System.Threading.Tasks

let t = Task.CompletedTask
let c = t.ContinueWith[string](func(prev Task) string { return "cw" })
Console.WriteLine(c.Result)`, []string{"cw"}}
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
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
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
