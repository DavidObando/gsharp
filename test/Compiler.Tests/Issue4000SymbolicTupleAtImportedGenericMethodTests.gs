// <copyright file="Issue4000SymbolicTupleAtImportedGenericMethodTests.cs" company="GSharp">
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

/// Issue #4000: a symbolic tuple at an imported GENERIC method's
/// `(int, T)` parameter compiled, ran, printed the right answer — and
/// emitted IL ILVerify rejects.
/// @remarks <b>What was emitted.</b> Inside `func firstOf[T](pair (int32, T))`
/// the call `Probes.FirstOf[T](pair)` produced:
///
/// ```
/// ldarg.0; stloc.0
/// ldloca.s 0; ldfld !0 ValueTuple`2<int32, !!T>::Item1
/// ldloca.s 0; ldfld !1 ValueTuple`2<int32, !!T>::Item2
/// box !!T
/// newobj ValueTuple`2<int32, object>::.ctor(!0, !1)
/// call FirstOf<!!T>(ValueTuple`2<int32, !!0>)
/// ```
///
/// The tuple was DECONSTRUCTED and REBUILT at
/// `ValueTuple<int32, object>`, then handed to a MethodSpec closed
/// over the real `T`, which wants `ValueTuple<int32, !!0>`:
/// StackUnexpected. That is correct machinery aimed at the wrong shape.
///
/// <b>Why.</b> `ConversionClassifier.BindClrParameterConversions`
/// recovers a generic method's erased parameter slot through a chain of
/// argument-shape arms — a bare `T` (#1540), a `T?` (#2117), a
/// same-compilation user type (#1819), a function literal or method group
/// (#1512/#2347), a channel (#3982). A TUPLE matched none of them, so the
/// target stayed at the closed CLR erasure
/// `ValueTuple<int32, object>` and the tuple conversion faithfully
/// rebuilt the value there. Adding the tuple arm makes the argument
/// `(int32, T) -> (int32, T)` identity: no rebuild, no box.
///
/// <b>Why the map sibling of the same call was a working control.</b>
/// Not because it took a better path — because `Dictionary<K, V>`
/// has no element-wise rebuild path. Its target was equally erased,
/// `Conversion` said `None`, "leave the argument alone" pushed the
/// raw value, and the raw value happened to be right. The tuple has a rebuild
/// path, so the same missing substitution produced wrong IL instead of
/// accidentally-right IL. Same cause, opposite symptom — which is exactly what
/// made this invisible until ILVerify was run.
///
/// <b>Not the same cause as #4006</b>, its PR sibling: #4006 is
/// applicability admitting a candidate on a verdict the conversion layer
/// refuses; this is a conversion, past applicability, aimed at the erased
/// parameter shape. Different layers, different fixes.
///
/// The green rows bracket the arm: the open element in either position
/// and one level down (so the substitution's own recursion is exercised), a
/// fully concrete call where nothing erased, the map control, and — the row
/// that proves the rebuild machinery itself was never the bug — a NON-generic
/// imported parameter that genuinely is `(int, object)`, where
/// box-and-rebuild is precisely correct and must still happen.
open class Issue4000SymbolicTupleAtImportedGenericMethodTests {
    /// The mirror of the reported defect is refused rather than emitting IL
    /// that does not verify.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func AConcreteTupleAtASymbolicSlot_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4000_neg_").FullName
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

    /// A symbolic tuple at an imported generic method's parameter compiles,
    /// IL-verifies, runs, and prints what it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func ASymbolicTupleAtAnImportedGenericMethod_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4000_").FullName
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

public static class Probes
{
    // The map control: binds and verifies on ` + "`" + `main` + "`" + ` too.
    public static int CountEntries<K, V>(Dictionary<K, V> entries)
        where K : notnull
        => entries.Count;

    // The reported shape: the open element in the SECOND position.
    public static string FirstOf<T>((int, T) pair) => pair.Item1 + ":" + pair.Item2;

    // The open element in the FIRST position.
    public static string SecondOf<T>((T, int) pair) => pair.Item2 + ":" + pair.Item1;

    // The open element one level DOWN: exercises the recursion inside
    // ` + "`" + `MemberLookup.MapOpenClrTypeToSymbolic` + "`" + `.
    public static string NestedOf<T>((int, (T, string)) pair)
        => pair.Item1 + ":" + pair.Item2.Item1 + ":" + pair.Item2.Item2;

    // Both elements open.
    public static string BothOf<A, B>((A, B) pair) => pair.Item1 + "|" + pair.Item2;

