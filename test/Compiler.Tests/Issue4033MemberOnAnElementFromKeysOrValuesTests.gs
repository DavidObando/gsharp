// <copyright file="Issue4033MemberOnAnElementFromKeysOrValuesTests.cs" company="GSharp">
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

/// Issue #4033: a member call on an element obtained by iterating a
/// dictionary's `.Values` (or `.Keys`) failed — `GS0158`, or the
/// internal-compiler-error `GS9998` — while the same member on the same
/// value reached through the indexer, through `for k, v in m`, or through
/// `TryGetValue` bound fine.
/// @remarks <b>Root cause.</b> `Dictionary<,>.Values` is declared
/// `[Nullable({1, 0, 0})]` — measured off the reference assemblies. Byte 0
/// is `ValueCollection` itself (not-null); the two zeroes sit at the
/// `TKey`/`TValue` positions, which are type PARAMETERS: the declarer
/// cannot know what they will be substituted with, so the byte is a
/// placeholder, not an annotation. `MemberLookup.GetClrPropertyTypeSymbol`
/// only projected the receiver's symbolic arguments through the open property
/// when `projectOnlyWhenSymbolicallyRequired` was satisfied by one of two
/// narrow probes, so a CLOSED `Dictionary[string, string]` fell back to
/// reading those placeholder bytes as concrete positions. Issue #1354's rule —
/// "an unannotated reference position means `T?`" — then applied to a slot
/// that has no annotation to be oblivious ABOUT, and `.Keys`/`.Values`
/// surfaced a `string?` element. Because G# deliberately requires
/// narrowing or `?.` before reading a PROPERTY off an explicit `T?`
/// (but not before calling a METHOD), the loop body then lost the element's
/// whole CLR property/field surface.
///
/// <b>The machinery to do this right already existed.</b>
/// `NullableFlagsBuilder.MergeDeclarationNullability` carries an explicit,
/// documented carve-out taking a type-parameter position's nullability from the
/// receiver's ARGUMENT rather than from the declaration byte — which is exactly
/// why the OPEN `map[K, V].Keys` spelling was always right (issue #3311
/// pins it). The gate simply never let a closed receiver reach it. The fix
/// projects whenever the open property type mentions a parameter at all, and
/// leaves the merge deciding concrete positions, so #1354 is untouched.
///
/// <b>The map spelling needed a second half.</b> A closed
/// `map[K, V]` arrives as a (cref:GSharp.Core.CodeAnalysis.Symbols.MapTypeSymbol),
/// which is neither an `ImportedTypeSymbol` nor a `StructSymbol`, so
/// `GetProjectionReceiverImportedType` answered `null` and
/// the map spelling stayed broken after the `Dictionary` spelling was
/// fixed. `TryGetClosedMapProjectionView` surfaces the
/// `Dictionary[K, V]` view ADR-0104 says it IS. Its open definition comes
/// from the map's OWN `ClrType`, because #4023 may have built that
/// dictionary inside a `MetadataLoadContext`.
///
/// <b>The issue's own diagnosis is wrong on two axes, measured.</b> It
/// names the failing ingredient as "when the value is a CONSTRUCTED GENERIC".
/// The real predicate is "a PROPERTY (not a method) on an element from
/// `.Keys`/`.Values`": `for v in Dictionary[string, string]().Values
/// { v.Length }` fails identically on `3e5103de` with a plain
/// `string` value, and the issue's own "green" row
/// `for v in m.Values { v.Name }` is green only because it was never run —
/// see (cref:AcceptedCases)'s `string` rows. Conversely
/// `x.Add(7)` — a METHOD on the very element the issue reports as broken —
/// was already green, because a call never consults the receiver gate. Both
/// corrections are posted on the issue and pinned by the rows below.
///
/// <b>The issue also under-reports the blast radius.</b> It records
/// `.Keys` as "unaffected in the measured rows" and a generic key as "not
/// probed". Measured: `.Keys` is affected identically, a generic KEY
/// (`Dictionary[List[int32], string]`) is affected, and so is
/// `SortedDictionary[K, V].Values` — every nested `KeyCollection` /
/// `ValueCollection`. Non-nested generic collections
/// (`List`, `HashSet`, `Queue`, `Stack`,
/// `LinkedList`) were never affected and are control rows.
///
/// <b>The old reading was not faithful either.</b> Measured on
/// `3e5103de`: a `Dictionary<string, string?>` and a
/// `Dictionary<string, string>` returned from the SAME
/// nullable-enabled C# assembly both surfaced a `string?` element from
/// `.Values`, because both read the same placeholder byte — while both
/// dictionaries' own indexer and `for k, v` already surfaced `string`.
/// Issue #4066 subsequently made that agreement faithful: the projection
/// receiver is rebuilt with the annotation wrapper's per-argument flags, so
/// the annotated dictionary surfaces `string?` on every path while the
/// non-annotated dictionary surfaces `string`.
///
/// <b>Out of scope, measured and reported.</b> The issue notes "a missing
/// diagnostic underneath". Measured, the residual `GS9998` is a METHOD
/// GROUP in value position: `l.Count` on a `List[int32]?` binds
/// LINQ's `Enumerable.Count` extension group, and `.ToString()` on a
/// method group reaches emit unreported. It reproduces with no nullable in
/// sight — `List[int32]().Add.ToString()` on a plain non-nullable receiver
/// gives the identical GS9998 — so it is neither this bug nor a nullability
/// bug. Filed separately; no new diagnostic is minted here.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Binding/MemberLookup.cs` to `3e5103de`
/// turns every (cref:AcceptedCases) row red and leaves every
/// (cref:ControlCases) and (cref:RejectedCases) row green.
open class Issue4033MemberOnAnElementFromKeysOrValuesTests {
    /// A member on an element from `.Keys`/`.Values` binds, and the
    /// program compiles, IL-verifies, runs, and prints what it claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func AMemberOnAnElementFromKeysOrValues_Binds(name string, source string, expectedLines[]string) {
        RunCase("gs_4033_", name, source, expectedLines)
    }

    /// The rows that already worked keep working.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ControlCases")
    func AShapeThatAlreadyWorked_StillWorks(name string, source string, expectedLines[]string) {
        RunCase("gs_4033_control_", name, source, expectedLines)
    }

    /// The fix neither invents members nor weakens the explicit-nullable rule.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the compile must report.
    /// @param expectedCount How many times that id must appear.
    @Theory
    @MemberData("RejectedCases")
    func AShapeThatIsGenuinelyNullableOrMissing_IsStillRefused(
        name string,
        source string,
        expectedId string,
        expectedCount int32
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4033_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Equal(expectedCount, CountDiagnostic(appLog, expectedId))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the imported-value rows link against. Compiled with
        /// nullable annotations ENABLED so the two dictionary-returning factories
        /// differ only in whether their value is annotated — that pair is what
        /// proves the fix reads the receiver's argument rather than simply
        /// stripping every `?`.
        private const LibrarySource string = `using System.Collections.Generic;

namespace HelperLib;

public class Box
{
    public string Label { get; set; } = "box";
}

public static class Factory
{
    public static Dictionary<string, string> NonNullValues()
        => new() { ["a"] = "hello" };

    public static Dictionary<string, string?> NullableValues()
        => new() { ["a"] = "hello" };

    public static Dictionary<string, Box> BoxValues()
        => new() { ["a"] = new Box() };
}`

        /// Every row reports `GS0158` or `GS9998` on `3e5103de`.
        /// Each moves a real value through the member reached on the loop element
        /// and prints it, so a binding that resolves to the wrong thing prints the
        /// wrong answer rather than merely compiling.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The issue's own repro, `Dictionary` spelling: a constructed-generic
            // value reached through `.Values`. GS9998 on 3e5103de.
            yield[]object{"dictionary-values-element-constructed-generic", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, List[int32]]()
    g["b"] = List[int32]()
    g["b"].Add(5)
    g["b"].Add(6)
    for lists in g.Values {
        Console.WriteLine(lists.Count.ToString())
    }
}

