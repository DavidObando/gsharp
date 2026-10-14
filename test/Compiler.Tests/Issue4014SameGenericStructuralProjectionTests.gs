// <copyright file="Issue4014SameGenericStructuralProjectionTests.cs" company="GSharp">
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

/// Issue #4014: a closed `List[int32]` silently structurally-projected to
/// a `List[string]`, losing every element.
/// @remarks <b>The measured defect.</b> On the parent, `let zs List[string] =
/// xs` for an `xs List[int32]` holding one element compiled with NO
/// diagnostic, IL-verified (`dotnet ilverify`: <i>All Classes and Methods
/// … Verified</i>, run on the parent's own output), ran, and printed
/// `0`. The argument position of the same pair behaved identically. A
/// `List<int>` was silently replaced by a NEW, EMPTY
/// `List<string>`.
///
/// <b>Cause.</b> ADR-0148's `StructuralProjectionPlanner` only asks
/// "can the target be constructed from the source's public member surface?".
/// For two constructions of one generic that question answers yes for a reason
/// unrelated to the values: the two share a member surface BY CONSTRUCTION, and
/// the members that actually differ (the ones mentioning the type argument) are
/// exactly the ones a member-by-member copy cannot carry. For `List` the
/// incidental overlap is a parameterless constructor plus a settable
/// `Capacity`, so the plan copied a capacity and dropped the elements.
/// With both sides CLOSED the verdict reached `Conversion.ClassifyCore`'s
/// projection arm itself and `ConversionClassifier.BindConversion`
/// materialised the plan.
///
/// <b>Where the verdict lives, and why.</b> In
/// `StructuralProjectionPlanner.TryCreate` — not in `Conversion`'s
/// projection arm. THREE callers ask the planner directly: `Conversion`,
/// applicability's ADR-0148 `structuralProjectionArgumentCheck` (the
/// second half of #4006), and `ClrOverloadResolution`'s argument check.
/// Closing only the conversion arm would leave the other two open, which is
/// literally the #4006 shape. The rule is a pure SHAPE test on the two CLR
/// types — it does NOT call `Conversion.Classify`, because #4006 measured
/// that narrowing a projection callback with
/// `Conversion.Classify(...).Exists` breaks `Issue2889`.
///
/// <b>Three exclusions are load-bearing, and each has its own row.</b>
/// The first two came from measurement while writing the fix; the third came
/// from the Copilot review on PR #4029, which caught a real regression.
///
/// 1. <b>Identical closed types are untouched.</b> That is identity, not a projection.
/// 2. <b>An ADR-0004 ERASURE SURROGATE is not a closed type.</b> #2889's `List[Mode]` over a
/// same-compilation enum presents as `List<object>` while the `Action[List[Mode]]` slot it must reach
/// presents as `List<int>` — two closed types that differ for a reason having nothing to do with the
/// values, since the SYMBOLIC arguments are the same type. Comparing closed types alone turned that row
/// red (`GS0131: 'enumAction' is not a function`), so the rule also requires that neither side carry a
/// type argument whose own `ClrType` is null. A same-compilation G# generic is covered by the same
/// clause: measured on the parent AND here, a user `class Box[T]` projects `Box[int32]` to `Box[int64]`
/// and CARRIES the value, because a G# class's public fields ARE its state.
/// 3. <b>A pair whose MEMBER SURFACE carries the difference is untouched.</b> An imported `Box<T>` with
/// a settable `T Value` shows the author the incompatible member, so ADR-0148 §B explicit object spread
/// can supply it — `Box[string]{ ...boxOfInt, Value: "replacement" }` compiled on the parent and an
/// earlier revision of this PR broke it. The refusal is therefore reserved for a pair whose surfaces
/// are type-identical, where the difference lives in state the author cannot name. That is exactly
/// `List<T>`, and it keeps both spread spellings of the element loss closed — measured on the parent,
/// `List[string]{ ...xs }` and `List[string]{ ...xs, Capacity: 4 }` both compiled and both printed `0`,
/// which is why gating on the `strict` flag (the review's proposed remedy) was not taken.
///
/// <b>The green rows are the point.</b> A fix that only stops accepting
/// things is not a fix. The ADR-0148 arm this change guards still lowers a
/// genuine projection onto an imported CLR target (`CapSource ->
/// StringBuilder`), a user class still projects INTO a generic CLR target
/// when the definitions differ (`CapOnly -> List[string]` — the row that
/// shows the rule is about SAME-definition pairs, not about generics), identity
/// still assigns, and both of #4006's counterexamples stay green.
open class Issue4014SameGenericStructuralProjectionTests {
    /// The IMPORTED-parameter position of the same pair. This is the third
    /// caller of the planner (`ClrOverloadResolution`'s ADR-0148
    /// argument check), and the row records a diagnostic-id change rather than
    /// a soundness fix: on the parent the planner admitted the candidate and
    /// the conversion then refused it with `GS0155`; now the candidate is
    /// never applicable, so the call reports `GS0159`. Both reject. The
    /// row exists so that change is visible rather than discovered.
    @Fact
    func TheSamePairAtAnImportedParameter_IsStillRejected() {
        const Source = `package P
import System
import System.Collections.Generic
import Interop

let xs = List[int32]()
xs.Add(7)
Console.WriteLine(Probes.TakeStringList(xs))`
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_clr_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "ImportedParameter.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`the pair must not reach an imported parameter. Log:
` + "$appLog"))
            Assert.Contains("GS0159", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review finding 1 (Copilot on PR #4029). ADR-0148 §B EXPLICIT object
    /// spread between two constructions of one imported generic, where the
    /// author supplies the very member that carries the difference. This is
    /// valid, it compiled and printed `replacement`/`3` on the
    /// parent, and an earlier revision of this PR broke it.
    /// @remarks The guard now yields whenever the two constructions' member surfaces
    /// themselves differ — `Box[int32].Value` is `int32` where
    /// `Box[string].Value` is `string` — because then the author CAN
    /// see the incompatible member and supply it, and the ordinary member rules
    /// already decide the pair in both directions. The refusal is reserved for
    /// the case where the difference is invisible, which is what
    /// `List<T>` is.
    @Fact
    func AnExplicitSpreadThatSuppliesTheDifferingMember_StillProjects() {
        const Source = `package P
import System
import Interop

let src = Box[int32]{ Value: 7, Tag: 3 }
let dst = Box[string]{ ...src, Value: "replacement" }
Console.WriteLine(dst.Value)
Console.WriteLine(dst.Tag.ToString())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_spread_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "ExplicitSpread.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`an explicit spread supplying the member must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the case must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal([]string{"replacement", "3"}, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The other side of the boundary review finding 1 draws: the same spread
    /// WITHOUT an override for the differing member. Rejected on the parent and
    /// here, with the same precise message — the guard does not displace it.
    @Fact
    func AnExplicitSpreadThatDoesNotSupplyTheDifferingMember_IsRejected() {
        const Source = `package P
import System
import Interop

let src = Box[int32]{ Value: 7, Tag: 3 }
let dst = Box[string]{ ...src, Tag: 9 }
Console.WriteLine(dst.Tag.ToString())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_spreadneg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "ExplicitSpreadNoOverride.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`a spread that drops the differing member must not compile. Log:
` + "$appLog"))
            Assert.Contains("GS0490", appLog, StringComparison.Ordinal)
            Assert.Contains(
                "Source member 'Value' of type 'int32' is not implicitly convertible to 'string?'",
                appLog,
                StringComparison.Ordinal
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The IMPLICIT spelling of the same pair. Also unchanged: the surface
    /// carries the difference, so the ordinary member rules answer and the
    /// author still gets the message naming the member, not the new one naming
    /// the definition.
    @Fact
    func AnImplicitProjectionBetweenConstructionsWithADifferingSurface_KeepsItsOwnMessage() {
        const Source = `package P
import System
import Interop

let src = Box[int32]{ Value: 7, Tag: 3 }
let dst Box[string] = src
Console.WriteLine(dst.Tag.ToString())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_boximpl_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "ImplicitBox.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`the implicit spelling must not compile. Log:
` + "$appLog"))
            Assert.Contains("GS0490", appLog, StringComparison.Ordinal)
            Assert.Contains(
                "Source member 'Value' of type 'int32' is not implicitly convertible to 'string?'",
                appLog,
                StringComparison.Ordinal
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The legitimate neighbour of the row above: a genuine
    /// `List[string]` still reaches the same imported parameter, so the
    /// candidate was not simply removed from the overload set.
    @Fact
    func AGenuineArgumentStillReachesTheSameImportedParameter() {
        const Source = `package P
import System
import System.Collections.Generic
import Interop

let xs = List[string]()
xs.Add("a")
Console.WriteLine(Probes.TakeStringList(xs))`
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_clrok_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "GenuineImportedParameter.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.True(File.Exists(appPath), (`a genuine argument must still bind. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`the case must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("stringlist:1", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Two constructions of one generic definition no longer structurally
    /// project, at an assignment and at an argument alike.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func TwoConstructionsOfOneGeneric_DoNotProject(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every legitimate neighbour still compiles, IL-verifies, runs, and prints
    /// what it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("LegitimateCases")
    func ALegitimateNeighbour_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4014_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, Array.Empty[string]())
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

        /// The pairs that must no longer project.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The issue's own repro. On the parent this compiled, IL-verified, ran,
            // and printed `0` — one element in, zero out.
            yield[]object{"the-reported-repro-a-list-of-int32-does-not-project-to-a-list-of-string", `package P
import System
import System.Collections.Generic

let xs = List[int32]()
xs.Add(7)
let zs List[string] = xs
Console.WriteLine(zs.Count.ToString())`, "GS0490"}
            // The ARGUMENT position of the identical pair — the route the issue
            // predicted was "presumably reachable the same way". It is, and it is
            // the route the conversion arm alone would not have closed. Measured on
            // the parent: compiled, ran, printed `0`.
            yield[]object{"the-argument-position-of-the-same-pair-is-rejected", `package P
import System
import System.Collections.Generic

func take(zs List[string]) int32 { return zs.Count }

let xs = List[int32]()
xs.Add(7)
Console.WriteLine(take(xs).ToString())`, "GS0154"}
            // A two-parameter definition, differing only in the SECOND argument.
            // NOT a soundness row, and UNCHANGED by this PR: measured on the parent
            // AND here, this pair reports `GS0155: Cannot convert type
            // 'Dictionary[string, int32]' to 'Dictionary[string, int64]'`.
            //
            // It is kept because it is instructive about the two guards. The
            // same-definition test fires, but `MemberSurfaceCarriesTheDifference`
            // declines — `Dictionary`'s readable surface includes `Keys` and
            // `Values`, whose `KeyCollection[string, int32]` and
            // `KeyCollection[string, int64]` DO differ — so the ordinary member
            // rules answer, exactly as they did before. The pre-fix compiler's
            // soundness for `Dictionary` rested on the accident that it exposes no
            // settable member a plan could be built from, where `List` exposes
            // `Capacity`; that accident is no longer what is load-bearing.
            yield[]object{"a-dictionary-differing-only-in-its-value-type-is-rejected", `package P
import System
import System.Collections.Generic

let d = Dictionary[string, int32]()
d["k"] = 7
let e Dictionary[string, int64] = d
Console.WriteLine(e.Count.ToString())`, "GS0155"}
            // Review finding 1 (Copilot on PR #4029), the soundness half. An
            // explicit ADR-0148 §B object SPREAD reaches the planner with
            // `strict: false`, and on the parent both of these compiled and printed
            // `0` — the same element loss as the implicit assignment, written out.
            // The review's proposed remedy (gate the guard on `strict`) would have
            // reopened exactly these two, which is why the guard is gated on the
            // MEMBER SURFACE instead: `List`'s surface is `Capacity`/`Count`,
            // identically `int32` on both sides, so the author cannot supply what
            // they cannot name.
            yield[]object{"an-explicit-spread-of-the-same-pair-is-rejected", `package P
import System
import System.Collections.Generic

let xs = List[int32]()
xs.Add(7)
let zs = List[string]{ ...xs }
Console.WriteLine(zs.Count.ToString())`, "GS0490"}
            // The same spread WITH an explicit member that is not the one carrying
            // the difference. On the parent this compiled and printed `0` then `4`:
            // a capacity the author asked for, and every element gone.
            yield[]object{"an-explicit-spread-supplying-an-unrelated-member-is-still-rejected", `package P
import System
import System.Collections.Generic

let xs = List[int32]()
xs.Add(7)
let zs = List[string]{ ...xs, Capacity: 4 }
Console.WriteLine(zs.Count.ToString())`, "GS0490"}
            // The same pair reached through a G# function parameter rather than a
            // local, so the refusal cannot depend on how the value was introduced.
            yield[]object{"the-same-pair-is-rejected-when-the-source-is-a-parameter", `package P
import System
import System.Collections.Generic

func hand(xs List[int32]) int32 {
    let zs List[string] = xs
    return zs.Count
}

Console.WriteLine(hand(List[int32]()).ToString())`, "GS0490"}
        }

        /// Every legitimate neighbour that must keep binding.
        /// @returns Case name, G# source, expected stdout lines.
        func LegitimateCases() sequence[[]object] {
            // Identity is not a projection and must be untouched: same generic
            // definition, SAME closed type. This is also the shape of #2889's
            // erased slot, stated at its simplest.
            yield[]object{"control-identity-between-two-constructions-of-the-same-type-still-assigns", `package P
import System
import System.Collections.Generic

let a = List[int32]()
a.Add(7)
let b List[int32] = a
Console.WriteLine(b.Count.ToString())`, []string{"1"}}
            // The ADR-0148 arm this change guards, doing its real job: a G# class
            // projected onto an imported CLR target through its public settable
            // member surface. Without this row the fix would only be shown to say
            // no.
            yield[]object{"control-a-genuine-projection-onto-an-imported-clr-target-still-lowers", `package P
import System
import System.Text

class CapSource {
    var Capacity int32
    var Length int32
}

let builder StringBuilder = CapSource{Capacity: 24, Length: 0}
Console.WriteLine(builder.Capacity.ToString())`, []string{"24"}}
            // The row that pins the rule's SCOPE. The target is the very
            // `List[string]` the repro was refused at, and the very `Capacity` slot
            // that made the repro's plan nonsense — but the SOURCE is a different
            // type, so this is an ordinary ADR-0148 projection and stays legal.
            // The new rule is about two constructions of ONE definition, not about
            // generic targets and not about `Capacity`.
            yield[]object{"control-a-user-class-still-projects-into-a-generic-clr-target", `package P
import System
import System.Collections.Generic

class CapOnly {
    var Capacity int32
}

let lst List[string] = CapOnly{Capacity: 8}
Console.WriteLine(lst.Capacity.ToString())`, []string{"8"}}
            // The user-generic exclusion, measured rather than assumed. A
            // same-compilation `Box[T]` carries a null `ClrType` while binding, so
            // the rule cannot fire — and it must not, because here the projection
            // is FAITHFUL: a G# class's public fields ARE its state, so the value
            // arrives. Green on the parent and green here.
            yield[]object{"control-a-user-generic-class-projects-between-constructions-and-carries-the-value", `package P
import System

class Box[T] {
    public var Value T
}

let b = Box[int32]{ Value: 7 }
let c Box[int64] = b
Console.WriteLine(c.Value.ToString())`, []string{"7"}}
            // #4006's counterexample, and the reason the verdict is a shape test
            // rather than a `Conversion.Classify` call. `System.Action[List[Mode]]`
            // over a same-compilation enum presents its `Invoke` parameter as
            // `List<int>`, so both sides are constructions of `List<>` — but the
            // CLOSED types are identical, which is exactly what the rule requires
            // to be different. Comparing the SYMBOLIC arguments (`Mode` vs `int32`)
            // would have refused this. Also in
            // `Issue2889LambdaThunkNestedGenericTests`; kept here because it is
            // this change's counterexample too.
            yield[]object{"control-issue-2889-an-erased-invoke-slot-still-accepts-a-user-enum-list", `package P
import System
import System.Collections.Generic

enum Mode { First, Second }

let enumAction System.Action[List[Mode]] =
    (items List[Mode]) -> Console.WriteLine(items.Count.ToString())
enumAction(List[Mode]{ Mode.Second })`, []string{"1"}}
            // #4004's counterexample, kept green so any future attempt to decide
            // this per type-argument POSITION trips over it immediately.
            yield[]object{"control-task-continuewith-keeps-its-one-concrete-and-one-open-position", `package P
import System
import System.Threading.Tasks

let t = Task.CompletedTask
let c = t.ContinueWith[string](func(prev Task) string { return "cw" })
Console.WriteLine(c.Result)`, []string{"cw"}}
            // The remedy the diagnostic leaves the author: build the target and
            // move the elements yourself. It must remain expressible.
            yield[]object{"control-the-explicit-remedy-still-moves-every-element", `package P
import System
import System.Collections.Generic

let xs = List[int32]()
xs.Add(7)
xs.Add(8)

let zs = List[string]()
for v in xs {
    zs.Add(v.ToString())
}

Console.WriteLine(zs.Count.ToString())
Console.WriteLine(zs[1])`, []string{"2", "8"}}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            const LibrarySource = `using System.Collections.Generic;

namespace Interop;

public static class Probes
{
    public static string TakeStringList(List<string> items) => "stringlist:" + items.Count;
}

public class Box<T>
{
    public T? Value { get; set; }

    public int Tag { get; set; }
}`
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
