// <copyright file="Issue4015MapLiteralNonRuntimeTypeArgumentTests.cs" company="GSharp">
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

/// Issue #4015: a `map[K, V]` whose key or value is an ordinary CLR type
/// crashed the compiler with the internal-error `GS9998`
/// (`NotSupportedException: TypeBuilder generic instantiation does not support
/// resolving members`).
/// @remarks <b>The mechanism, confirmed by direct measurement.</b>
/// `MapTypeSymbol.MakeClrType` builds the backing type as
/// `typeof(Dictionary<,>).MakeGenericType(key.ClrType, value.ClrType)`.
/// `RuntimeType.MakeGenericType` returns a real `RuntimeType` only
/// when EVERY type argument is itself a `RuntimeType`; give it one that is
/// not and it falls back to a
/// `System.Reflection.Emit.TypeBuilderInstantiation`, whose
/// `GetConstructor` and `GetMethod` both throw
/// (cref:NotSupportedException). A standalone reflection probe over the
/// compiler's own `MetadataLoadContext` shape reproduces it exactly:
/// `MakeGenericType(typeof(string), typeof(int))` gives
/// `System.RuntimeType` and resolves members, while
/// `MakeGenericType(typeof(string), mlcDateTime)` — where the second
/// argument is an `EcmaDefinitionType` — gives
/// `TypeBuilderInstantiation` and throws the exact message the compiler
/// reported.
///
/// <b>The issue's diagnosis is too narrow, and the fixture says so.</b>
/// It names the failing ingredient as "an imported reference type as the map
/// literal's value type". Measured on `a09f4e1b`, the crash needs no
/// imported library at all and no reference type: `map[string, DateTime]{}`,
/// `map[string, Guid]{}`, `map[string, TimeSpan]{}` and
/// `map[string, List[int32]]{}` all crashed, as did an imported STRUCT and
/// an imported type in the KEY position. The real predicate is "a key or value
/// whose `ClrType` is not a host `RuntimeType`" — i.e. everything
/// except the handful of G# primitives bound to a literal `typeof(...)`.
/// The green controls are exactly that handful: `int32`, `float64`,
/// `bool`, `string`, `object`. A same-compilation class was green
/// for the opposite reason — its `ClrType` is NULL, so the
/// `ClrType == null` branch #1481 added already carried it.
///
/// <b>The fix, and its blast radius.</b> That #1481 branch already builds
/// the right MemberRefs — parented at the reified TypeSpec, with
/// `!0`/`!1` parameter signatures — so the three emit sites that
/// reflect on the closed dictionary now fall through to it when the reflection
/// throws, rather than learning a second technique. The rows that resolved
/// members before still resolve them and emit byte-identically. The precedent is
/// #1449's `GetDelegateCtorReference`, which catches the same exception
/// from the same cause.
///
/// <b>Three emit sites, not one.</b> The issue's repro is an EMPTY map
/// literal, so it only ever reached `GetConstructor`. Fixing that alone
/// moved the crash one line down, twice, which is why this fixture exercises
/// every map operation rather than construction: a non-empty literal reaches
/// `EmitMapLiteral`'s `set_Item`, `m[k]` reaches
/// `EmitMapIndexRead`'s `TryGetValue`, and `m[k] = v` reaches
/// `EmitMapIndexAssignment`'s `set_Item`. All three are fixed.
///
/// <b>Sibling literal forms do NOT share the crash, measured.</b> A slice
/// literal (`[]ImportedBase{…}`, `[]TimeSpan{…}`) never reflects on a
/// constructed generic — a slice is a plain CLR array. A tuple literal was
/// already covered: `EmitTupleLiteral` routes an
/// `IsConstructedGenericType` target through
/// `GetCtorReferenceOnConstructedGeneric` for exactly this reason (#649).
/// Both are kept as green rows here so a future change cannot quietly lose
/// that. NESTED literals did share it, because the outer map is still a map:
/// `map[string, []ImportedBase]{}` and
/// `map[string, map[string, ImportedBase]]{}` both crashed and are green
/// rows now.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions.cs` and
/// `MethodBodyEmitter.MemberAccess.cs` to their parent state fails every
/// `MapOverANonRuntimeTypeArgument_CompilesVerifiesAndRuns` row with
/// `GS9998` and leaves every
/// `AGreenNeighbour_CompilesVerifiesAndRuns` row passing.
///
/// <b>Out of scope, filed separately.</b> A map whose value is a CLASS —
/// imported OR same-compilation — cannot bind `.Count`,
/// `.Remove(k)` or `.ContainsKey(k)` (`GS0159`), and
/// `for k, v in m` over one with an IMPORTED value reports `GS9998`
/// from an unresolved expression reaching emission. That is a BINDING-phase gap
/// in the symbolic Dictionary receiver view, not this emit bug: it reproduces
/// on `map[string, Derived]` for a same-compilation `Derived`, a row
/// #4015 itself calls "fine", and it was measured on the unmodified compiler
/// before any change here, and it is filed as issue #4023. Hence this fixture
/// reads maps through `m[k]` and never through `.Count`.
open class Issue4015MapLiteralNonRuntimeTypeArgumentTests {
    /// A map whose key or value has no host `RuntimeType` compiles,
    /// IL-verifies and runs. Every row reported `GS9998` before the fix.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("CrashingCases")
    func MapOverANonRuntimeTypeArgument_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// The neighbours that always worked keep working, and print what they
    /// always printed.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("GreenNeighbours")
    func AGreenNeighbour_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library the imported-type rows link against.
        private const LibrarySource string = `namespace HelperLib;

public class ImportedBase
{
    public string Name { get; set; } = "base";
}

public struct ImportedPoint
{
    public int X { get; set; }

    public int Y { get; set; }
}`

