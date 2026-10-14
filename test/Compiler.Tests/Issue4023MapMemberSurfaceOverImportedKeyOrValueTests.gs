// <copyright file="Issue4023MapMemberSurfaceOverImportedKeyOrValueTests.cs" company="GSharp">
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

/// Issue #4023: a `map[K, V]` whose key or value is an IMPORTED type lost
/// its entire `Dictionary` member surface — `.Count`, `.Clear()`,
/// `.Remove`, `.ContainsKey`, `.ContainsValue`, `.Add`,
/// `.TryGetValue`, `.Keys`, `.Values` and `for k, v in m` —
/// while the `Dictionary[K, V]` spelling of the SAME type (ADR-0104) kept
/// every one of them.
/// @remarks <b>Root cause.</b> `MapTypeSymbol.MakeClrType` built the backing
/// type as `typeof(Dictionary<,>).MakeGenericType(key.ClrType,
/// value.ClrType)`. `RuntimeType.MakeGenericType` answers a real
/// `RuntimeType` only when EVERY argument is one; hand it a
/// `MetadataLoadContext` type — which is every imported type — and it
/// answers a `System.Reflection.Emit.TypeBuilderInstantiation` whose
/// `GetMethod`, `GetProperty` and `GetConstructor` all throw
/// (cref:NotSupportedException). That stand-in is NOT null, so every
/// `ClrType != null` gate in the binder took it for a reflectable
/// dictionary and member lookup came back empty. The fix builds the closed
/// dictionary in the key/value's OWN reflection context instead — which is
/// exactly what the `Dictionary[K, V]` spelling does, and why that
/// spelling was the green control all along.
///
/// <b>The issue's own diagnosis is wrong on two axes, measured.</b> It
/// names the failing ingredient as "a map whose value is a CLASS". The real
/// predicate is "a key or value whose `ClrType` is not a host
/// `RuntimeType`" — the same predicate #4015 arrived at for the emit-phase
/// twin. A 93-row probe matrix on `565b9a04` put an imported STRUCT
/// (`DateTime`), an imported GENERIC (`List[int32]`) and the KEY
/// position in the failing set alongside the two classes, and put a
/// same-compilation class with NO imported base (`Plain`) in the passing
/// set beside `int32` and a same-compilation struct — because those erase
/// to a host `typeof(object)`. And `.Count` reported <b>GS9998</b>,
/// not the `GS0159` the issue records: #4031's candidate-collection change
/// (`565b9a04`) moved it after the issue was filed. Both corrections are
/// posted on the issue and pinned by the rows below.
///
/// <b>Members the issue did not name are in the same fix.</b> Beyond
/// `.Count` / `.Remove` / `.ContainsKey` / `for..in`, the
/// matrix found `.Clear()` (GS9998), `.Add` / `.ContainsValue` /
/// `.TryGetValue` (GS0159) and `.Keys` / `.Values` (GS0158)
/// broken by the same cause; all are rows here. `m[k]` and
/// `m[k] = v` were NOT affected — #4015 already routes those three emit
/// sites around the same stand-in — and are kept as must-not-change rows.
///
/// <b>Out of scope, measured and reported.</b> `len(m)` reports
/// GS0566 for EVERY map including `map[string, int32]`: `len` was
/// retired as a built-in by ADR-0174 D13, so that is by design, not this
/// bug.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Symbols/MapTypeSymbol.cs`,
/// `ClrTypeUtilities.cs`, `ReferenceResolver.cs`,
/// `Binding/MemberLookup.cs` and
/// `Emit/MethodBodyEmitter.MemberAccess.cs` to `565b9a04` turns every
/// (cref:AcceptedCases) row red and leaves every
/// (cref:ControlCases) row green.
open class Issue4023MapMemberSurfaceOverImportedKeyOrValueTests {
    /// A map over an imported key or value has its whole member surface, and
    /// the program compiles, IL-verifies, runs, and prints what it claims.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("AcceptedCases")
    func AMapOverAnImportedKeyOrValue_HasItsMemberSurface(name string, source string, expectedLines[]string) {
        RunCase("gs_4023_", name, source, expectedLines)
    }

    /// The rows that already worked keep working.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ControlCases")
    func AShapeThatAlreadyWorked_StillWorks(name string, source string, expectedLines[]string) {
        RunCase("gs_4023_control_", name, source, expectedLines)
    }

