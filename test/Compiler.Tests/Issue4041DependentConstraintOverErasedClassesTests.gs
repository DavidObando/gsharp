// <copyright file="Issue4041DependentConstraintOverErasedClassesTests.cs" company="GSharp">
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

/// Issue #4041: a DEPENDENT generic constraint checked after erasure has
/// collapsed two distinct same-compilation classes.
/// @remarks <b>The repro, re-measured on <c>origin/main</c> @ <c>3e5103de</c>
/// before anything was written.</b> Against the imported
/// `Coupled<T, U> where U : IList<T>`, the program
/// `var c Coupled[A, List[Bee]]` — with `A` and `Bee` unrelated
/// classes declared in the same compilation — compiled with no diagnostic and
/// threw `TypeLoadException: GenericArguments[1],
/// 'System.Collections.Generic.List`1[P.Bee]', on 'HelperLib3.Coupled`2[T,U]'
/// violates the constraint of type parameter 'U'` the first time the program
/// touched the type.
///
/// <b>Root cause.</b> A same-compilation class has no CLR type while
/// binding, so it projects to a `System.Object` placeholder. Both `A`
/// and `Bee` therefore arrive as `object`, and the vector handed to
/// the constraint check is `Coupled<object, List<object>>`.
/// `SatisfiesDeclaredConstraints` substitutes that vector into each bound
/// before testing it, so `U : IList<T>` becomes
/// `IList<object>` — and `List<object>` genuinely does
/// satisfy it. The check answered honestly on what it was given; the
/// information that distinguishes `A` from `Bee` was gone before it
/// was asked. Emission then reified the real types, so the instantiation the
/// CLR sees is the one that violates the bound.
///
/// <b>#4016/#4031's <c>NormaliseErasedTypeArgsForConstraintCheck</c> is
/// NOT the culprit, and this was verified rather than taken on trust.</b> That
/// normalisation replaces an erased position with the load context's own
/// `System.Object` so a projection cannot break a SIBLING parameter's
/// constraint. It operates on the vector AFTER the collapse; the collapse
/// itself happens earlier, in `ProjectGenericArgument`. Normalising a
/// placeholder more carefully cannot recover which class it stood for.
///
/// <b>The repair, and why it is three-state.</b> The declared bound is
/// now kept UNSUBSTITUTED, and when it mentions another type parameter whose
/// argument arrived erased, the question is put to the SYMBOLS instead: build
/// the expected bound `IList[A]` from the symbolic vector, recover
/// `List[Bee]`'s own instantiation of `IList<>` as
/// `IList[Bee]`, and compare. A definitive no rejects, a definitive yes
/// accepts, and ANYTHING ELSE falls through to the pre-existing CLR comparison
/// — never to a rejection. A wrong "no" would be a GS0152 on a legal program,
/// which is a strictly worse failure than the one being fixed.
///
/// <b>Two cases force the fallback, and each has its own green row.</b>
/// VARIANCE: `IEnumerable<out T>` is covariant, so
/// `Covariant[CovBase, List[CovDerived]]` is legal C# and identity is the
/// wrong relation. The TOP OF A BOUND: identity is right at an invariant
/// ARGUMENT position and wrong at the top, where the relation is assignability
/// — so a bare `where TDerived : TBase` instantiated as
/// `Chain[ChBase, ChDerived]` must keep binding.
///
/// The second one is load-bearing rather than defensive, and that was
/// MEASURED: with `MatchDependentShape`'s `depth == 0` guard disabled
/// and nothing else changed, `a-bare-dependent-bound-that-holds-over-erased-classes`
/// fails with a false `GS0152` (1 red / 11 green on that build).
///
/// <b>#4063 has since replaced the decline with an answer, and this row
/// is why it could not simply be identity.</b> The cost of declining at the top
/// of a bound was that the imported spelling of a bare dependent bound over two
/// UNRELATED erased classes stayed accepted — the imported analogue of #4043,
/// needing symbolic ASSIGNABILITY rather than identity, filed as #4063 and now
/// closed by routing that position through
/// `Binder.SatisfiesDependentBound`, the predicate #4043 already used for
/// the G#-declared spelling. The guard itself is unchanged in substance:
/// identity is still refused at the top, and an indeterminate assignability
/// answer still falls through to the CLR comparison rather than to a
/// rejection. Accepting too much was the recoverable direction; a false GS0152
/// on a legal program is not, and
/// `a-bare-dependent-bound-that-holds-over-erased-classes` below is the
/// row that proves it still binds. The violating spellings live in
/// `Issue4063BareImportedDependentBoundTests`.
///
/// <b>The asserting row this issue was filed with has been moved, not
/// deleted.</b> `Issue4032ConstrainedImportedGenericBaseTests` pinned this
/// gap as `ADependentConstraintOverTwoErasedClasses_IsStillAccepted_Issue4041`,
/// asserting that the program compiled and then threw, with a message telling
/// whoever closed the issue to move it. The violating spellings are now rows in
/// that class's `ConstraintViolations` and the matched, imported and
/// covariant spellings are rows in its `DependentBoundControls`. This
/// class is the issue's own library and repro, kept verbatim.
open class Issue4041DependentConstraintOverErasedClassesTests {
    /// A violated dependent bound reports `GS0152` at compile time —
    /// exactly once — instead of emitting an instantiation the CLR refuses.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("DependentViolations")
    func AViolatedDependentBoundOverErasedClasses_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4041_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal)
            // Issue #4032's CI follow-up, inherited: assert the COUNT, not the
            // presence. The binder probes the same receiver through several
            // entry points before committing to a reading of it, so a per-call
            // report turns one violation into a count that is a function of how
            // many internal paths the binder happened to take.
            let occurrences = appLog.Split(expectedId, StringSplitOptions.None).Length - 1
            Assert.True(
                occurrences == 1,
                (`'` + "$name" + `' must report ` + "$expectedId" + ` exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every satisfied shape compiles, IL-verifies, runs, and prints. These are
    /// the rows a false GS0152 would break.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("SatisfiedShapes")
    func ASatisfiedDependentBound_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4041_ok_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
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

    /// The `GS0152` text names the type argument, the type PARAMETER whose
    /// bound failed, and the bound itself — so an author reading it can see
    /// that `U` is the problem and `IList` is the bound, rather than
    /// meeting a `TypeLoadException` at run time with no source location
    /// at all.
    @Fact
    func TheDiagnosticNamesTheArgumentTheParameterAndTheBound() {
        const Source = `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

var c Coupled[A, List[Bee]]
Console.WriteLine("compiled")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4041_msg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Contains("GS0152", appLog, StringComparison.Ordinal)
            Assert.Contains("'U'", appLog, StringComparison.Ordinal)
            Assert.Contains("List[Bee]", appLog, StringComparison.Ordinal)
            Assert.Contains("IList", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The issue's own C# library, verbatim, plus the covariant and
        /// two-parameter shapes the controls need.
        private const LibrarySource string = (`namespace HelperLib3;

using System.Collections.Generic;

public class Coupled<T, U>
    where U : IList<T>
{
    public string Tag { get; set; } = "coupled";
}

public class Covariant<T, U>
    where U : IEnumerable<T>
{
    public string Tag { get; set; } = "covariant";
}

public class Nested<T, U>
    where U : IList<List<T>>
{
    public string Tag { get; set; } = "nested";
}

// A BARE dependent bound. Its relation is assignability, not identity:
// ` + "`" + `Chain<ChBase, ChDerived>` + "`" + ` is legal, so identity at the top of a bound
// would be a false rejection. Issue #4063 answers that position with
// symbolic ASSIGNABILITY instead; the row below pins that it still binds.
public class Chain<TBase, TDerived>
    where TDerived : TBase
{
    public string Tag { get; set; } = "chain";
}

// Review finding (#4068): an imported GENERIC interface a source class
// can implement DIRECTLY, rather than inheriting through an imported
// base. The symbolic walk used to follow only ` + "`" + `ImportedBaseType` + "`" + `.
public interface IDep<T>
{
    T? Item { get; }
}

public class Coupled3<T, U>
    where U : IDep<T>
{
    public string Tag { get; set; } = "coupled3";
}

// Review finding (#4068): a bound nested far deeper than the old
// hard-coded recursion cap of eight.
public class Deep<T, U>
    where U : IList<List<List<List<List<List<List<List<List<List<List<T>>>>>>>>>>>
{
    public string Tag { get; set; } = "deep";
}

public static class Probe
{
    public static string Take<T, U>(U value)
        where U : IList<T>
        => "took";
}`)

        /// Every instantiation whose dependent bound is VIOLATED once the symbols
        /// are consulted. Each of these compiled with no diagnostic on the parent
        /// and threw `TypeLoadException` at run time.
        /// @returns Case name, G# source, expected diagnostic id.
        func DependentViolations() sequence[[]object] {
            // The issue's own repro, verbatim.
            yield[]object{"the-issues-own-repro", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

var c Coupled[A, List[Bee]]
Console.WriteLine("compiled")`, "GS0152"}
            // The constructor spelling, which the issue records as additionally
            // failing `ilverify` with `UnsatisfiedMethodParentInst`.
            yield[]object{"the-constructor-spelling-of-the-same-instantiation", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

let c = Coupled[A, List[Bee]]()
Console.WriteLine(c.Tag)`, "GS0152"}
            // Only ONE side erased is enough to lose the answer: an imported
            // `string` against a same-compilation `Bee` collapses the `Bee` half.
            yield[]object{"one-erased-side-against-an-imported-one", `package P
import System
import System.Collections.Generic
import HelperLib3

class Bee {
    public var M int32
}

var c Coupled[string, List[Bee]]
Console.WriteLine("compiled")`, "GS0152"}
            // REVIEW FINDING (#4068), the serious half. A source class that
            // implements the imported generic interface DIRECTLY —
            // `class Impl : IDep[Bee]` — reached the symbolic walk, which followed
            // only `ImportedBaseType`, found nothing, and returned "no answer". The
            // erased comparison then saw `IDep<object>` on both sides and ACCEPTED
            // this, and it threw `TypeLoadException` at run time. That is this
            // change's own defect reached by a different route.
            yield[]object{"review-a-source-class-implementing-the-bound-generic-interface", `package P
import System
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

class Impl : IDep[Bee] {
    public prop Item Bee { get { return nil } }
}

var c Coupled3[A, Impl]
Console.WriteLine("compiled")`, "GS0152"}
            // REVIEW FINDING (#4068): eleven levels of invariant nesting, well past
            // the recursion cap of eight the first version of this check imposed.
            // At that cap the shape returned indeterminate and fell back to the
            // erased comparison — the very hole the check exists to close — so the
            // cap was replaced by cycle detection.
            yield[]object{"review-a-bound-nested-past-the-old-recursion-cap", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

var d Deep[A, List[List[List[List[List[List[List[List[List[List[List[Bee]]]]]]]]]]]]
Console.WriteLine("compiled")`, "GS0152"}
            // NESTED erasure: the bound is `IList<List<T>>`, so the comparison has
            // to recurse rather than stop at a reference check on the outer
            // construction.
            yield[]object{"a-nested-dependent-bound-over-two-erased-classes", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

class Bee {
    public var M int32
}

var c Nested[A, List[List[Bee]]]
Console.WriteLine("compiled")`, "GS0152"}
        }

        /// Every shape the repair must NOT reject. A wrong "no" on any of these is
        /// a worse defect than the one being fixed, which is why the symbolic check
        /// falls back to the CLR comparison rather than to a rejection.
        /// @returns Case name, G# source, expected stdout lines.
        func SatisfiedShapes() sequence[[]object] {
            // MATCHED, same-compilation: both positions are the same erased class,
            // so the symbols agree even though the CLR vector cannot tell.
            yield[]object{"matched-over-one-same-compilation-class", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

var c Coupled[A, List[A]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // MATCHED, fully imported: nothing is erased, so the trigger never
            // fires and the pre-existing path answers exactly as before.
            yield[]object{"matched-over-imported-types", `package P
import System
import System.Collections.Generic
import HelperLib3

var c Coupled[string, List[string]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // COVARIANT: `IEnumerable<out T>` admits `List<CovDerived>` at
            // `IEnumerable<CovBase>`, so identity is the wrong relation and the
            // symbolic path must decline to answer.
            yield[]object{"a-covariant-bound-over-a-derived-erased-class", `package P
import System
import System.Collections.Generic
import HelperLib3

open class CovBase {
    public var N int32
}

class CovDerived : CovBase {
    public var M int32
}

var c Covariant[CovBase, List[CovDerived]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // MATCHED nested.
            yield[]object{"matched-nested-over-one-same-compilation-class", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

var c Nested[A, List[List[A]]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // OPEN: the bound is forwarded through a G# generic, so the arguments
            // still mention type parameters and there is no closed answer. The
            // check must leave it alone; the CLR only loads it once closed.
            yield[]object{"an-open-forwarded-instantiation-is-left-alone", `package P
import System
import System.Collections.Generic
import HelperLib3

class Holder[T] {
    public var C Coupled[T, List[T]]
}

let h = Holder[string]()
Console.WriteLine("compiled")`, []string{"compiled"}}
            // A BARE dependent bound (`where TDerived : TBase`) over two erased
            // same-compilation classes where the relation genuinely HOLDS. This is
            // the row that caught a false rejection during development: at the TOP
            // of a bound the relation is assignability, not the invariant identity
            // that is correct at an argument position, so the symbolic path
            // deliberately declines to answer there.
            yield[]object{"a-bare-dependent-bound-that-holds-over-erased-classes", `package P
import System
import HelperLib3

open class ChBase {
    public var N int32
}

class ChDerived : ChBase {
    public var M int32
}

var c Chain[ChBase, ChDerived]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // REVIEW FINDING (#4068) control: the MATCHED spelling of the
            // source-implements-the-bound-interface shape must keep binding.
            yield[]object{"review-a-source-class-implementing-the-bound-interface-matched", `package P
import System
import HelperLib3

class A {
    public var N int32
}

class Impl : IDep[A] {
    public prop Item A { get { return A() } }
}

var c Coupled3[A, Impl]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // REVIEW FINDING (#4068) control: the deeply nested bound SATISFIED.
            // Removing the cap must not turn a legal deep bound into a rejection.
            yield[]object{"review-a-deeply-nested-bound-that-holds", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

var d Deep[A, List[List[List[List[List[List[List[List[List[List[List[A]]]]]]]]]]]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            // A generic METHOD carrying the same dependent bound: the imported
            // METHOD path has had its own constraint check since #750/ADR-0088, and
            // it must keep accepting the matched spelling.
            yield[]object{"a-generic-method-with-a-matched-dependent-bound", `package P
import System
import System.Collections.Generic
import HelperLib3

class A {
    public var N int32
}

Console.WriteLine(Probe.Take[A, List[A]](List[A]()))`, []string{"took"}}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib3",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib3.dll")
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
