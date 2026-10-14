// <copyright file="Issue3987StructuralSpellingIdentityTests.cs" company="GSharp">
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

/// Issue #3987: `Conversion` stopped relating `map[K, V]` to
/// `Dictionary<K, V>` — and a tuple to `System.ValueTuple<…>`
/// — the moment an element was open.
/// @remarks A `map[K, V]` IS a `System.Collections.Generic.Dictionary<K,
/// V>` (ADR-0104) and a G# tuple IS a `System.ValueTuple<…>`
/// (ADR-0158). With CLOSED elements `Conversion.Classify` said so, because
/// its first check compares the two sides' `ClrType`s. Once an element is
/// open both `ClrType`s are the ADR-0004 type-ERASED shape (or null), and
/// the only remaining identity rule — `TryClassifyWrappedElementIdentity` —
/// is guarded by `from.GetType() == to.GetType()`, which a
/// `MapTypeSymbol`/`ImportedTypeSymbol` pair does not satisfy. So the
/// two SPELLINGS of one type stopped being identity exactly when the element was
/// symbolic, and `makeMap[K, V](entries map[K, V])` could not pass
/// `entries` to the `Dictionary[K, V]` parameter it already is.
///
/// The repair is the move #3976 made for channels — the lattice reads the
/// TYPES, not the spelling. `MapTypeSymbol.TryGetMapShape` and
/// `TupleTypeSymbol.TryGetTupleShape` recognise both spellings, and
/// `Conversion` compares them element-wise.
///
/// Recognising the pair also means OWNING it. Both CLR families are
/// invariant, so over an open element the only relation that exists is
/// element-wise identity — and a substituted `ValueTuple<int32, !T0>`
/// still reports a type-erased `ClrType`, so a rule reading only CLR shapes
/// saw `ValueTuple<int32, object>` on both sides and accepted a pair
/// with no conversion to emit. That is why #3984 had to canonicalize the
/// projected parameter locally in `DeclarationBinder.ResolveClrBaseConstructor`;
/// with the classifier fixed, that workaround (`CanonicalizeStructuralShape`,
/// `ShouldCanonicalizeAgainst`, `TryFlattenValueTupleElements`) is
/// DELETED and the whole Issue3984 suite still passes.
///
/// Every behavioural case compiles against a separately compiled C#
/// library, IL-VERIFIES, RUNS, and asserts the program's own stdout — each
/// fixture type declares two same-arity constructors and records which one ran
/// in `Tag`, so binding the wrong one is observable rather than merely
/// verifiable.
open class Issue3987StructuralSpellingIdentityTests {
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func AStructuralArgumentOverAnOpenElement_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3987_").FullName
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

    /// A pair that is a different type stays rejected: recognising both
    /// spellings must widen identity, never truth.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func ADifferentStructuralShape_IsStillRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3987_neg_").FullName
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

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library every fixture case links against. Each type declares TWO
        /// constructors of the same arity — one taking the structural shape, one
        /// taking a plain `int` — and records which ran in `Tag`.
        private const LibrarySource string = `using System.Collections.Generic;

namespace Interop;

public class MapHolder<K, V>
    where K : notnull
{
    public MapHolder(Dictionary<K, V> entries)
    {
        this.Tag = "map:" + entries.Count;
    }

    public MapHolder(int capacity)
    {
        this.Tag = "int:" + capacity;
    }

    public string Tag { get; }
}

public class TupleHolder<T>
{
    public TupleHolder((int, T) pair)
    {
        this.Tag = "tuple:" + pair.Item1 + ":" + pair.Item2;
    }

    public TupleHolder(int n)
    {
        this.Tag = "int:" + n;
    }

    public string Tag { get; }
}

public class BigTupleHolder<T>
{
    public BigTupleHolder((int, int, int, int, int, int, int, T) pair)
    {
        this.Tag = "big:" + pair.Item1 + ":" + pair.Item8;
    }

    public BigTupleHolder(int n)
    {
        this.Tag = "int:" + n;
    }

    public string Tag { get; }
}

public class SeqHolder<T>
{
    public SeqHolder(IEnumerable<T> items)
    {
        var n = 0;
        foreach (var _ in items)
        {
            n++;
        }

        this.Tag = "seq:" + n;
    }

    public SeqHolder(int capacity)
    {
        this.Tag = "int:" + capacity;
    }

    public string Tag { get; }
}

public static class Probes
{
    public static string CountEntries<K, V>(Dictionary<K, V> entries)
        where K : notnull
        => "probe:" + entries.Count;

    public static string FirstOf<T>((int, T) pair) => "probe:" + pair.Item1 + ":" + pair.Item2;
}`

