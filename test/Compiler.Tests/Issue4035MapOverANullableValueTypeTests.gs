// <copyright file="Issue4035MapOverANullableValueTypeTests.cs" company="GSharp">
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

/// Issue #4035: a `map[K, V?]` over a nullable VALUE type compiled clean
/// and then emitted IL that ilverify rejected with `StackUnexpected` and
/// the runtime rejected with (cref:InvalidProgramException) — the
/// backing `Dictionary` was closed over the BARE underlying type while
/// every value on the stack was a `Nullable<V>`.
/// @remarks <b>Root cause.</b> `NullableTypeSymbol` passes its underlying
/// type's `ClrType` straight through — `int32?.ClrType` is
/// `System.Int32` — because for a nullable REFERENCE type the annotation
/// has no distinct runtime type. `MapTypeSymbol.MakeClrType` read
/// `ClrType` directly, so `map[string, int32?]` was backed by
/// `Dictionary<string, int>` while the literal, the indexer's
/// `out` slot and the loop variable all carried a `Nullable<int>`.
/// The compiler already owns the correction —
/// `NullableLifting.GetEffectiveClrType`, which
/// `SequenceTypeSymbol.MakeClrType` and
/// `AsyncSequenceTypeSymbol.MakeClrType` both call — and the map's
/// construction simply never called it.
///
/// <b>Two arms, not one.</b> `GetEffectiveClrType` builds the
/// wrapper with the HOST `typeof(Nullable<>)`. For
/// `map[string, DateTime?]`, whose underlying `DateTime` is a
/// `MetadataLoadContext` type, that is exactly the
/// `TypeBuilderInstantiation` stand-in issue #4023 is about — not null, so
/// every `ClrType != null` gate takes it for a reflectable dictionary,
/// and its own assembly cannot name its context. So the reference-context arm
/// projects the open `Nullable<>` alongside the open
/// `Dictionary<,>` and closes it over the already-projected
/// underlying, inside the one context.
/// (cref:AcceptedCases)'s `DateTime?` and `ImportedPoint?`
/// rows are what separate the complete fix from the naive
/// `GetEffectiveClrType` swap.
///
/// <b>A third site, found by measurement.</b> With the construction
/// fixed, `for v in m.Values` over a `map[string, int32?]` still
/// failed ilverify — `MemberLookup.ProjectSymbolicArgToErasedClr` erased
/// the symbolic `int32?` argument through the same bare `ClrType`,
/// closing `ValueCollection` over `int32` while the receiver was a
/// `Dictionary<string, Nullable<int32>>`. Same dropped
/// wrapper, one erasure further out; `BuildErasedNullableInContext` is its
/// `Nullable<>` analogue of the existing
/// `BuildErasedTupleInContext`.
///
/// <b>The issue leaves one row unprobed and it matters.</b> It records
/// the `Dictionary[string, int32?]` spelling as "not yet probed".
/// Measured on `3e5103de`, that spelling is GREEN — so the two spellings
/// of one type (ADR-0104) genuinely disagreed, and
/// `var d Dictionary[string, int32?] = map[string, int32?]{…}` failed with
/// `[found ref Dictionary`2<string,int32>][expected ref
/// Dictionary`2<string,Nullable`1<int32>>]`. That row is in
/// (cref:AcceptedCases); it is the one that proves the fix made the
/// spellings agree rather than merely moving the map.
///
/// <b>Measured scope.</b> Every value-position operation was affected —
/// literal, `m[k]` read, `m[k] = v`, `m[k] = nil`,
/// `TryGetValue`, `ContainsValue`, `for k, v in m`,
/// `for v in m.Values` — and so was the KEY position
/// (`map[int32?, V]`, `map[DateTime?, V]`). The witness paragraph
/// below is the single place that states how many rows that is, so the count
/// cannot drift out of step with (cref:AcceptedCases).
/// Nullable REFERENCE values (`map[string, string?]`) were NOT affected
/// and are a control: the annotation has no distinct runtime type there, so
/// `Dictionary<string, string>` is the correct backing.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Symbols/MapTypeSymbol.cs`,
/// `src/Core/CodeAnalysis/Binding/MemberLookup.cs` and
/// `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.MemberAccess.cs` to
/// `3e5103de` turns every (cref:AcceptedCases) row red and leaves
/// every (cref:ControlCases) row green.
open class Issue4035MapOverANullableValueTypeTests {
    /// A `map[K, V?]` over a nullable value type is backed by
    /// `Dictionary<K, Nullable<V>>`, so the program compiles,
    /// IL-verifies, runs, and prints what it claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func AMapOverANullableValueType_EmitsVerifiableIl(name string, source string, expectedLines[]string) {
        RunCase("gs_4035_", name, source, expectedLines)
    }

    /// The rows that were already correct stay correct.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ControlCases")
    func AShapeThatWasAlreadyCorrect_StaysCorrect(name string, source string, expectedLines[]string) {
        RunCase("gs_4035_control_", name, source, expectedLines)
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library supplying an imported STRUCT, so a
        /// `map[string, ImportedPoint?]` exercises the reference-context arm
        /// with a type that is not a BCL primitive.
        private const LibrarySource string = `namespace HelperLib;

public struct ImportedPoint
{
    public int X { get; set; }
}`

        /// Every row compiles on `3e5103de` and then fails ilverify with one
        /// or more `StackUnexpected` errors (most also throw
        /// (cref:InvalidProgramException) at runtime; the count per program
        /// varies with how many nullable values the row moves — the headline
        /// indexer repro shows two, a bare `.Values` iteration one). Each row
        /// moves a real value through the map and prints it, so it fails on a
        /// wrong value as well as on invalid IL.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The issue's own repro.
            yield[]object{"read-a-nullable-int-value-through-the-indexer", `package Demo
import System

func main2() {
    var m = map[string, int32?]{"a": 1}
    var x = m["a"]
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(x.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
}

main2()`, []string{"1", "1", "True"}}
            yield[]object{"write-a-nullable-int-value-through-the-indexer", `package Demo
import System

func main2() {
    var m = map[string, int32?]{}
    m["a"] = 7
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m["a"].ToString())
}

main2()`, []string{"1", "7"}}
            yield[]object{"trygetvalue-into-a-nullable-int-out-slot", `package Demo
import System

func main2() {
    var m = map[string, int32?]{"a": 3}
    var got int32?
    if m.TryGetValue("a", out got) {
        Console.WriteLine(got.ToString())
    }
}

main2()`, []string{"3"}}
            yield[]object{"iterate-a-map-over-a-nullable-int-value", `package Demo
import System

func main2() {
    var m = map[string, int32?]{"a": 4}
    for k, v in m {
        Console.WriteLine(k + "=" + v.ToString())
    }
}

main2()`, []string{"a=4"}}
            // The `.Values` iteration is the row that needed the erasure fix, not
            // only the construction fix.
            yield[]object{"iterate-the-values-of-a-map-over-a-nullable-int", `package Demo
import System

func main2() {
    var m = map[string, int32?]{"a": 6}
    for v in m.Values {
        Console.WriteLine(v.ToString())
    }
}

main2()`, []string{"6"}}
            // An actual nil stored at a nullable value slot: the whole point of
            // `map[K, V?]`, and observable through HasValue.
            yield[]object{"store-nil-at-a-nullable-int-value", `package Demo
import System

func main2() {
    var m = map[string, int32?]{}
    m["a"] = nil
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m["a"].HasValue.ToString())
}

main2()`, []string{"1", "False"}}
            yield[]object{"containsvalue-over-a-nullable-int-value", `package Demo
import System

func main2() {
    var m = map[string, int32?]{"a": 9}
    Console.WriteLine(m.ContainsValue(9).ToString())
}

main2()`, []string{"True"}}
            // The reference-context arm: `DateTime` comes from the compilation's
            // MetadataLoadContext, so a host-built `Nullable<DateTime>` is the
            // unreflectable stand-in. The `.Value.Year` read moves a real value
            // through the wrapper.
            yield[]object{"a-nullable-imported-struct-value-datetime", `package Demo
import System

func main2() {
    var m = map[string, DateTime?]{}
    m["a"] = DateTime(2020, 1, 2)
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
    Console.WriteLine(m["a"].Value.Year.ToString())
}

main2()`, []string{"1", "True", "2020"}}
            // The same arm over a struct from a user-supplied assembly rather than
            // the BCL, so the projector is exercised on a genuinely external one.
            yield[]object{"a-nullable-imported-struct-value-from-a-referenced-assembly", `package Demo
import System
import HelperLib

func main2() {
    var m = map[string, ImportedPoint?]{}
    var p = ImportedPoint{}
    p.X = 42
    m["a"] = p
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m["a"].Value.X.ToString())
}

main2()`, []string{"1", "42"}}
            // ITERATING an imported nullable value, not indexing it. This is the
            // only shape that reaches `BuildErasedNullableInContext`'s NON-HOST
            // arm — the one that resolves `System.Nullable`1` out of the erasure
            // context's own assembly instead of using the host
            // `typeof(Nullable<>)`. The `int32?` iteration row above cannot cover
            // it (its context IS the host), and the `DateTime?` rows above only
            // index. Verified load-bearing by mutation: replacing that arm's
            // lookup with `null` leaves the `int32?` iteration green and turns
            // this row and its `.Keys` twin into `GS0158: Cannot find member
            // Value`.
            yield[]object{"iterate-the-values-of-a-map-over-a-nullable-imported-struct", `package Demo
import System

func main2() {
    var m = map[string, DateTime?]{}
    m["a"] = DateTime(2021, 3, 4)
    for v in m.Values {
        Console.WriteLine(v.Value.Year.ToString())
    }
}

main2()`, []string{"2021"}}
            // The `.Keys` twin of the row above, over a nullable imported KEY.
            yield[]object{"iterate-the-keys-of-a-map-over-a-nullable-imported-struct-key", `package Demo
import System

func main2() {
    var m = map[DateTime?, string]{}
    m[DateTime(2021, 3, 4)] = "x"
    for k in m.Keys {
        Console.WriteLine(k.Value.Year.ToString())
    }
}

main2()`, []string{"2021"}}
            // `for k, v in m` over an imported nullable value, so the destructured
            // form is covered alongside `.Values`.
            yield[]object{"iterate-key-and-value-of-a-map-over-a-nullable-imported-struct", `package Demo
import System

func main2() {
    var m = map[string, DateTime?]{}
    m["a"] = DateTime(2021, 3, 4)
    for k, v in m {
        Console.WriteLine(k + "=" + v.Value.Year.ToString())
    }
}

main2()`, []string{"a=2021"}}
            // The KEY position. The issue only measured the value position.
            yield[]object{"a-nullable-int-in-the-key-position", `package Demo
import System

func main2() {
    var m = map[int32?, string]{}
    m[1] = "one"
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey(1).ToString())
    Console.WriteLine(m[1])
}

main2()`, []string{"1", "True", "one"}}
            // The key position on the reference-context arm.
            yield[]object{"a-nullable-imported-struct-in-the-key-position", `package Demo
import System

func main2() {
    var m = map[DateTime?, string]{}
    m[DateTime(2020, 1, 2)] = "x"
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m[DateTime(2020, 1, 2)])
}

main2()`, []string{"1", "x"}}
            // The row the issue left unprobed: the two spellings of ONE type
            // (ADR-0104) must have the SAME backing dictionary. On 3e5103de the
            // `Dictionary` spelling was green and the `map` spelling was not, so
            // this assignment failed with
            // `[found ref Dictionary`2<string,int32>]
            //  [expected ref Dictionary`2<string,Nullable`1<int32>>]`.
            yield[]object{"a-map-over-a-nullable-int-assigns-to-the-dictionary-spelling", `package Demo
import System
import System.Collections.Generic

func main2() {
    var d Dictionary[string, int32?] = map[string, int32?]{"a": 2}
    Console.WriteLine(d.Count.ToString())
    Console.WriteLine(d["a"].ToString())
}

main2()`, []string{"1", "2"}}
            // Passing a `map[string, int32?]` to an OPEN `map[K, V]` parameter.
            // The open map itself was never the problem — it has no CLR type at
            // all — but the CLOSED argument's wrong backing dictionary reached the
            // call, so this row is red on 3e5103de too. Its non-nullable
            // instantiation is the genuine control.
            yield[]object{"an-open-map-parameter-called-with-a-nullable-value-argument", `package Demo
import System

func countVia[K, V](m map[K, V], probe K) int32 {
    if m.ContainsKey(probe) {
        return m.Count
    }

    return 0
}

func main2() {
    var m = map[string, int32?]{"a": 1, "b": 2}
    Console.WriteLine(countVia[string, int32?](m, "a").ToString())
}

main2()`, []string{"2"}}
        }

        /// The shapes that were already correct and must stay correct — in
        /// particular the nullable REFERENCE value, whose backing dictionary must
        /// keep the BARE underlying type.
        /// @returns Name, G# source, expected stdout lines.
        func ControlCases() sequence[[]object] {
            // The non-nullable sibling: unchanged.
            yield[]object{"control-a-map-over-a-plain-int-value", `package Demo
import System

func main2() {
    var m = map[string, int32]{"a": 1}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m["a"].ToString())
}

main2()`, []string{"1", "1"}}
            // A nullable REFERENCE value has no distinct runtime type, so its
            // backing dictionary is `Dictionary<string, string>` and must NOT gain
            // a `Nullable<>`. An over-broad fix that wrapped every
            // NullableTypeSymbol would break this row.
            yield[]object{"control-a-map-over-a-nullable-string-value-is-unaffected", `package Demo
import System

func main2() {
    var m = map[string, string?]{"a": "x"}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
    Console.WriteLine(m.ContainsValue("x").ToString())
}

main2()`, []string{"1", "True", "True"}}
            // The `Dictionary` spelling over a nullable value was already green;
            // it must remain so, and it is the shape the map spelling now matches.
            yield[]object{"control-the-dictionary-spelling-over-a-nullable-int-value", `package Demo
import System
import System.Collections.Generic

func main2() {
    var m = Dictionary[string, int32?]()
    m["a"] = 5
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m["a"].ToString())
}

main2()`, []string{"1", "5"}}
            // A map over an IMPORTED non-nullable value: #4023's shape, kept here
            // so the reference-context changes cannot regress it unnoticed.
            yield[]object{"control-a-map-over-a-non-nullable-imported-struct", `package Demo
import System
import HelperLib

func main2() {
    var p = ImportedPoint{}
    p.X = 7
    var m = map[string, ImportedPoint]{"a": p}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
}

main2()`, []string{"1", "True"}}
            // An OPEN map over type parameters has no CLR type at all; the fix
            // changes only how a CLOSED one is built. Instantiated at a
            // NON-nullable value here so the row is genuinely green before and
            // after — the `int32?` instantiation is an accepted row instead,
            // because passing a `map[string, int32?]` was itself broken.
            yield[]object{"control-an-open-map-over-type-parameters", `package Demo
import System

func countVia[K, V](m map[K, V], probe K) int32 {
    if m.ContainsKey(probe) {
        return m.Count
    }

    return 0
}

func main2() {
    var m = map[string, int32]{"a": 1, "b": 2}
    Console.WriteLine(countVia[string, int32](m, "a").ToString())
}

main2()`, []string{"2"}}
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