    /// The fix does not invent members the dictionary does not have.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the compile must report.
    @Theory
    @MemberData("RejectedCases")
    func AShapeTheMapDoesNotHave_IsStillRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4023_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// How long a compiled case may run before it counts as hung.
        private const RunTimeout int32 = 60_000

        /// The C# library the imported-value rows link against: an ordinary class
        /// and an ordinary struct, both carrying a readable member so a green row
        /// can move a value through the map and print it.
        private const LibrarySource string = `namespace HelperLib;

public class ImportedBase
{
    public string Name { get; set; } = "base";
}

public struct ImportedPoint
{
    public int X { get; set; }
}`

        /// Every row is `GS0158` / `GS0159` / `GS9998` on
        /// `565b9a04`. Each moves a real value through the member (or the
        /// loop) and prints it, so a binding that resolves to the wrong thing
        /// prints the wrong answer rather than merely compiling.
        /// @returns Name, G# source, expected stdout lines.
        func AcceptedCases() sequence[[]object] {
            // The three members the issue names, over an IMPORTED class value,
            // each read back through Count so a no-op would be visible.
            yield[]object{"count-remove-and-containskey-over-an-imported-class-value", `package Demo
import System
import HelperLib

func main2() {
    var m = map[string, ImportedBase]{"a": ImportedBase{}, "b": ImportedBase{}}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
    Console.WriteLine(m.Remove("a").ToString())
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
}

main2()`, []string{"2", "True", "True", "1", "False"}}
            // The issue's worst row: `for k, v in m` over an imported value was a
            // GS9998 internal compiler error. Both the key AND the value are read
            // in the body.
            yield[]object{"for-k-v-in-a-map-with-an-imported-class-value", `package Demo
import System
import HelperLib

func main2() {
    var one = ImportedBase{}
    one.Name = "first"
    var m = map[string, ImportedBase]{"k": one}
    for k, v in m {
        Console.WriteLine(k + "=" + v.Name)
    }
}

main2()`, []string{"k=first"}}
            // A same-compilation class that EXTENDS an imported one. #4015 lists
            // this shape as a working control, and it is exactly where #4023 was
            // first seen: the class's own ClrType is null, so the erasure reaches
            // for its imported base's ClrType and lands back in the same
            // cross-context hole.
            yield[]object{"count-and-keys-over-a-same-compilation-class-with-an-imported-base", `package Demo
import System
import HelperLib

class Derived : ImportedBase {
}

func main2() {
    var d = Derived{}
    d.Name = "derived"
    var m = map[string, Derived]{"x": d}
    Console.WriteLine(m.Count.ToString())
    for k in m.Keys {
        Console.WriteLine(k)
    }

    for v in m.Values {
        Console.WriteLine(v.Name)
    }
}

main2()`, []string{"1", "x", "derived"}}
            // The members the issue did NOT name, over an imported class value.
            yield[]object{"add-containsvalue-trygetvalue-and-clear-over-an-imported-class-value", `package Demo
import System
import HelperLib

func main2() {
    var v = ImportedBase{}
    v.Name = "added"
    var m = map[string, ImportedBase]{}
    m.Add("a", v)
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsValue(v).ToString())

    var got ImportedBase
    Console.WriteLine(m.TryGetValue("a", out got).ToString())
    Console.WriteLine(got.Name)

    m.Clear()
    Console.WriteLine(m.Count.ToString())
}

main2()`, []string{"1", "True", "True", "added", "0"}}
            // An imported STRUCT value — the axis the issue's "value is a CLASS"
            // diagnosis misses, and the one that also exposed a spurious `box` at
            // the argument before the fix took its final shape.
            yield[]object{"the-full-surface-over-an-imported-struct-value", `package Demo
import System
import HelperLib

func main2() {
    var p = ImportedPoint{}
    p.X = 7
    var m = map[string, ImportedPoint]{}
    m.Add("a", p)
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsValue(p).ToString())
    for k, v in m {
        Console.WriteLine(k + "=" + v.X.ToString())
    }
}

main2()`, []string{"1", "True", "a=7"}}
            // A BCL struct and a BCL generic reached the same hole: neither is a
            // class, and neither needs a user library at all.
            yield[]object{"the-full-surface-over-a-bcl-struct-and-a-bcl-generic-value", `package Demo
import System
import System.Collections.Generic

func main2() {
    var m = map[string, TimeSpan]{"a": TimeSpan.FromSeconds(2.0)}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey("a").ToString())
    for k, v in m {
        Console.WriteLine(k + "=" + v.TotalSeconds.ToString())
    }

    var g = map[string, List[int32]]{"b": List[int32]()}
    g["b"].Add(5)
    Console.WriteLine(g.Count.ToString())
    Console.WriteLine(g.ContainsKey("b").ToString())
    Console.WriteLine(g.Remove("b").ToString())
    Console.WriteLine(g.Count.ToString())
}

main2()`, []string{"1", "True", "a=2", "1", "True", "True", "0"}}
            // The KEY position, which the issue does not mention at all.
            yield[]object{"the-member-surface-over-an-imported-key", `package Demo
import System
import HelperLib

func main2() {
    var k = ImportedBase{}
    k.Name = "key"
    var m = map[ImportedBase, int32]{}
    m.Add(k, 3)
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.ContainsKey(k).ToString())
    for pk, pv in m {
        Console.WriteLine(pk.Name + "=" + pv.ToString())
    }
}

main2()`, []string{"1", "True", "key=3"}}
        }

