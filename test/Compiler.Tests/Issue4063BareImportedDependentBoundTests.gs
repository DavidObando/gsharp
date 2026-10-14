// <copyright file="Issue4063BareImportedDependentBoundTests.cs" company="GSharp">
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

/// Issue #4063: a BARE IMPORTED dependent constraint
/// (`where TDerived : TBase`) over two erased same-compilation classes.
/// @remarks <b>The repro, re-measured on <c>origin/main</c> @ <c>7708be7d</c>
/// before anything was written.</b> Against the imported
/// `Chain<TBase, TDerived> where TDerived : TBase`, the program
/// `var c Chain[ChA, ChB]` — with `ChA` and `ChB` unrelated
/// classes declared in the same compilation — compiled with no diagnostic and
/// threw `TypeLoadException: GenericArguments[1], 'P.ChB', on
/// 'HelperLib3.Chain`2[TBase,TDerived]' violates the constraint of type
/// parameter 'TDerived'` the first time the program touched the type.
///
/// <b>Root cause.</b> #4041 taught the imported constraint check to
/// answer a DEPENDENT bound on the SYMBOLIC vector, because the erased CLR
/// vector cannot tell two same-compilation classes apart — both project to a
/// `System.Object` placeholder. But the relation it implemented is
/// INVARIANT IDENTITY, which is correct at a generic ARGUMENT position
/// (`where U : IList<T>`, where `IList` is invariant in
/// `T`) and WRONG at the TOP of a bound, where the relation is
/// ASSIGNABILITY. Rather than answer with the wrong relation,
/// `MatchDependentShape` declined at depth 0 and handed the question back
/// to the erased CLR comparison — which substitutes the bound to
/// `object` and accepts everything. So this is a RELATION error on a path
/// that exists, not a missing check: the guard was load-bearing and correct
/// about identity, and only wrong to conclude that no answer was available.
///
/// <b>The repair, and why it is a call rather than a copy.</b> At the top
/// of the bound the question is now put to the symbols through
/// `Binder.SatisfiesDependentBound` — the very predicate #4043 wrote for
/// the G#-DECLARED spelling of this same bound
/// (`func take[TBase, TDerived TBase]()`). Reimplementing assignability
/// inside `ClrOverloadResolution` would let the imported and G#-declared
/// spellings of one rule drift apart, and it is drift, not the relation, that
/// manufactures a false `GS0152`. `SatisfiesDependentBound` already
/// accepts on every indeterminate answer, so a `false` from it
/// is a definitive "no"; a `true` is mapped back to
/// INDETERMINATE rather than to "matches", because it may equally mean "cannot
/// tell", and the CLR fallback accepts an erased vector anyway.
///
/// <b>Two guards keep the answer honest.</b> The relation is not asked
/// at all when either side still mentions a type parameter — an open
/// instantiation has no closed answer, and it is exactly there that
/// `SatisfiesDependentBound`'s self-substitution would need the bounded
/// parameter's own symbol, which the imported path does not have (it passes
/// `null`). And the whole symbolic arm is still gated on
/// `AnyDependentPositionIsErased`, so a fully imported vector keeps its
/// pre-#4041 answer.
///
/// <b>The message names the bound the author wrote.</b> The SUBSTITUTED
/// bound at a bare dependent position is the erasure — `System.Object` —
/// and "does not satisfy the 'System.Object' constraint" names the compiler's
/// internals rather than the program. The UNSUBSTITUTED bound is the generic
/// parameter itself, whose name is `TBase`, and that is what is reported.
///
/// <b>There was no asserting row to move.</b> #4063 was filed with prose
/// only: `Issue4041DependentConstraintOverErasedClassesTests`' remarks
/// record the gap, and its green control
/// `a-bare-dependent-bound-that-holds-over-erased-classes` is the row that
/// forced the decline. That control is unchanged and still green; the remarks
/// and the `atTopOfBound` documentation are updated to describe the answer
/// rather than the decline.
///
/// <b>Blast radius.</b> This turns previously-compiling code into an
/// error. The whole `.gs` corpus was swept before and after: 197 files,
/// 170 of which emit an assembly under the sweep's reference set,
/// <b>0 occurrences of GS0152</b>.
open class Issue4063BareImportedDependentBoundTests {
    /// A violated BARE dependent bound reports `GS0152` at compile time —
    /// exactly once — instead of emitting an instantiation the CLR refuses.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("BareBoundViolations")
    func AViolatedBareDependentBound_IsRefused(name string, body string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4063_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal)
            // Issue #4032's CI follow-up, inherited through #4041: assert the
            // COUNT, not the presence. The binder probes the same receiver
            // through several entry points before committing to a reading of
            // it, so a per-call report turns one violation into a count that is
            // a function of how many internal paths the binder happened to
            // take.
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