        /// The behavioural cases: each compiles, IL-verifies, runs, and prints.
        /// @returns Case name, G# source, expected stdout lines.
        func Cases() sequence[[]object] {
            // The issue's own repro, in the ORDINARY imported-constructor probe
            // (ExpressionBinder), which is what makes it a `Conversion` gap rather
            // than anything specific to `: base(...)`.
            yield[]object{"the-reported-repro-binds", `package P
import System
import Interop

func makeMap[K, V](entries map[K, V]) MapHolder[K, V] {
    return MapHolder[K, V](entries)
}

let m = map[string, int32]{}
m["a"] = 1
m["b"] = 2
Console.WriteLine(makeMap[string, int32](m).Tag)`, []string{"map:2"}}
            // The tuple form of the same gap, against the same probe.
            yield[]object{"a-tuple-over-an-open-element-reaches-a-valuetuple-parameter", `package P
import System
import Interop

func makeTuple[T](pair (int32, T)) TupleHolder[T] {
    return TupleHolder[T](pair)
}

Console.WriteLine(makeTuple[string]((7, "x")).Tag)`, []string{"tuple:7:x"}}
            // Symmetry: the author who spells the parameter as the IMPORTED type
            // reaches the very same constructor. #3984's workaround needed a
            // `ShouldCanonicalizeAgainst` guard precisely because rewriting the
            // target broke this direction; a rule in `Conversion` has no direction
            // to get wrong.
            yield[]object{"the-imported-spelling-of-the-same-type-binds-too", `package P
import System
import System.Collections.Generic
import Interop

func makeMap[K, V](entries Dictionary[K, V]) MapHolder[K, V] {
    return MapHolder[K, V](entries)
}

let d = Dictionary[string, int32]()
d.Add("a", 1)
Console.WriteLine(makeMap[string, int32](d).Tag)`, []string{"map:1"}}
            // The other way an element loses its CLR identity: a type declared in
            // this compilation. `Pair` has no CLR backing while binding, so
            // `map[string, Pair]`'s `ClrType` is null for exactly the same reason
            // an open `K` makes it null.
            yield[]object{"a-map-over-a-same-compilation-element-binds", `package P
import System
import Interop

struct Pair {
    var a int32
    var b int32
}

func hold(entries map[string, Pair]) MapHolder[string, Pair] {
    return MapHolder[string, Pair](entries)
}

let m = map[string, Pair]{}
m["p"] = Pair{a: 1, b: 2}
Console.WriteLine(hold(m).Tag)`, []string{"map:1"}}
            // An 8-element tuple is `ValueTuple<T1..T7, TRest>` on the imported
            // side and a flat element list on G#'s, so the comparison has to unwind
            // the chain — otherwise exactly the long tuples keep failing.
            yield[]object{"a-long-tuple-over-an-open-element-binds", `package P
import System
import Interop

func makeBig[T](pair (int32, int32, int32, int32, int32, int32, int32, T)) BigTupleHolder[T] {
    return BigTupleHolder[T](pair)
}

Console.WriteLine(makeBig[string]((1, 2, 3, 4, 5, 6, 7, "tail")).Tag)`, []string{"big:1:tail"}}
            // Not a constructor: the same gap on an imported STATIC method's
            // parameter, which is the plainest statement that this lives in
            // `Conversion` and not in any one probe.
            //
            // The tuple sibling of this row (`Probes.FirstOf[T]((int32, T))`) is
            // deliberately absent: it compiles on `main` today and emits IL
            // ILVerify rejects, identically before and after this fix, because a
            // symbolic tuple at an imported GENERIC METHOD's slot loses its
            // MethodSpec recovery. That is a different axis — issue #4000 — and
            // nothing here touches it.
            yield[]object{"an-imported-static-method-takes-a-map-over-an-open-element", `package P
import System
import Interop

func countMap[K, V](entries map[K, V]) string {
    return Probes.CountEntries[K, V](entries)
}

let m = map[string, int32]{}
m["a"] = 1
Console.WriteLine(countMap[string, int32](m))`, []string{"probe:1"}}
            // The issue's own control, kept as a row: the slice sibling in the same
            // file always bound, because `[]T -> IEnumerable[T]` has a rule of its
            // own. It must keep binding.
            yield[]object{"control-the-slice-sibling-already-bound", `package P
import System
import Interop

func make[T](items []T) SeqHolder[T] {
    return SeqHolder[T](items)
}

Console.WriteLine(make[int32]([]int32{1, 2, 3}).Tag)`, []string{"seq:3"}}
            // The issue's other control: the CLOSED map form bound all along,
            // because the `ClrType` comparison catches it before any of this runs.
            yield[]object{"control-the-closed-map-and-tuple-were-never-broken", `package P
import System
import Interop

func closedMap(entries map[string, int32]) MapHolder[string, int32] {
    return MapHolder[string, int32](entries)
}

func closedTuple(pair (int32, string)) TupleHolder[string] {
    return TupleHolder[string](pair)
}

let m = map[string, int32]{}
m["a"] = 1
m["b"] = 2
m["c"] = 3
Console.WriteLine(closedMap(m).Tag)
Console.WriteLine(closedTuple((4, "y")).Tag)`, []string{"map:3", "tuple:4:y"}}
            // A `: base(...)` row, so the position #3984 fixed locally is still
            // covered once its local canonicalization is gone.
            yield[]object{"the-base-initializer-position-still-binds-without-its-workaround", `package P
import System
import Interop

class Holder[K, V] : MapHolder[K, V] {
    init(entries map[K, V]) : base(entries) {
    }
}

let m = map[string, int32]{}
m["a"] = 1
m["b"] = 2
Console.WriteLine(Holder[string, int32](m).Tag)`, []string{"map:2"}}
        }