        /// The rows that reported `GS9998` before the fix. Every one of them
        /// has a key or value whose `ClrType` is not a host
        /// `RuntimeType`.
        /// @returns Case name, G# source, expected stdout lines.
        func CrashingCases() sequence[[]object] {
            // The issue's own repro, minus the `.Count` read it spells (see the
            // out-of-scope note in this class's remarks): an EMPTY map literal over
            // an imported reference type. This alone reached only `GetConstructor`.
            yield[]object{"empty-literal-imported-class", `package P
import System
import HelperLib

let entries = map[string, ImportedBase]{}
entries["k"] = ImportedBase{}
Console.WriteLine(entries["k"].Name)`, []string{"base"}}
            // Non-empty: adds `EmitMapLiteral`'s `set_Item`, which the issue's empty
            // repro never reached.
            yield[]object{"populated-literal-imported-class", `package P
import System
import HelperLib

let entries = map[string, ImportedBase]{"k": ImportedBase{Name: "one"}}
Console.WriteLine(entries["k"].Name)`, []string{"one"}}
            // The title's "value type", taken literally: an imported STRUCT.
            yield[]object{"populated-literal-imported-struct", `package P
import System
import HelperLib

let entries = map[string, ImportedPoint]{"a": ImportedPoint{X: 3, Y: 4}}
let p = entries["a"]
Console.WriteLine(p.X.ToString() + "," + p.Y.ToString())`, []string{"3,4"}}
            // The KEY position, which the issue does not mention at all.
            yield[]object{"imported-class-in-the-key-position", `package P
import System
import HelperLib

let k = ImportedBase{Name: "key"}
let entries = map[ImportedBase, string]{k: "v"}
Console.WriteLine(entries[k])`, []string{"v"}}
            // No imported library at all: a plain BCL value type. This row is the
            // correction to the issue's diagnosis.
            yield[]object{"bcl-value-type-no-imported-library", `package P
import System

let entries = map[string, TimeSpan]{"a": TimeSpan.FromSeconds(3)}
Console.WriteLine(entries["a"].TotalSeconds.ToString())`, []string{"3"}}
            // A BCL generic reference type, likewise with no library in sight.
            yield[]object{"bcl-generic-reference-type", `package P
import System
import System.Collections.Generic

let inner = List[int32]()
inner.Add(7)
let entries = map[string, List[int32]]{"a": inner}
Console.WriteLine(entries["a"][0].ToString())`, []string{"7"}}
            // Nested: a slice of an imported type as the map's value.
            yield[]object{"nested-slice-value", `package P
import System
import HelperLib

let entries = map[string, []ImportedBase]{"a": []ImportedBase{ImportedBase{Name: "n"}}}
Console.WriteLine(entries["a"][0].Name)`, []string{"n"}}
            // Nested: a map of maps. The outer literal is still a map literal.
            yield[]object{"nested-map-value", `package P
import System
import HelperLib

let entries = map[string, map[string, ImportedBase]]{}
entries["outer"] = map[string, ImportedBase]{"inner": ImportedBase{Name: "deep"}}
Console.WriteLine(entries["outer"]["inner"].Name)`, []string{"deep"}}
            // A missing key must still produce the CLR default through the symbolic
            // `TryGetValue`, exactly as it does through the reflected one.
            yield[]object{"missing-key-yields-the-zero-value", `package P
import System
import HelperLib

let entries = map[string, ImportedBase]{}
Console.WriteLine((entries["nope"] == nil).ToString())`, []string{"True"}}
        }

