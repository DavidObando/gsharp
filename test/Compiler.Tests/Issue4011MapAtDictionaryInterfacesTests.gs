// <copyright file="Issue4011MapAtDictionaryInterfacesTests.cs" company="GSharp">
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

/// Issue #4011: a `map[K, V]` reached an open `Dictionary[K, V]`
/// but not the interfaces that class implements, so
/// `IDictionary[K, V]` reported `GS0155` where the CLOSED spelling
/// of the very same conversion was accepted.
/// @remarks <b>Root cause.</b> #3987 taught `Conversion` that a
/// `map[K, V]` IS a `Dictionary<K, V>` (ADR-0104) by SHAPE
/// rather than by comparing the two sides' `ClrType`s, which an open key
/// or value leaves null on the structural side and type-ERASED on the imported
/// side. It stopped at the concrete CLASS. The interfaces that class
/// implements had no rule of their own, and the reflective assignability rules
/// that would otherwise answer need a `ClrType` the open map does not
/// have — `MapTypeSymbol.MakeClrType` gives up the moment a key or value
/// has no CLR backing. So `map[string, int32] -> IDictionary[string,
/// int32]` converted and `map[K, V] -> IDictionary[K, V]` did not:
/// the one row where the two spellings of one conversion disagreed, and it
/// disagreed in the direction that rejects working code.
///
/// <b>The rule.</b> A `map[K, V]` converts IMPLICITLY to each of
/// the five interfaces its `Dictionary<K, V>` backing implements
/// over its own key and value — `IDictionary[K, V]`,
/// `IReadOnlyDictionary[K, V]`, and `ICollection` /
/// `IReadOnlyCollection` / `IEnumerable` of
/// `KeyValuePair[K, V]` (with `sequence[KeyValuePair[K, V]]` as the
/// ADR-0040 alias spelling of the last) — recognised by shape, exactly as
/// #3987 recognised the class and #3982 recognised the channel. The conversion
/// emits no IL: the value on the stack already IS that interface.
///
/// <b>Where it manifests, measured.</b> At an ASSIGNMENT and at a
/// G#-DECLARED parameter. NOT at an imported one: an imported call ranks its
/// argument on the ERASED shape, where an open map presents as
/// `Dictionary<object, object>` and is already CLR-assignable to
/// the equally erased `IDictionary<object, object>` parameter, so
/// no conversion is ever asked for. Every row in (cref:AcceptedCases)
/// and (cref:RejectedCases) is red on the parent commit; the
/// (cref:InteropCases) row is green there and is kept as a
/// must-not-change row rather than as proof.
///
/// <b>One-way by construction.</b> The source must be map-shaped and the
/// target must be one of the interfaces, so nothing here lets an
/// `IDictionary[K, V]` flow back into a `map[K, V]` — which is why
/// the interfaces were NOT folded into `MapTypeSymbol.TryGetMapShape`,
/// whose consumers would have read the pair as identity.
///
/// <b>Predicted side effect: half right, and the issue names the wrong
/// parameter kind.</b> It predicted that `(map[K, V])?` at a non-nullable
/// open `IDictionary[K, V]` would start reporting `GS0154` — the
/// null-safety gate (#3999) declines to blame nullability when the argument's
/// NON-nullable form would not reach the parameter either, and before this fix
/// it would not. That is exactly what happens at a G#-DECLARED parameter, and
/// it is pinned below. At the IMPORTED parameter the issue actually names,
/// nothing changes and nothing did disagree: BOTH spellings are accepted,
/// before and after, because `BindClrParameterConversions` is lenient
/// about a CLR parameter's declared nullability in general. Both halves of
/// that measurement are pinned so the correction cannot be lost.
open class Issue4011MapAtDictionaryInterfacesTests {
    /// An open map reaches the interfaces its backing implements, and the
    /// program compiles, IL-verifies, runs, and prints what it claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func AnOpenMap_ReachesTheInterfacesItsBackingImplements(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4011_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile:
` + "$appLog"))
            IlVerifier.Verify(appPath)
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The lattice stays one-way and element-exact.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedMention A substring the diagnostics must name.
    @Theory
    @MemberData("RejectedCases")
    func APairTheLatticeDoesNotRelate_IsStillRefused(name string, source string, expectedMention string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4011_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The conversion also holds at a genuine imported parameter — where,
    /// measured, it already held before this fix. See (cref:InteropCases).
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("InteropCases")
    func AnOpenMap_StillReachesAnImportedInterfaceParameter(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4011_interop_").FullName
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

    /// The issue's predicted side effect, measured at BOTH parameter kinds —
    /// and the issue names the wrong one.
    /// @remarks The issue says a `(map[K, V])?` at an open IMPORTED
    /// `IDictionary[K, V]` parameter is silently accepted while the
    /// closed `(map[string, int32])?` at
    /// `IDictionary[string, int32]` correctly reports `GS0154`, and
    /// predicts this fix will make the open one report `GS0154` too.
    /// Measured on the parent commit and on this one: at an IMPORTED parameter
    /// BOTH spellings are accepted, before and after, whether the imported
    /// method is generic (`CountDictionary[K, V]`) or takes an already
    /// closed `IDictionary<string, int>` (`CountClosed`). That
    /// is `BindClrParameterConversions`' standing leniency about a CLR
    /// parameter's DECLARED nullability — the same reason a `string?`
    /// reaches an imported `string` parameter — and it has nothing to do
    /// with this issue. The two spellings AGREE there, so there was no
    /// asymmetry to fix.
    ///
    /// The prediction IS right about a G#-DECLARED parameter, which is
    /// where the null-safety gate (#3999) applies: the closed spelling
    /// reported `GS0154` before this fix and still does, and the open
    /// spelling was silently accepted and now reports `GS0154` as well.
    /// That row is pinned in (cref:RejectedCases) as
    /// `a-nullable-open-map-at-a-non-nullable-interface-is-a-nullability-error`,
    /// and its closed twin is the second test below. Both halves are pinned so
    /// the correction cannot be lost.
    @Fact
    func ANullableMap_AtAnImportedInterfaceParameter_IsAcceptedInBothSpellings() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4011_nullable_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            const OpenSource = `package Demo
import System
import System.Collections.Generic
import Interop

func pass[K, V](m (map[K, V])?) int32 {
    return MapProbes.CountDictionary[K, V](m)
}

Console.WriteLine("x")`
            let openPath = Path.Combine(tempDir, "open.dll")
            let openLog = Compile(tempDir, "Open.gs", OpenSource, openPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(openPath), (`the open spelling is accepted at an imported parameter:
` + "$openLog"))
            Assert.DoesNotContain("GS9998", openLog, StringComparison.Ordinal)
            const ClosedSource = `package Demo
import System
import System.Collections.Generic
import Interop

func pass(m (map[string, int32])?) int32 {
    return MapProbes.CountClosed(m)
}

Console.WriteLine("x")`
            let closedPath = Path.Combine(tempDir, "closed.dll")
            let closedLog = Compile(
                tempDir,
                "Closed.gs",
                ClosedSource,
                closedPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.True(File.Exists(closedPath), (`and so is the closed spelling — the two agree:
` + "$closedLog"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The other half of the correction: at a G#-DECLARED parameter the CLOSED
    /// spelling reported `GS0154` before this fix too, so the two
    /// spellings there now agree on the error rather than disagreeing.
    @Fact
    func ANullableClosedMap_AtADeclaredNonNullableInterfaceParameter_StillReportsGS0154() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4011_closednull_").FullName
        try {
            const Source = `package Demo
import System
import System.Collections.Generic

func takeClosed(d IDictionary[string, int32]) int32 { return 1 }

func pass(m (map[string, int32])?) int32 {
    return takeClosed(m)
}

Console.WriteLine("x")`
            let appPath = Path.Combine(tempDir, "closedNull.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`the closed spelling must not compile. Log:
` + "$appLog"))
            Assert.Contains("GS0154", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the interop cases link against: genuine imported
        /// parameters typed as the dictionary interface family.
        private const LibrarySource string = `using System.Collections.Generic;

namespace Interop;

public static class MapProbes
{
    public static int CountDictionary<K, V>(IDictionary<K, V> map) => map.Count;