        /// Rows that were already GREEN on `565b9a04` and must stay green:
        /// the `Dictionary[K, V]` spelling the issue calls "the sharpest form
        /// of the inconsistency", the index sites #4015 already fixed, and a map
        /// over shapes that never lost their members. These hold the change to its
        /// scope; they are not proof.
        /// @returns Name, G# source, expected stdout lines.
        func ControlCases() sequence[[]object] {
            yield[]object{"control-the-dictionary-spelling-of-the-same-type", `package Demo
import System
import System.Collections.Generic
import HelperLib

func main2() {
    var d = Dictionary[string, ImportedBase]()
    d["a"] = ImportedBase{}
    Console.WriteLine(d.Count.ToString())
    Console.WriteLine(d.ContainsKey("a").ToString())
    for pair in d {
        Console.WriteLine(pair.Key + "=" + pair.Value.Name)
    }
}

main2()`, []string{"1", "True", "a=base"}}
            yield[]object{"control-map-index-read-and-write-over-an-imported-value", `package Demo
import System
import HelperLib

func main2() {
    var m = map[string, ImportedBase]{}
    var v = ImportedBase{}
    v.Name = "written"
    m["a"] = v
    Console.WriteLine(m["a"].Name)
}

main2()`, []string{"written"}}
            yield[]object{"control-a-map-over-shapes-that-never-lost-their-members", `package Demo
import System

class Plain {
    var Tag string
}

struct Pt {
    var X int32
}

func main2() {
    var m = map[string, int32]{"a": 1}
    Console.WriteLine(m.Count.ToString())
    Console.WriteLine(m.Remove("a").ToString())

    var p = Plain{}
    p.Tag = "t"
    var c = map[string, Plain]{"b": p}
    for k, v in c {
        Console.WriteLine(k + "=" + v.Tag)
    }

    var s = map[string, Pt]{"c": Pt{}}
    Console.WriteLine(s.ContainsKey("c").ToString())
}

main2()`, []string{"1", "True", "b=t", "True"}}
            // An OPEN map — key or value is a type parameter — is the shape
            // #3311's symbolic Dictionary view was built for. It must keep
            // working: the fix changes when a map has a CLR type at all.
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

        /// The shapes that must still be refused, so the fix did not open the
        /// member surface to anything the map does not have.
        /// @returns Name, G# source, an expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            yield[]object{"a-member-a-dictionary-does-not-have-is-still-refused", `package Demo
import System
import HelperLib

func main2() {
    var m = map[string, ImportedBase]{}
    Console.WriteLine(m.NoSuchMember().ToString())
}

main2()`, "GS0159"}
            // ADR-0174 D13 retired `len` as a built-in. Measured on 565b9a04 and
            // here: GS0566 for EVERY map, `map[string, int32]` included, so it is
            // by design and NOT an instance of this issue. Pinned because the
            // matrix that found this bug also found this row, and a future reader
            // should not chase it.
            yield[]object{"len-of-a-map-is-retired-by-adr-0174-not-broken-by-this-issue", `package Demo
import System

func main2() {
    var m = map[string, int32]{"a": 1}
    Console.WriteLine(len(m).ToString())
}

main2()`, "GS0566"}
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
