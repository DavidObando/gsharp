// <copyright file="Issue4016ExplicitTypeArgumentErasureTests.cs" company="GSharp">
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

/// Issue #4016: a `map[K, Derived]` did not reach an inferred
/// `Dictionary<K, V>` slot that the `List` spelling reaches.
/// @remarks <b>Root cause: two erasures of one class that disagree.</b> The
/// ARGUMENT side and the explicit TYPE-ARGUMENT side project a
/// same-compilation class differently.
/// `MemberLookup.TryProjectErasedClrType` — which every structural
/// spelling (`map`, `[]T`, `[N]T`, `sequence`) goes through
/// — erases such a class to its IMPORTED BASE when it has one
/// (`class Derived : ImportedBase` becomes `ImportedBase`) and to
/// `object` only when it has none.
/// `TryResolveExplicitMethodTypeArgs` closed the candidate over a flat
/// `System.Object` placeholder regardless. So
/// `Probes.CountAnyMap[string, Derived](m)` compared an argument of
/// `Dictionary<string, ImportedBase>` against a parameter of
/// `Dictionary<string, object>`: invariant, no conversion, no
/// applicable candidate, `GS0159`. The fix projects the type argument the
/// same way the arguments are projected, so the two sides agree again. It is
/// the same correction #3087 made one site over in
/// `ExpressionBinder.Calls.cs`, which stopped flattening a symbolic TUPLE
/// type argument to `object` for exactly this reason.
///
/// <b>The issue's boundary is wrong, and these rows say so.</b> A
/// 14-case matrix measured on `main` at `a09f4e1b` shows the failure
/// needs THREE things at once: the structural spelling, EXPLICIT type
/// arguments, and a type argument that is a same-compilation class WITH an
/// imported base.
/// - The issue says "explicit vs inferred type arguments makes no difference". It makes all the
/// difference: INFERRED always bound, because inference reads the argument's own shape rather than a
/// placeholder. Pinned as the `inferred` rows.
/// - The issue frames the failing element as "a same-compilation class". A same-compilation class with
/// NO imported base bound fine, because `TryProjectErasedClrType` answers `object` for it and the two
/// sides already agreed. Pinned as the `standalone` rows.
/// - The issue titles this as a `map`-versus-`List` asymmetry. It is not `map`-specific: `[]Derived`
/// and `[N]Derived` at a `T[]` slot failed identically, for the identical reason. Pinned as the `slice`
/// and `array` rows.
///
/// <b>Why the <c>List</c> spelling was already green.</b>
/// `List[Derived]` is an `ImportedTypeSymbol`, so it takes
/// `TryProjectErasedClrType`'s `OpenDefinition` branch into
/// `TryBuildErasedClosedGeneric`, whose component eraser
/// (`ProjectSymbolicArgToErasedClr`) has no user-class arm and answers
/// `object` — which is what the flat placeholder produced, so those two
/// already agreed. That accident is the whole of the reported asymmetry.
///
/// <b>The projection is an applicability aid, not a claim about
/// CONSTRAINTS.</b> The `cs2gs-code-exploder` gate caught this: closing a type
/// argument over the imported-base surrogate leaks that surrogate into ANOTHER
/// type parameter's constraint whenever the constraint mentions this one.
/// `AuthenticationBuilder.AddScheme[TOptions, THandler]`, declared
/// `where THandler : AuthenticationHandler[TOptions]`, substituted
/// `TOptions` to `AuthenticationSchemeOptions`, so the constraint
/// read `AuthenticationHandler<AuthenticationSchemeOptions>` while
/// the handler's own base chain still erases to
/// `AuthenticationHandler<object>` — invariant, so the constraint
/// check failed and the candidate was dropped with `GS0159`. It is the
/// same "two erasers disagree" disease this issue is about, one layer down.
/// `ClrOverloadResolution` therefore asks constraints on the
/// `object`-NORMALISED vector
/// (`NormaliseErasedTypeArgsForConstraintCheck`), which is exactly the
/// question it asked before this issue, and leaves the projected vector to do
/// its own job in the closed method's parameter types.
///
/// <b>Where that row lives.</b> The regression test for it is the
/// `cs2gs-code-exploder` gate itself (17/17 apps), not a row here: every
/// attempt to reduce the shape to a fixture runs first into #4032 — a G# class
/// deriving from a CONSTRAINED imported generic base reports
/// `GS0149 Type 'Handler' is not generic`, on `main` and on this branch
/// alike — so the synthetic form of `SharedGateAuthenticationHandler :
/// AuthenticationHandler[SharedGateOptions]` cannot be written yet.
///
/// <b>What the fix does NOT loosen.</b> #4006's rejections are
/// unchanged: an erased class surrogate still does not satisfy a GENUINE
/// (non-erased) slot, whether spelled `map` or `List`. Those are the
/// rejected rows here, and they are the reason this fix had to be made at the
/// placeholder rather than by relaxing the erasure itself.
///
/// <b>Out of scope, filed separately.</b> Naming a BASE of the real
/// element as the explicit type argument — `Probes.CountAny[ImportedBase]`
/// applied to a `List[Derived]` — compiles and runs on `main` but
/// emits IL that ILVerify rejects (`StackUnexpected`, `List<Derived>`
/// found where `List<ImportedBase>` is expected). That is a
/// pre-existing #4006-shaped hole in the explicit-type-argument path, measured
/// identical before and after this change, and is NOT what this fix addresses;
/// it was filed as #4026. The same hole reached the INFERENCE path: the issue's
/// own control `Probes.CountAnyMap(entries)` on a `map[string, Derived]`
/// compiled and ran but did not IL-verify either, before or after this change,
/// because inference read `V` off the argument's surrogate and emitted
/// `CountAnyMap<string, ImportedBase>` while pushing a
/// `Dictionary<string, Derived>`. Note which way round the result landed:
/// after this change the EXPLICIT spelling verified (it emits over the real
/// `Derived`, recovered from `typeArgSymbols`) while the inferred one did not.
/// **Both are fixed by #4026**, whose rows live in
/// `Issue4026ExplicitTypeArgumentSoundnessTests`: the explicit BASE spelling is
/// now refused, and the inferred `map` spelling emits over the real element
/// because `MemberLookup.UnifyForMethodTypeArgs` gained the `map` arm it never
/// had. Every row in THIS fixture IL-verifies, before and after that.
open class Issue4016ExplicitTypeArgumentErasureTests {
    /// A structural spelling closed over an explicit user-class type argument
    /// reaches its inferred generic slot, compiles, IL-verifies and runs.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("BindingCases")
    func AStructuralSpellingAtAnInferredSlot_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4016_").FullName
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