    // The already-CLOSED imported slot, for the nullability
    // correction below: it must behave the same as the generic one.
    public static int CountClosed(IDictionary<string, int> map) => map.Count;

    public static int CountReadOnly<K, V>(IReadOnlyDictionary<K, V> map) => map.Count;

    public static int CountPairs<K, V>(IEnumerable<KeyValuePair<K, V>> pairs)
    {
        var n = 0;
        foreach (var _ in pairs)
        {
            n++;
        }

        return n;
    }
}`

        /// The rows this issue fixes: an OPEN map reaching each interface its
        /// backing class implements, beside the CLOSED spelling that already
        /// worked. Each case prints the two answers so a disagreement is visible.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The reported row, and the full family beside it.
            yield[]object{"an-open-map-reaches-every-dictionary-interface", `package Demo
import System
import System.Collections.Generic

func countVia[K, V](m map[K, V]) int32 {
    var d IDictionary[K, V] = m
    var r IReadOnlyDictionary[K, V] = m
    var c ICollection[KeyValuePair[K, V]] = m
    var rc IReadOnlyCollection[KeyValuePair[K, V]] = m
    var e IEnumerable[KeyValuePair[K, V]] = m
    var s sequence[KeyValuePair[K, V]] = m
    var n int32 = 0
    for kv in s {
        n = n + 1
    }

    var m2 int32 = 0
    for kv in e {
        m2 = m2 + 1
    }

    return d.Count + r.Count + c.Count + rc.Count + n + m2
}

func main2() {
    var m = map[string, int32]{"a": 1, "b": 2}
    Console.WriteLine(countVia[string, int32](m).ToString())
}

main2()`, []string{"12"}}
            // The CLOSED spelling of the same conversions, which already worked.
            // Kept beside the open one so the two are read together: the whole
            // claim of this issue is that they must agree.
            yield[]object{"the-closed-spelling-still-reaches-every-dictionary-interface", `package Demo
import System
import System.Collections.Generic

func countVia(m map[string, int32]) int32 {
    var d IDictionary[string, int32] = m
    var r IReadOnlyDictionary[string, int32] = m
    var c ICollection[KeyValuePair[string, int32]] = m
    var e IEnumerable[KeyValuePair[string, int32]] = m
    return d.Count + r.Count + c.Count
}

func main2() {
    var m = map[string, int32]{"a": 1, "b": 2}
    Console.WriteLine(countVia(m).ToString())
}

main2()`, []string{"6"}}
            // The class arm #3987 fixed, restated as the control: this PR extends
            // that rule to the interfaces and must not disturb it.
            yield[]object{"control-an-open-map-still-reaches-the-concrete-dictionary", `package Demo
import System
import System.Collections.Generic

func toDictionary[K, V](m map[K, V]) int32 {
    var d Dictionary[K, V] = m
    return d.Count
}

func main2() {
    var m = map[string, int32]{"a": 1, "b": 2, "c": 3}
    Console.WriteLine(toDictionary[string, int32](m).ToString())
}

main2()`, []string{"3"}}
            // A SAME-COMPILATION element is the other half of "no CLR identity",
            // and takes the identical path: the map's ClrType is null for the same
            // reason, so the same arm has to answer.
            yield[]object{"a-map-over-a-same-compilation-element-reaches-the-interfaces", `package Demo
import System
import System.Collections.Generic

struct Pair { var X int32 }

func main2() {
    var m = map[string, Pair]{"a": Pair{X: 1}, "b": Pair{X: 2}}
    var d IDictionary[string, Pair] = m
    var e IEnumerable[KeyValuePair[string, Pair]] = m
    Console.WriteLine(d.Count.ToString())
    Console.WriteLine(d["b"].X.ToString())
}

main2()`, []string{"2", "2"}}
            // The NULLABLE row, which the fix reaches through #3843's widening
            // rather than through the new arm itself (the arm declines a nullable
            // pair by design, leaving the lifted rules their say). It has an
            // emitter arm of its own: a `map[K, V]?` is a `Dictionary<K, V>`
            // reference with an annotation, so the wrappers are stripped and the
            // upcast emits the same nothing. Before this PR it was accepted only
            // because NO conversion existed at all; the moment one did, the
            // emitter crashed with GS9998 until the wrappers were stripped, which
            // is why this row executes rather than merely compiling.
            yield[]object{"a-nullable-open-map-reaches-a-nullable-interface", `package Demo
import System
import System.Collections.Generic

func takeNullable[K, V](d (IDictionary[K, V])?) int32 {
    if d == nil {
        return 0
    }

    return 1
}

func passNullable[K, V](m (map[K, V])?) int32 {
    return takeNullable[K, V](m)
}

func main2() {
    var m = map[string, int32]{"a": 1}
    Console.WriteLine(passNullable[string, int32](m).ToString())
}

main2()`, []string{"1"}}
        }

        /// Rows that must still be REFUSED. The new arm is one-way and
        /// element-exact; nothing about it may widen the lattice.
        /// @returns Name, G# source, a substring the diagnostics must name.
        func RejectedCases() sequence[[]object] {
            // The reverse direction. An `IDictionary[K, V]` is not necessarily a
            // `Dictionary[K, V]`, so nothing here may make it one.
            yield[]object{"an-open-dictionary-interface-does-not-flow-back-into-a-map", `package Demo
import System
import System.Collections.Generic

func fromInterface[K, V](d IDictionary[K, V]) int32 {
    var m map[K, V] = d
    return 1
}

Console.WriteLine("x")`, "Cannot convert type"}
            // Element-exact: the interface's own arguments must be the map's own
            // key and value, not merely something the erasure could confuse them
            // with.
            yield[]object{"an-open-map-does-not-reach-a-dictionary-interface-of-other-elements", `package Demo
import System
import System.Collections.Generic

func mismatched[K, V](m map[K, V]) int32 {
    var d IDictionary[V, K] = m
    return 1
}

Console.WriteLine("x")`, "Cannot convert type"}
            // The side effect the issue predicted. Before this fix the null-safety
            // gate (#3999) declined to blame nullability, because the NON-nullable
            // form would not have reached the parameter either — for exactly the
            // reason this issue exists. With the conversion in place the row is
            // now a plain nullability error, which is the correct answer.
            yield[]object{"a-nullable-open-map-at-a-non-nullable-interface-is-a-nullability-error", `package Demo
import System
import System.Collections.Generic

func takeIt[K, V](d IDictionary[K, V]) int32 { return 1 }

func pass[K, V](m (map[K, V])?) int32 {
    return takeIt[K, V](m)
}

Console.WriteLine("x")`, "GS0154"}
        }

        /// An open `map[K, V]` at a genuine IMPORTED interface parameter —
        /// a MUST-NOT-CHANGE row, not proof.
        /// @remarks Review feedback on #4030 was right twice over. The map is now
        /// passed DIRECTLY to each probe: an earlier draft converted it to
        /// interface-typed locals first, so the imported parameter received an
        /// interface and the argument boundary was never crossed (the row did fail
        /// on the parent commit, but on the local assignments, not on the
        /// call).
        ///
        /// And once corrected, the row is GREEN on the parent commit too —
        /// measured, not assumed. An imported call ranks its argument on the
        /// ERASED shape, where an open `map[K, V]` presents as
        /// `Dictionary<object, object>`
        /// (`MemberLookup.TryProjectErasedClrType`) and is CLR-assignable to
        /// the equally erased `IDictionary<object, object>` parameter,
        /// so the argument is left alone and no conversion is ever asked for. That
        /// is the same reason the nullability correction above holds: at an
        /// IMPORTED parameter this issue does not manifest at all. It manifests at
        /// an assignment and at a G#-DECLARED parameter, which is where
        /// (cref:AcceptedCases) and (cref:RejectedCases) measure it
        /// — every one of those rows IS red on the parent.
        /// @returns Name, G# source, expected stdout lines.
        func InteropCases() sequence[[]object] {
            yield[]object{"interop-an-open-map-reaches-an-imported-dictionary-interface-parameter", `package Demo
import System
import System.Collections.Generic
import Interop

func countVia[K, V](m map[K, V]) int32 {
    return MapProbes.CountDictionary[K, V](m)
        + MapProbes.CountReadOnly[K, V](m)
        + MapProbes.CountPairs[K, V](m)
}

func main2() {
    var m = map[string, int32]{"a": 1, "b": 2}
    Console.WriteLine(countVia[string, int32](m).ToString())
}

main2()`, []string{"6"}}
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
