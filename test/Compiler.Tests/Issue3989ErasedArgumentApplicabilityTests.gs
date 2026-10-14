// <copyright file="Issue3989ErasedArgumentApplicabilityTests.cs" company="GSharp">
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

/// Issue #3989: a same-compilation (or open) type argument erases to
/// `object` at applicability, so `List[Pair]` bound to a genuine
/// `List<object>` parameter and emitted IL ILVerify rejects.
/// @remarks Applicability ranks imported candidates on CLR shapes, and an element
/// declared in the current compilation has none:
/// `MemberLookup.TryProjectErasedClrType` presents `Pair` as
/// `System.Object`. That erasure is deliberate and is what lets
/// `[]Pair{…}.Count()` reach LINQ — but at the erased level an element
/// with no CLR identity is INDISTINGUISHABLE from a genuine `object`, so a
/// parameter that really is `List<object>` matched by identity. The
/// applicability probe then never got a second opinion:
/// `ConversionClassifier.BindClrParameterConversions` computes
/// `Conversion.Classify(List[Pair], List[object])`, which correctly says
/// there is no conversion — and every arm of that method ends in "leave the
/// argument alone" (the silence that makes G# lenient about a CLR parameter's
/// declared nullability), so the raw `List<Pair>` was pushed.
///
/// The reported case at least survives to print. The covariant sibling
/// does not: CLR variance does not apply to a value-type element, so a
/// `List[Pair]` or `[]Pair` reaching a genuine
/// `IEnumerable<object>` parameter throws
/// `EntryPointNotFoundException` from inside the callee. Both are
/// rejection rows.
///
/// <b>The fix, and its relation to #3982.</b> #3995 asked exactly this
/// question for channels — could this slot's `object` have come from
/// erasure? — and answered it with `IsErasedGenericParameterSlot`. This
/// uses the SAME predicate with the opposite polarity: the channel gate ADDS
/// applicability where the answer is yes, and
/// `MakeErasedArgumentMismatchCheck` REMOVES it where the answer is no. It
/// sits BESIDE the channel gate rather than subsuming it — the two are
/// complementary halves of one question, and both are needed.
///
/// Two refinements the issue did not predict, both measured:
///
/// 1. `IsErasedGenericParameterSlot` was slot-BLIND for a generic CLASS, so a `SlotHolder[T]` declaring
/// a genuine `SlotHolder(List<object>)` beside `TakeOpen(List[T])` still let a `List[Pair]` through. It
/// is now slot-precise, locating the open member by metadata token on the generic definition.
/// 2. Only a NESTED `object` is suspect. A parameter with no `object` inside a constructed generic was
/// matched on the argument's own CLR shape, which erasure did not invent — a `map[string, Pair]` really
/// is an `IDictionary` and a `[]Pair` really is a `System.Array`. Those are green rows.
///
/// Every fixture member returns a TAGGED string naming which overload
/// ran, so the green rows assert the selection rather than merely proving that
/// something compiled and verified.
open class Issue3989ErasedArgumentApplicabilityTests {
    /// An erased argument that reached a genuine `object` slot is now
    /// refused, rather than emitting IL that does not verify.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func AnErasedArgumentAtAGenuineObjectSlot_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3989_neg_").FullName
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
    /// IL-verifies, runs, and selects the member it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ALegitimateErasedBind_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3989_").FullName
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
        private const LibrarySource string = (`using System;
using System.Collections;
using System.Collections.Generic;

namespace Interop;

public static class Probes
{
    public static string CountObjList(List<object> items) => "objlist:" + items.Count;

    public static string CountObjEnumerable(IEnumerable<object> items)
    {
        var n = 0;
        foreach (var _ in items)
        {
            n++;
        }

        return "objseq:" + n;
    }

    public static string CountAny<T>(List<T> items) => "any:" + items.Count;

    public static string Describe(object value) => "obj:" + value.GetType().Name;

    // An ` + "`" + `object` + "`" + ` overload declared BESIDE a valid generic one: the
    // mirror of #3982's overload-set row.
    public static string Pick(List<object> items) => "pick-object:" + items.Count;

    public static string Pick<T>(List<T> items) => "pick-generic:" + items.Count;

    public static string TakeArray(Array a) => "array:" + a.Length;

    public static string TakeEnumerable(IEnumerable e)
    {
        var n = 0;
        foreach (var _ in e)
        {
            n++;
        }

        return "enum:" + n;
    }

    public static string TakeCollection(ICollection c) => "coll:" + c.Count;

    public static string TakeList(IList l) => "ilist:" + l.Count;

    public static string TakeDictionary(IDictionary d) => "idict:" + d.Count;

    public static string FormatAll(string fmt, params object[] parts)
        => "fmt:" + string.Format(fmt, parts);
}

public class SlotHolder<T>
{
    public SlotHolder(List<object> items)
    {
        this.Tag = "ctor-object:" + items.Count;
    }

    public SlotHolder(int capacity)
    {
        this.Tag = "ctor-int:" + capacity;
    }

    public string Tag { get; }

    public string TakeObjList(List<object> items) => "take-object:" + items.Count;

    public string TakeOpen(List<T> items) => "take-open:" + items.Count;

    // Review finding 2: an open position and a GENUINE nested one in
    // the same parameter. A parameter-wide exemption covered both.
    public string TakeMixed(Dictionary<T, List<object>> entries)
        => "take-mixed:" + entries.Count;

    // Every nested position open: must stay applicable.
    public string TakeAllOpen(Dictionary<T, List<T>> entries)
        => "take-allopen:" + entries.Count;
}

// Review finding 1: ` + "`" + `object` + "`" + ` is not the only erasure surrogate — a
// same-compilation enum erases to ` + "`" + `int` + "`" + `.
public static class SurrogateProbes
{
    public static string CountIntList(List<int> items) => "intlist:" + items.Count;

    public static string TakeInt(int n) => "int:" + n;
}

public static class ListExtensions
{
    public static string CountObjListExt(this List<object> items)
        => "ext-object:" + items.Count;

    public static string CountAnyExt<T>(this List<T> items)
        => "ext-generic:" + items.Count;
}`)