    // A NON-generic parameter that GENUINELY is ` + "`" + `(int, object)` + "`" + `: there
    // is no method type argument to substitute, the erased target IS
    // the real target, and box-and-rebuild is exactly right.
    public static string TakeObjPair((int, object) pair)
        => "objpair:" + pair.Item1 + ":" + pair.Item2;
}`)

        /// Every tuple shape that must compile, verify and run.
        /// @returns Case name, G# source, expected stdout lines.
        func Cases() sequence[[]object] {
            // The issue's own repro, verbatim: the map control beside the tuple.
            // On `main` this compiled, ran, printed `1` then `9:z`, and ilverify
            // reported StackUnexpected in `firstOf`
            // [found ValueTuple`2<int32,object>] [expected ValueTuple`2<int32,T0>].
            yield[]object{"the-reported-repro-verifies", `package P
import System
import Interop

func countMap[K, V](entries map[K, V]) int32 {
    return Probes.CountEntries[K, V](entries)
}

func firstOf[T](pair (int32, T)) string {
    return Probes.FirstOf[T](pair)
}

let m = map[string, int32]{}
m["a"] = 1
Console.WriteLine(countMap[string, int32](m).ToString())
Console.WriteLine(firstOf[string]((9, "z")))`, []string{"1", "9:z"}}
            // Position independence: the open element first, one level down, and
            // in every position at once.
            yield[]object{"the-open-element-verifies-in-any-position", `package P
import System
import Interop

func secondOf[T](pair (T, int32)) string {
    return Probes.SecondOf[T](pair)
}

func nestedOf[T](pair (int32, (T, string))) string {
    return Probes.NestedOf[T](pair)
}

func bothOf[A, B](pair (A, B)) string {
    return Probes.BothOf[A, B](pair)
}

Console.WriteLine(secondOf[string](("q", 7)))
Console.WriteLine(nestedOf[int32]((1, (2, "n"))))
Console.WriteLine(bothOf[string, int32](("k", 5)))`, []string{"7:q", "1:2:n", "k|5"}}
            // A value-type element: the erasure that would have boxed is the one
            // the CLR cannot undo, so this is the shape where a wrong target costs
            // more than a verifier complaint.
            yield[]object{"a-value-type-element-verifies", `package P
import System
import Interop

func firstOf[T](pair (int32, T)) string {
    return Probes.FirstOf[T](pair)
}

Console.WriteLine(firstOf[int32]((9, 42)))`, []string{"9:42"}}
            // The rebuild machinery doing its real job. `TakeObjPair` is NOT
            // generic: `(int, object)` is the genuine parameter, so the argument
            // must still be boxed and rebuilt exactly as before. If the new arm
            // over-reached, this row would stop boxing and fail.
            yield[]object{"a-genuine-object-element-still-boxes-and-rebuilds", `package P
import System
import Interop

func objPair[T](pair (int32, T)) string {
    return Probes.TakeObjPair(pair)
}

Console.WriteLine(objPair[string]((5, "o")))
Console.WriteLine(Probes.TakeObjPair((6, "p")))`, []string{"objpair:5:o", "objpair:6:p"}}
            // INFERENCE. Review feedback on #4019 widened the recovery to every
            // tuple-shaped argument, so this is the row that proves the widening
            // did not swallow the ordinary case: with no explicit type arguments
            // the method type argument is inferred from the tuple itself, the
            // recovered parameter is the CLOSED `(int32, string)`, and
            // `TrySubstituteParameterTypeFromMethodTypeArgs` returns null for it
            // (it demands a parameter that still `ContainsTypeParameter` or
            // `ContainsSameCompilationUserType`). The argument therefore falls
            // through to `GetClrParameterTargetType` exactly as before.
            yield[]object{"an-inferred-type-argument-still-binds", `package P
import System
import Interop

Console.WriteLine(Probes.FirstOf((9, "z")))
Console.WriteLine(Probes.SecondOf(("q", 7)))
Console.WriteLine(Probes.NestedOf((1, (2, "n"))))

let p = (5, "v")
Console.WriteLine(Probes.FirstOf(p))

Console.WriteLine(Probes.FirstOf((3, 4)))`, []string{"9:z", "7:q", "1:2:n", "5:v", "3:4"}}
            // Fully concrete: nothing erased, nothing to recover, unchanged.
            yield[]object{"a-fully-concrete-call-is-unchanged", `package P
import System
import Interop

Console.WriteLine(Probes.FirstOf[string]((9, "z")))
Console.WriteLine(Probes.SecondOf[string](("q", 7)))`, []string{"9:z", "7:q"}}
        }

        /// The MIRROR of the reported defect, found in review on #4019: a CONCRETE
        /// tuple at a SYMBOLIC method slot. These used to compile and emit IL
        /// ILVerify rejects; they are now refused.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The reviewer's shape, measured on this branch before the widening:
            // compiled, ran, printed `9:z`, and ilverify reported
            // [found ValueTuple`2<int32,object>] [expected ValueTuple`2<int32,T0>]
            // at `bad`'s offset 0x01 — the argument was pushed with NO conversion
            // at all (its own type IS the erased target), straight at a MethodSpec
            // closed over the real `T`. The source-side guard the first fix used —
            // "recover only when the ARGUMENT's elements are symbolic" — cannot see
            // this: the question that decides both directions is what the SLOT is.
            yield[]object{"a-concrete-tuple-does-not-reach-a-symbolic-slot", `package P
import System
import Interop

func bad[T](pair (int32, object)) string {
    return Probes.FirstOf[T](pair)
}

Console.WriteLine(bad[string]((9, "z")))`, "GS0155"}
            // The same mirror with the open element FIRST, so the refusal is not
            // an artefact of one position.
            yield[]object{"a-concrete-tuple-does-not-reach-a-symbolic-slot-in-the-first-position", `package P
import System
import Interop

func bad[T](pair (object, int32)) string {
    return Probes.SecondOf[T](pair)
}

Console.WriteLine(bad[string](("q", 7)))`, "GS0155"}
            // A tuple LITERAL whose element is a real type, at a slot still open:
            // `(int32, string)` is not a `(int32, T)` for an unresolved `T`.
            // `ValueTuple<...>` is INVARIANT, so element-wise identity is the only
            // relation there is — the same rule #3987 and #3984 already apply in
            // the constructor and `: base(...)` positions.
            yield[]object{"a-concrete-element-does-not-reach-an-open-slot", `package P
import System
import Interop

func bad[T](value T) string {
    return Probes.FirstOf[T]((9, "z"))
}

Console.WriteLine(bad[int32](1))`, "GS0155"}
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