main2()`, []string{"2"}}
            // The same repro, `map` spelling. ADR-0104 says these are one type, and
            // the issue's central fact is that both failed identically. GS9998 on
            // 3e5103de, and still GS9998 after the Dictionary half of the fix
            // alone — this row is what forced TryGetClosedMapProjectionView.
            yield[]object{"map-values-element-constructed-generic", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = map[string, List[int32]]{}
    g["b"] = List[int32]()
    g["b"].Add(5)
    g["b"].Add(6)
    for lists in g.Values {
        Console.WriteLine(lists.Count.ToString())
    }
}

main2()`, []string{"2"}}
            // The issue's diagnosis said a constructed generic was the failing
            // ingredient. A plain `string` value fails identically (GS0158 on
            // 3e5103de) — this row is the correction.
            yield[]object{"dictionary-values-element-is-a-plain-string", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, string]()
    g["b"] = "hello"
    for v in g.Values {
        Console.WriteLine(v.Length.ToString())
        Console.WriteLine(v.ToUpper())
    }
}

main2()`, []string{"5", "HELLO"}}
            // The map spelling of the same correction. GS0158 on 3e5103de.
            yield[]object{"map-keys-element-is-a-plain-string", `package Demo
import System

func main2() {
    var m = map[string, string]{"bb": "hello"}
    for k in m.Keys {
        Console.WriteLine(k.Length.ToString())
    }
}