        /// The rejection cases: the unsound binds that used to compile.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The issue's own repro. Compiled on `main`, printed `1`, and ilverify
            // reported StackUnexpected [found List`1<Pair>] [expected List`1<object>].
            yield[]object{"the-reported-repro-is-rejected", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(Probes.CountObjList(items))`, "GS0159"}
            // The covariant sibling, and the stronger repro: CLR variance does not
            // reach a value-type element, so this one CRASHES rather than merely
            // failing to verify.
            yield[]object{"a-covariant-object-parameter-does-not-accept-a-value-type-element", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(Probes.CountObjEnumerable(items))`, "GS0159"}
            yield[]object{"a-slice-of-a-same-compilation-struct-does-not-reach-an-object-enumerable", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

Console.WriteLine(Probes.CountObjEnumerable([]Pair{Pair{a: 3, b: 4}}))`, "GS0159"}
            // The issue's own second shape: an open type parameter erases exactly
            // the same way.
            yield[]object{"an-open-type-parameter-erases-the-same-way", `package P
import System
import System.Collections.Generic
import Interop

func countThem[T](items List[T]) string {
    return Probes.CountObjList(items)
}

Console.WriteLine(countThem[int32](List[int32]()))`, "GS0159"}
            // Invariance is not about value types: `List<Node>` is not
            // `List<object>` either, however reference-typed `Node` is.
            yield[]object{"an-invariant-object-parameter-refuses-a-reference-element-too", `package P
import System
import System.Collections.Generic
import Interop

class Node {
    var name string
}

let items = List[Node]()
items.Add(Node{name: "n"})
Console.WriteLine(Probes.CountObjList(items))`, "GS0159"}
            // The extension path: slot 0 is the `this` receiver, and it goes
            // through the same check with the same offset every other argument does.
            yield[]object{"a-non-generic-extension-on-an-object-list-is-invisible", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(items.CountObjListExt())`, "GS0159"}
            // The slot-blind hole #3982 left open: every slot on a constructed
            // generic class answered "possibly erased", so a genuine
            // `List<object>` constructor accepted a `List[Pair]`.
            yield[]object{"a-genuine-object-slot-on-a-generic-class-constructor-is-refused", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(SlotHolder[Pair](items).Tag)`, "GS0267"}
            // Review finding 2: a GENUINE nested position (`List<object>`) sitting
            // beside an open one (`T`) in the same parameter. The parameter-wide
            // exemption this gate uses does cover the genuine position too, so the
            // gate declines — but the call is still refused, by
            // `BindClrParameterConversions` a few steps later, on `main` and here
            // alike. Measured both ways; no unverifiable IL is emitted either way,
            // which is why this row pins the diagnostic rather than claiming a fix.
            //
            // Moving the refusal up to applicability was attempted (a per-POSITION
            // test on the candidate's open declaration) and REVERTED: the open
            // parameter of `Task.ContinueWith[TResult](Func[Task, TResult])` has
            // the identical shape — one concrete nested position beside one open
            // one — so the position-aware test rejected every lambda passed to it.
            // See the `a-lambda-at-a-partly-concrete-generic-slot-still-binds` row
            // below, and Issue1512GenericClosureInferenceEmitTests.
            yield[]object{"a-genuine-nested-slot-beside-an-open-one-is-still-refused-by-conversion", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let inner = List[Pair]()
inner.Add(Pair{a: 1, b: 2})
let m = map[Pair, List[Pair]]{}
m[Pair{a: 1, b: 2}] = inner
let holder = SlotHolder[Pair](4)
Console.WriteLine(holder.TakeMixed(m))`, "GS0155"}
            // Review finding 1: a same-compilation ENUM erases to `int`, not to
            // `object`. Measured refused on `main` too — the surrogate has no hole
            // here — so this row pins the behaviour rather than claiming a fix.
            yield[]object{"a-same-compilation-enum-element-does-not-reach-an-int-list", `package P
import System
import System.Collections.Generic
import Interop

enum MyEnum {
    A,
    B
}

let enums = List[MyEnum]()
enums.Add(MyEnum.B)
Console.WriteLine(SurrogateProbes.CountIntList(enums))`, "GS0159"}
            yield[]object{"a-genuine-object-slot-on-a-generic-class-method-is-refused", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
let holder = SlotHolder[Pair](4)
Console.WriteLine(holder.TakeObjList(items))`, "GS0159"}
        }

        /// The cases that must keep binding: each compiles, IL-verifies, runs, prints.
        /// @returns Case name, G# source, expected stdout lines.
        func Cases() sequence[[]object] {
            // The case the erasure exists to serve: an INFERRED generic slot. This
            // is what the fix must not touch, and it is why the check is gated on
            // `IsErasedGenericParameterSlot` rather than applied everywhere.
            yield[]object{"the-inferred-generic-slot-still-binds", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(Probes.CountAny(items))
Console.WriteLine(Probes.CountAny[Pair](items))
Console.WriteLine(items.CountAnyExt())`, []string{"any:1", "any:1", "ext-generic:1"}}
            // The issue's own control, and #3982's: `[]Pair{…}.Count()` reaches
            // LINQ's `Count[TSource](IEnumerable[TSource])`.
            yield[]object{"control-the-linq-count-over-a-same-compilation-element", `package P
import System
import System.Linq

struct Pair {
    var a int32
    var b int32
}

Console.WriteLine([]Pair{Pair{a: 1, b: 2}, Pair{a: 3, b: 4}}.Count().ToString())`, []string{"2"}}
            // A parameter that genuinely IS `object` accepts the argument for real
            // — nothing about the erasure was involved in that match.
            yield[]object{"a-genuine-object-parameter-still-accepts-anything", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(Probes.Describe(items))
Console.WriteLine(Probes.Describe(Pair{a: 5, b: 6}))`, []string{"obj:List`1", "obj:Pair"}}
            // Where variance genuinely applies — a REFERENCE element — the
            // covariant parameter keeps binding, and the IL verifies.
            yield[]object{"a-reference-element-still-rides-covariance", `package P
import System
import System.Collections.Generic
import Interop

class Node {
    var name string
}

let items = List[Node]()
items.Add(Node{name: "n"})
Console.WriteLine(Probes.CountObjEnumerable(items))`, []string{"objseq:1"}}
            // The open slot on the very generic class whose `object` slot is now
            // refused: making the predicate slot-PRECISE has to keep this one.
            yield[]object{"the-open-slot-on-a-generic-class-still-binds", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
let holder = SlotHolder[Pair](4)
Console.WriteLine(holder.Tag)
Console.WriteLine(holder.TakeOpen(items))`, []string{"ctor-int:4", "take-open:1"}}
            // Review finding 2's counterexample, kept as a regression row. The open
            // parameter of `Task.ContinueWith[TResult](Func[Task, TResult])` holds
            // a CONCRETE nested position (`Task`) beside an open one (`TResult`) —
            // the same shape as `Dictionary[T, List[object]]`. Nothing structural
            // separates them, so a gate that treats "a concrete nested position" as
            // suspicion rejects this lambda too. Lifted from
            // Issue1512GenericClosureInferenceEmitTests, which is where the attempt
            // to make the #3989 gate position-aware was measured and abandoned.
            yield[]object{"a-lambda-at-a-partly-concrete-generic-slot-still-binds", `package P
import System
import System.Threading.Tasks

class CwOp[T] {
    var cont Task[T]?
    init() { }
    func SetIt(readerTask Task, v T) Task[T] {
        let r = readerTask.ContinueWith((t Task) -> v)
        cont = r
        return r
    }
}

let op = CwOp[int32]()
let task = op.SetIt(Task.CompletedTask, 42)
Console.WriteLine(task.Result)`, []string{"42"}}
            // Review finding 2's control: when EVERY nested position of the open
            // parameter is generic, nothing is suspect and the call still binds.
            yield[]object{"a-parameter-whose-nested-positions-are-all-open-still-binds", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let inner = List[Pair]()
inner.Add(Pair{a: 1, b: 2})
let m = map[Pair, List[Pair]]{}
m[Pair{a: 1, b: 2}] = inner
let holder = SlotHolder[Pair](4)
Console.WriteLine(holder.TakeAllOpen(m))`, []string{"take-allopen:1"}}
            // Only a NESTED `object` is suspect. A parameter with no `object`
            // inside a constructed generic was matched on the argument's real CLR
            // shape: a `[]Pair` IS a `System.Array`, an `ICollection`, an `IList`;
            // a `map[string, Pair]` IS an `IDictionary`.
            yield[]object{"non-generic-targets-are-untouched", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func sliceOpen[T](items []T) string {
    return Probes.TakeArray(items)
}

func mapOpen[K, V](entries map[K, V]) string {
    return Probes.TakeDictionary(entries)
}

let arr = []Pair{Pair{a: 1, b: 2}}
Console.WriteLine(Probes.TakeArray(arr))
Console.WriteLine(Probes.TakeEnumerable(arr))
Console.WriteLine(Probes.TakeCollection(arr))
Console.WriteLine(Probes.TakeList(arr))
Console.WriteLine(sliceOpen[Pair](arr))
let m = map[string, Pair]{}
m["p"] = Pair{a: 1, b: 2}
Console.WriteLine(Probes.TakeDictionary(m))
Console.WriteLine(mapOpen[string, Pair](m))`, []string{
                    "array:1",
                    "enum:1",
                    "coll:1",
                    "ilist:1",
                    "array:1",
                    "idict:1",
                    "idict:1"
                }}
            // A `params object[]` slot expands to an `object` ELEMENT, which is a
            // genuine `object` and not an erased one — the expanded-form loop takes
            // the same second opinion and must reach the same conclusion.
            yield[]object{"a-params-object-array-still-packs-an-erased-argument", `package P
import System
import Interop

class Node {
    var name string
}

Console.WriteLine(Probes.FormatAll("{0}", Node{name: "n"}))`, []string{"fmt:P.Node"}}
            // The mirror of #3982's overload-set row. With a genuine
            // `Pick(List[object])` declared BESIDE `Pick[T](List[T])`, betterness
            // used to prefer the concrete one — so the call bound to the overload
            // that cannot hold the argument. Removing the spurious candidate is
            // what lets the generic one win.
            yield[]object{"an-object-overload-beside-the-generic-one-does-not-steal-the-call", `package P
import System
import System.Collections.Generic
import Interop

struct Pair {
    var a int32
    var b int32
}

let items = List[Pair]()
items.Add(Pair{a: 1, b: 2})
Console.WriteLine(Probes.Pick(items))`, []string{"pick-generic:1"}}
            // A genuinely CLOSED `List[object]` argument still reaches every one of
            // the refused parameters: nothing was erased, so nothing is suspect.
            yield[]object{"control-a-real-object-list-still-reaches-every-object-parameter", `package P
import System
import System.Collections.Generic
import Interop

let items = List[object]()
items.Add("a")
Console.WriteLine(Probes.CountObjList(items))
Console.WriteLine(Probes.CountObjEnumerable(items))
Console.WriteLine(items.CountObjListExt())
Console.WriteLine(SlotHolder[int32](items).Tag)`, []string{"objlist:1", "objseq:1", "ext-object:1", "ctor-object:1"}}
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