    /// The #4006 rejections stay rejected: agreeing on the erasure must not
    /// make an erased surrogate satisfy a genuine slot.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("StillRejectedCases")
    func AGenuineSlot_StillRefusesAnErasedSurrogate(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4016_neg_").FullName
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

        /// The C# library every fixture case links against.
        private const LibrarySource string = `using System.Collections.Generic;

namespace Interop;

public class ImportedBase
{
    public string Name { get; set; } = "base";
}

public static class Probes
{
    // The inferred generic slots the erasure exists to serve.
    public static string CountAny<T>(List<T> items) => "any:" + items.Count;

    public static string CountAnyMap<K, V>(Dictionary<K, V> entries)
        where K : notnull
        => "anymap:" + entries.Count;

    public static string CountArray<T>(T[] items) => "arr:" + items.Length;

    // Genuine, non-erased slots: #4006 territory, and still refused.
    public static string TakeBaseMap(Dictionary<string, ImportedBase> d)
        => "basemap:" + d.Count;

    public static string TakeBaseList(List<ImportedBase> l)
        => "baselist:" + l.Count;
}`

        /// The rows that were red on `main` and are green after the fix, plus
        /// every neighbour that was already green and must stay so.
        /// @returns Case name, G# source, expected stdout lines.
        func BindingCases() sequence[[]object] {
            // RED BEFORE. The issue's own repro: the map spelling at an inferred
            // slot with explicit type arguments.
            yield[]object{"a-map-of-a-derived-class-reaches-an-inferred-dictionary-slot", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let entries = map[string, Derived]{}
entries["k"] = Derived{}
Console.WriteLine(Probes.CountAnyMap[string, Derived](entries))`, []string{"anymap:1"}}
            // RED BEFORE. The KEY position fails for the same reason as the value
            // position, so both are pinned.
            yield[]object{"a-derived-class-in-the-key-position-reaches-the-slot-too", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let entries = map[Derived, string]{}
Console.WriteLine(Probes.CountAnyMap[Derived, string](entries))`, []string{"anymap:0"}}
            // RED BEFORE, and the row that shows this is not `map`-specific: the
            // issue's title says `map`, but a slice fails identically.
            yield[]object{"a-slice-of-a-derived-class-reaches-an-inferred-array-slot", `package P
import System
import Interop

class Derived : ImportedBase {
}

let items = []Derived{Derived{}}
Console.WriteLine(Probes.CountArray[Derived](items))`, []string{"arr:1"}}
            // RED BEFORE. The fixed-length array spelling, same mechanism.
            yield[]object{"a-fixed-length-array-of-a-derived-class-reaches-the-same-slot", `package P
import System
import Interop

class Derived : ImportedBase {
}

let items = [2]Derived{Derived{}, Derived{}}
Console.WriteLine(Probes.CountArray[Derived](items))`, []string{"arr:2"}}
            // GREEN BEFORE. The `List` spelling the issue contrasts against — the
            // row the fix RE-ROUTES (its parameter now closes over `ImportedBase`
            // rather than `object`), so it is pinned with IL verification.
            yield[]object{"the-list-spelling-that-already-bound-still-binds-and-verifies", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let items = List[Derived]()
items.Add(Derived{})
Console.WriteLine(Probes.CountAny[Derived](items))`, []string{"any:1"}}
            // GREEN BEFORE. Inference never went through the placeholder, so it
            // always worked — the control that disproves the issue's claim that
            // explicit versus inferred makes no difference.
            //
            // Only the SLICE spelling is carried here. The `map` spelling of the
            // same inferred call — `Probes.CountAnyMap(entries)`, which the issue
            // lists as a working control — compiles and runs but does NOT
            // IL-verify, on `main` and after this change alike: inference reads
            // `V` off the argument's surrogate and emits
            // `CountAnyMap<string, ImportedBase>` while pushing the real
            // `Dictionary<string, Derived>` (`StackUnexpected`). That was the
            // #4026 hole on the inference path, which this fix does not touch — the
            // inferred path never reaches the explicit type-argument placeholder —
            // and which #4026 has since closed by giving
            // `MemberLookup.UnifyForMethodTypeArgs` the `map` arm it never had. Its
            // row lives in `Issue4026ExplicitTypeArgumentSoundnessTests`; the slice
            // spelling stays here because it is the one THIS issue is about.
            yield[]object{"inferred-type-arguments-bound-before-and-still-do", `package P
import System
import Interop

class Derived : ImportedBase {
}

let items = []Derived{Derived{}}
Console.WriteLine(Probes.CountArray(items))`, []string{"arr:1"}}
            // GREEN BEFORE. A same-compilation class with NO imported base erases
            // to `object` on both sides already — the control that disproves the
            // issue's "a same-compilation class" framing.
            yield[]object{"a-class-with-no-imported-base-bound-before-and-still-does", `package P
import System
import System.Collections.Generic
import Interop

class Standalone {
}

let entries = map[string, Standalone]{}
Console.WriteLine(Probes.CountAnyMap[string, Standalone](entries))

let items = []Standalone{Standalone{}}
Console.WriteLine(Probes.CountArray[Standalone](items))`, []string{"anymap:0", "arr:1"}}
            // GREEN BEFORE. Primitives are unaffected: they have a real CLR type
            // and never reached the placeholder branch at all.
            yield[]object{"primitive-type-arguments-are-untouched", `package P
import System
import System.Collections.Generic
import Interop

let entries = map[string, int32]{"a": 1}
Console.WriteLine(Probes.CountAnyMap[string, int32](entries))`, []string{"anymap:1"}}
        }

        /// #4006's rejections, which this fix must not loosen: an erased class
        /// surrogate still does not satisfy a genuine (non-erased) slot.
        /// @returns Case name, G# source, expected diagnostic id.
        func StillRejectedCases() sequence[[]object] {
            yield[]object{"a-derived-map-still-does-not-satisfy-a-genuine-base-dictionary", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let entries = map[string, Derived]{}
Console.WriteLine(Probes.TakeBaseMap(entries))`, "GS0159"}
            yield[]object{"a-derived-list-still-does-not-satisfy-a-genuine-base-list", `package P
import System
import System.Collections.Generic
import Interop

class Derived : ImportedBase {
}

let items = List[Derived]()
Console.WriteLine(Probes.TakeBaseList(items))`, "GS0159"}
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