    /// Every legitimate neighbour compiles, IL-verifies, runs, and prints.
    /// These are the rows a false GS0152 would break.
    /// @param name The case name.
    /// @param body The G# body appended to the shared prelude.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("BareBoundControls")
    func ASatisfiedBareDependentBound_CompilesVerifiesAndRuns(name string, body string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4063_ok_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + body, appPath, "/target:exe", "/reference:" + libPath)
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
    /// bound failed, and the BOUND AS WRITTEN — `TBase`, not the
    /// `System.Object` the erasure substitutes into it. Without this the
    /// message would name the compiler's placeholder and tell an author
    /// nothing.
    @Fact
    func TheDiagnosticNamesTheBoundingParameterRatherThanTheErasure() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4063_msg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Prelude + `var c Chain[ChA, ChB]
Console.WriteLine("compiled")
`, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Contains("GS0152", appLog, StringComparison.Ordinal)
            Assert.Contains("'ChB'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TDerived'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TBase'", appLog, StringComparison.Ordinal)
            // Quoted, because the diagnostic format quotes the constraint it
            // names: a bare `System.Object` substring would also match an
            // unrelated `System.ObjectModel` in the reference warning.
            Assert.DoesNotContain("'System.Object'", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The issue's own C# library, verbatim, plus the generic METHOD spelling
        /// of the same bare bound.
        private const LibrarySource string = `namespace HelperLib3;

// The issue's own library, verbatim. A BARE dependent bound: the whole
// bound is a type parameter, so the relation at its top is
// assignability rather than the identity that is right at an argument
// position.
public class Chain<TBase, TDerived>
    where TDerived : TBase
{
    public string Tag { get; set; } = "chain";
}

public static class Picker
{
    public static string Pick<TBase, TDerived>()
        where TDerived : TBase
        => "picked";
}`

        /// The G# declarations every row shares: a base/derived pair, two unrelated
        /// classes, an interface with an implementor, and a source class deriving
        /// from an IMPORTED base.
        private const Prelude string = `package P
import System
import HelperLib3

open class ChBase {
    public var N int32
}

class ChDerived : ChBase {
    public var M int32
}

class ChA {
    public var P int32
}

class ChB {
    public var Q int32
}

interface IFoo {
    func Ping() int32;
}

class ChImpl : IFoo {
    public func Ping() int32 { return 1 }
}

class MyErr : Exception {
}
`

        /// Every instantiation whose BARE dependent bound is violated once the
        /// symbols are consulted. Each of these compiled with no diagnostic on the
        /// parent and threw `TypeLoadException` at run time.
        /// @returns Case name, the G# body appended to the prelude, expected diagnostic id.
        func BareBoundViolations() sequence[[]object] {
            // The issue's own repro, verbatim.
            yield[]object{"the-issues-own-repro", "var c Chain[ChA, ChB]\nConsole.WriteLine(\"compiled\")", "GS0152"}
            // The constructor spelling, which additionally emitted IL that
            // ILVerify refuses with UnsatisfiedMethodParentInst.
            yield[]object{
                "the-constructor-spelling-of-the-same-instantiation",
                "let c = Chain[ChA, ChB]()\nConsole.WriteLine(c.Tag)",
                "GS0152"
            }
            // Only ONE side erased is enough: an IMPORTED `string` at TDerived
            // against a same-compilation `ChA` at TBase. `string` is sealed and
            // derives from nothing the program declares.
            yield[]object{
                "an-imported-derived-against-an-erased-base",
                "var c Chain[ChA, string]\nConsole.WriteLine(\"compiled\")",
                "GS0152"
            }
            // A VALUE TYPE at a class-typed bound. The CLR admits a value type at
            // a dependent bound only when the bound is `object` (measured against
            // the runtime, see the green row below); `ChBase` is not.
            yield[]object{
                "a-value-type-at-a-class-typed-bound",
                "var c Chain[ChBase, int32]\nConsole.WriteLine(\"compiled\")",
                "GS0152"
            }
            // The bound is a same-compilation INTERFACE the argument does not
            // implement. The relation is implementation, not derivation, and both
            // arms belong to assignability.
            yield[]object{
                "an-interface-bound-the-argument-does-not-implement",
                "var c Chain[IFoo, ChA]\nConsole.WriteLine(\"compiled\")",
                "GS0152"
            }
            // Assignability is DIRECTED, and getting the direction wrong is the
            // most likely way to reintroduce the defect: `ChBase` does not derive
            // from `ChDerived`, so the reversed spelling of the green control must
            // be refused.
            yield[]object{
                "the-reversed-derivation",
                "var c Chain[ChDerived, ChBase]\nConsole.WriteLine(\"compiled\")",
                "GS0152"
            }
        }

        /// Every shape the repair must NOT reject. A wrong "no" on any of these is
        /// a worse defect than the one being fixed, which is why an indeterminate
        /// symbolic answer falls back to the CLR comparison rather than to a
        /// rejection.
        /// @returns Case name, the G# body appended to the prelude, expected stdout lines.
        func BareBoundControls() sequence[[]object] {
            // THE row that forced #4041 to decline here, and the reason closing
            // #4063 with identity would have been the worse failure. It is a green
            // row in `Issue4041DependentConstraintOverErasedClassesTests` too, and
            // it stays green there.
            yield[]object{
                "a-bare-dependent-bound-that-holds-over-erased-classes",
                "var c Chain[ChBase, ChDerived]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // Identity is one arm of assignability, not a violation of it.
            yield[]object{
                "the-identical-erased-class-on-both-sides",
                "var c Chain[ChBase, ChBase]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // The interface arm, satisfied. A same-compilation class has no CLR
            // type while binding, so this is answered off the symbol's declared
            // interface list.
            yield[]object{
                "a-source-class-implementing-the-bound-interface",
                "var c Chain[IFoo, ChImpl]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // Fully IMPORTED: nothing is erased, the symbolic arm never fires, and
            // the pre-#4041 path answers exactly as before.
            yield[]object{
                "the-issues-own-fully-imported-control",
                "var c Chain[object, string]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // `where TDerived : TBase` with TBase = object is the UNIVERSAL bound:
            // a value type satisfies it. Measured against the runtime —
            // `typeof(Chain<,>).MakeGenericType(typeof(object), typeof(int))`
            // constructs and instantiates, while the `ChBase` spelling above
            // throws ArgumentException.
            yield[]object{
                "the-universal-object-bound-admits-a-value-type",
                "var c Chain[object, int32]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // Two IMPORTED types related by derivation. Not erased at all, so this
            // pins that the gate on `AnyDependentPositionIsErased` still holds.
            yield[]object{
                "two-imported-types-related-by-derivation",
                "var c Chain[Exception, InvalidOperationException]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // A SOURCE class deriving from an IMPORTED base, checked against that
            // imported base. The symbol has no CLR type of its own, so the walk has
            // to reach `ImportedBaseType`.
            yield[]object{
                "a-source-class-deriving-from-the-imported-bound",
                "var c Chain[Exception, MyErr]\nConsole.WriteLine(\"compiled\")",
                []string{"compiled"}
            }
            // OPEN: the bound is forwarded through a G# generic, so both sides
            // still mention type parameters and there is no closed answer. The
            // check must decline; the CLR only loads the instantiation once closed.
            yield[]object{"an-open-forwarded-instantiation-is-left-alone", `class Holder[TB, TD TB] {
    public var C Chain[TB, TD]
}

Console.WriteLine("compiled")`, []string{"compiled"}}
            // The generic METHOD spelling of the same bare bound, satisfied. The
            // imported METHOD path has had its own constraint check since
            // #750/ADR-0088 and shares this checker.
            yield[]object{
                "a-generic-method-with-a-matched-bare-bound",
                "Console.WriteLine(Picker.Pick[ChBase, ChDerived]())",
                []string{"picked"}
            }
            // Review finding: the row that actually EXERCISES
            // `MatchDependentTopOfBound`'s open-side guard. The generic TYPE path
            // never reaches it with an open vector — `ReportUnsatisfiedGenericTypeConstraint`
            // short-circuits an open instantiation into #4037's forwarding rule
            // before `SatisfiesGenericTypeConstraints` is called at all, so
            // `an-open-forwarded-instantiation-is-left-alone` above proves the
            // program binds but not that the guard was consulted. The imported
            // generic METHOD path DOES hand the checker unsubstituted symbols, so
            // forwarding the bare bound through a G# generic function is where a
            // guard that answered instead of declining would manufacture a
            // GS0152 on a legal program.
            yield[]object{"an-open-forwarded-bare-bound-at-a-generic-method", `func pick[TB, TD TB]() string {
    return Picker.Pick[TB, TD]()
}

Console.WriteLine(pick[ChBase, ChDerived]())`, []string{"picked"}}
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