        /// The rows that were green before the fix and must stay green: the
        /// primitive elements whose closed dictionary really does resolve members,
        /// the same-compilation class the `ClrType == null` branch already
        /// carried, the `Dictionary[…]` spelling ADR-0104 says is the same
        /// type, and the sibling literal forms that never shared the crash.
        /// @returns Case name, G# source, expected stdout lines.
        func GreenNeighbours() sequence[[]object] {
            // `int32` is a host `RuntimeType`, so this row's emit is untouched.
            yield[]object{"primitive-value-type-element", `package P
import System

let entries = map[string, int32]{"a": 1}
entries["b"] = 2
Console.WriteLine(entries["a"].ToString() + entries["b"].ToString())`, []string{"12"}}
            // `string` keeps its #1714 Go zero value ("" rather than the CLR null)
            // on a miss — a branch that sits right beside the changed code.
            yield[]object{"string-element-keeps-its-go-zero-value", `package P
import System

let entries = map[string, string]{"a": "x"}
Console.WriteLine(entries["a"] + "|" + entries["zz"] + "|")`, []string{"x||"}}
            // A same-compilation class: `ClrType` is null, so #1481's branch already
            // handled it, which is why the issue found this row "fine".
            yield[]object{"same-compilation-class-element", `package P
import System
import HelperLib

class Derived : ImportedBase {
}

let d = Derived{}
d.Name = "d"
let entries = map[string, Derived]{}
entries["k"] = d
Console.WriteLine(entries["k"].Name)`, []string{"d"}}
            // ADR-0104 says this IS the same type as `map[string, ImportedBase]`,
            // and it compiled throughout — the workaround #4019's fixture used.
            yield[]object{"dictionary-spelling-of-the-same-type", `package P
import System
import System.Collections.Generic
import HelperLib

let entries = Dictionary[string, ImportedBase]()
entries["k"] = ImportedBase{Name: "dict"}
Console.WriteLine(entries["k"].Name)`, []string{"dict"}}
            // The sibling literal forms, over the very element types that crashed
            // the map literal. A slice is a plain CLR array; a tuple literal has
            // routed a constructed generic through the open definition since #649.
            yield[]object{"slice-literal-over-an-imported-type", `package P
import System
import HelperLib

let items = []ImportedBase{ImportedBase{Name: "s"}}
Console.WriteLine(items[0].Name)`, []string{"s"}}
            yield[]object{"slice-literal-over-a-bcl-value-type", `package P
import System

let items = []TimeSpan{TimeSpan.FromSeconds(2)}
Console.WriteLine(items[0].TotalSeconds.ToString())`, []string{"2"}}
            yield[]object{"tuple-literal-over-an-imported-type", `package P
import System
import HelperLib

let pair = (1, ImportedBase{Name: "t"})
Console.WriteLine(pair.Item1.ToString() + pair.Item2.Name)`, []string{"1t"}}
            yield[]object{"tuple-literal-over-a-bcl-value-type", `package P
import System

let pair = (1, TimeSpan.FromSeconds(2))
Console.WriteLine(pair.Item2.TotalSeconds.ToString())`, []string{"2"}}
        }

        private func CompileVerifyAndRun(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4015_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, name + ".dll")
                let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
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