main2()`, []string{"2"}}
            // The issue records `.Keys` as unaffected. Measured, it is affected
            // identically: GS0158 on 3e5103de.
            yield[]object{"dictionary-keys-element-property", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, int32]()
    g["bb"] = 5
    for k in g.Keys {
        Console.WriteLine(k.Length.ToString())
    }
}

main2()`, []string{"2"}}
            // The issue records a generic KEY as "not probed". Measured, GS9998 on
            // 3e5103de — the `.Keys` twin of the reported `.Values` row.
            yield[]object{"dictionary-keys-element-constructed-generic", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[List[int32], string]()
    var kk = List[int32]()
    kk.Add(7)
    kk.Add(8)
    kk.Add(9)
    g[kk] = "v"
    for k in g.Keys {
        Console.WriteLine(k.Count.ToString())
    }
}

main2()`, []string{"3"}}
            // Not only `Dictionary`: every nested KeyCollection/ValueCollection was
            // affected. GS0158 on 3e5103de.
            yield[]object{"sorted-dictionary-values-element-property", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = SortedDictionary[string, string]()
    g["a"] = "hello"
    for v in g.Values {
        Console.WriteLine(v.Length.ToString())
    }
}

main2()`, []string{"5"}}
            // The element reached through a LOCAL rather than directly in the
            // `for` header — the receiver's node kind was the whole gate, so this
            // is the row that shows the defect is about the TYPE, not the syntax.
            // GS9998 on 3e5103de.
            yield[]object{"values-collection-through-a-local-then-iterated", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, List[int32]]()
    g["b"] = List[int32]()
    g["b"].Add(5)
    var vs = g.Values
    for x in vs {
        Console.WriteLine(x.Count.ToString())
    }
}

main2()`, []string{"1"}}
            // An IMPORTED class as the value, reached through `.Values`, with its
            // own property read in the body. This is the shape the issue calls
            // green; it is not. GS0158 on 3e5103de.
            yield[]object{"values-element-is-an-imported-class-property-read", `package Demo
import System
import HelperLib

func main2() {
    var g = Factory.BoxValues()
    for b in g.Values {
        Console.WriteLine(b.Label)
    }
}

main2()`, []string{"box"}}
            // A dictionary handed over from a nullable-ENABLED C# assembly whose
            // value IS annotated `string?`, read through all THREE paths at once.
            // GS0158 on 3e5103de, on the `.Values` path only.
            //
            // Read this row carefully, because it is the one that could be
            // mistaken for a regression. Measured on 3e5103de, the indexer and
            // `for k, v` ALREADY said `string` here — the receiver's annotation is
            // dropped by `GetProjectionReceiverImportedType`, which unwraps a
            // `NullabilityAnnotatedTypeSymbol` to its bare base — while `.Values`
            // said `string?` for this annotated dictionary AND for the
            // non-annotated `NonNullValues()` alike, because it was reading the
            // declaration's placeholder rather than the annotation. Its apparent
            // correctness here was a coincidence, not a faithful reading. So this
            // Issue #4066 makes the agreement faithful: each path is `string?`, so
            // the value is narrowed before its property is read.
            yield[]object{"an-imported-nullable-value-dictionary-agrees-across-its-three-paths", `package Demo
import System
import HelperLib

func main2() {
    var g = Factory.NullableValues()
    let indexed = g["a"]
    if indexed != nil {
        Console.WriteLine(indexed.Length.ToString())
    }
    for k, v in g {
        if v != nil {
            Console.WriteLine(v.Length.ToString())
        }
    }

    for v in g.Values {
        if v != nil {
            Console.WriteLine(v.Length.ToString())
        }
    }
}

main2()`, []string{"5", "5", "5"}}
            // A dictionary handed over from a nullable-ENABLED C# assembly whose
            // value is NOT annotated. The element must be `string`, so the property
            // reads. GS0158 on 3e5103de.
            yield[]object{"values-element-from-an-imported-non-nullable-value-dictionary", `package Demo
import System
import HelperLib

func main2() {
    var g = Factory.NonNullValues()
    for v in g.Values {
        Console.WriteLine(v.Length.ToString())
    }
}

main2()`, []string{"5"}}
        }

        /// Shapes that already worked and must keep working — including the
        /// non-nested generic collections that were never affected, and the three
        /// other ways of reaching the same dictionary's values, whose agreement
        /// with each other is what identified the bug.
        /// @returns Name, G# source, expected stdout lines.
        func ControlCases() sequence[[]object] {
            // The three green paths to the SAME dictionary's values. Their
            // agreement (all `string`) against `.Values`' disagreement (`string?`)
            // is the measurement that located the defect.
            yield[]object{"control-indexer-for-k-v-and-trygetvalue-all-agree", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, string]()
    g["bb"] = "hello"
    Console.WriteLine(g["bb"].Length.ToString())
    for k, v in g {
        Console.WriteLine(k.Length.ToString() + "/" + v.Length.ToString())
    }

    var got string
    if g.TryGetValue("bb", out got) {
        Console.WriteLine(got.Length.ToString())
    }
}

main2()`, []string{"5", "2/5", "5"}}
            // A METHOD on the element from `.Values` was always green, because a
            // call never consults the receiver gate. It must stay green.
            yield[]object{"control-a-method-on-the-values-element", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, List[int32]]()
    g["b"] = List[int32]()
    for x in g.Values {
        x.Add(7)
    }

    Console.WriteLine(g["b"].Count.ToString())
}