        /// The rejection cases: widening identity must not accept a different type.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // Key and value are positional; swapping them is a different type.
            yield[]object{"the-key-and-value-still-have-to-match", `package P
import System
import Interop

func makeMap[K, V](entries map[V, K]) MapHolder[K, V] {
    return MapHolder[K, V](entries)
}

Console.WriteLine(makeMap[string, int32](map[int32, string]{}).Tag)`, "GS0155"}
            // The row #3984 had to add its canonicalization to hold, now held by
            // `Conversion` itself: `(int32, object)` is not `(int32, T)`, and the
            // erased `ValueTuple<int32, object>` both sides report is exactly the
            // trap.
            yield[]object{"an-erased-tuple-spelling-does-not-satisfy-a-symbolic-element", `package P
import System
import Interop

func makeTuple[T](pair (int32, object)) TupleHolder[T] {
    return TupleHolder[T](pair)
}

Console.WriteLine(makeTuple[string]((7, "x")).Tag)`, "GS0155"}
            // Same trap in the `: base(...)` position — the case that proves
            // deleting #3984's workaround did not re-open what it closed.
            yield[]object{"an-erased-tuple-spelling-does-not-satisfy-a-base-initializer", `package P
import System
import Interop

class Pairish[T] : TupleHolder[T] {
    init(pair (int32, object)) : base(pair) {
    }
}

Console.WriteLine(Pairish[string]((7, "x")).Tag)`, "GS0155"}
            // Arity is part of the shape.
            yield[]object{"the-tuple-arity-still-has-to-match", `package P
import System
import Interop

func makeTuple[T](pair (int32, T, T)) TupleHolder[T] {
    return TupleHolder[T](pair)
}

Console.WriteLine(makeTuple[string]((7, "x", "y")).Tag)`, "GS0267"}
            // A map is not a tuple, however open either one is.
            yield[]object{"a-map-is-not-a-tuple", `package P
import System
import Interop

func makeTuple[K, V](entries map[K, V]) TupleHolder[V] {
    return TupleHolder[V](entries)
}

Console.WriteLine(makeTuple[int32, string](map[int32, string]{}).Tag)`, "GS0267"}
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