main2()`, []string{"1"}}
            // Non-nested generic collections were never affected: their element
            // carries no placeholder byte. Four of them, so an over-broad change to
            // the projection would be visible here.
            yield[]object{"control-non-nested-generic-collections-are-unaffected", `package Demo
import System
import System.Collections.Generic

func main2() {
    var l = List[string]()
    l.Add("hello")
    for x in l {
        Console.WriteLine(x.Length.ToString())
    }

    var h = HashSet[string]()
    h.Add("worlds")
    for x in h {
        Console.WriteLine(x.Length.ToString())
    }

    var q = Queue[string]()
    q.Enqueue("sevens")
    for x in q {
        Console.WriteLine(x.Length.ToString())
    }

    var s = Stack[string]()
    s.Push("eight")
    for x in s {
        Console.WriteLine(x.Length.ToString())
    }
}

main2()`, []string{"5", "6", "6", "5"}}
            // A constructed-generic element from a plain enumerable was always
            // green — the ingredient the issue blamed, in isolation, is innocent.
            yield[]object{"control-constructed-generic-element-from-a-plain-list", `package Demo
import System
import System.Collections.Generic

func main2() {
    var outer = List[List[int32]]()
    var inner = List[int32]()
    inner.Add(5)
    outer.Add(inner)
    for x in outer {
        Console.WriteLine(x.Count.ToString())
    }
}

main2()`, []string{"1"}}
            // Issue #3311: an OPEN `map[K, V]`'s `.Keys` must keep iterating as
            // `K`, never `K?`. This is the spelling that was RIGHT all along, via
            // the very carve-out the fix now lets closed receivers reach, so it
            // pins that the fix did not disturb it.
            yield[]object{"control-an-open-map-keys-iterates-as-k", `package Demo
import System

func firstKey[K, V](m map[K, V], fallback K) K {
    for k in m.Keys {
        return k
    }

    return fallback
}

func main2() {
    var m = map[string, int32]{"only": 1}
    Console.WriteLine(firstKey[string, int32](m, "none"))
}

main2()`, []string{"only"}}
        }

        /// The shapes that must still be refused, so the fix neither invents
        /// members nor weakens G#'s rule that reading a property off an EXPLICIT
        /// `T?` requires narrowing or `?.` first.
        /// @returns Name, G# source, the expected diagnostic id, and how many times it must appear.
        func RejectedCases() sequence[[]object] {
            // ADR-0001: an explicitly-written `string?` still requires narrowing or
            // `?.` before a property read. The fix must NOT relax this — it changes
            // which element type `.Values` produces, not what may be done to a `T?`.
            yield[]object{"an-explicit-nullable-reference-still-refuses-a-property-read", `package Demo
import System

func main2() {
    var s string? = "hello"
    Console.WriteLine(s.Length.ToString())
}

main2()`, "GS0158", 1}
            // The same rule at an explicitly-nullable ELEMENT type. `[]string?` is
            // the author saying the elements may be nil, so the loop variable is
            // genuinely `string?` and the property read is genuinely refused —
            // unlike `.Values`, where the `?` was fabricated from a placeholder.
            yield[]object{"an-explicitly-nullable-slice-element-still-refuses-a-property-read", `package Demo
import System

func main2() {
    var s = []string?{"hello"}
    for v in s {
        Console.WriteLine(v.Length.ToString())
    }
}

main2()`, "GS0158", 1}
            // The fix does not invent members the element does not have.
            yield[]object{"a-member-the-values-element-does-not-have-is-still-refused", `package Demo
import System
import System.Collections.Generic

func main2() {
    var g = Dictionary[string, List[int32]]()
    for x in g.Values {
        Console.WriteLine(x.NoSuchMember.ToString())
    }
}

main2()`, "GS0158", 1}
        }

        private func CountDiagnostic(log string, id string) int32 {
            var count = 0
            let needle = "error " + id
            var index = log.IndexOf(needle, StringComparison.Ordinal)
            while index >= 0 {
                count++
                index = log.IndexOf(needle, index + needle.Length, StringComparison.Ordinal)
            }
            return count
        }

        private func RunCase(prefix string, name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory(prefix).FullName
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
                Assert.Equal(expectedLines, SplitLines(output))
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib.dll")
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
