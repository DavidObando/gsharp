// <copyright file="Issue4124SourceClassSatisfiesImportedInterfaceBoundTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4124: a SAME-COMPILATION class that implements an IMPORTED interface
/// must satisfy a `[T IDisposable]` bound — at a generic function call and
/// at a generic type construction alike.
/// @remarks <b>The repro, re-measured on <c>origin/main</c> @ <c>26df552b</c> with
/// a rebuilt <c>gsc</c> before anything was written.</b> For
/// `class D : IDisposable`, both `take[D]()` and `Box[D]()`
/// reported `GS0152: Type argument 'D' ... does not satisfy the
/// 'System.IDisposable' constraint.` — a FALSE REJECTION of ordinary,
/// idiomatic code, which is the worse direction of this rule's two failure
/// modes. `csc` accepts the C# equivalent and so does the CLR.
///
/// <b>The mechanism.</b> `Binder.SatisfiesConstraint`'s
/// `ClrInterfaceConstraint` arm calls
/// `Binder.SatisfiesClrInterfaceConstraint`, which read
/// `typeArgument.ClrType.GetInterfaces()`. A same-compilation class has
/// no CLR type until emit, so that returned `false` at its
/// second guard — before looking at anything the symbol knows about itself.
/// The symbol does know: `StructSymbol.ImplementedClrInterfaces` holds
/// exactly `IDisposable` for `class D : IDisposable`.
///
/// <b>The FOURTH appearance of one defect, and why this closes the
/// class rather than the instance.</b> The same blindness was repaired three
/// times before, each at whichever site happened to hit it: #4061 at the
/// imported class-chain walk, #4068 at `Binder.SatisfiesDependentBound`
/// (which is where `SourceSymbolImplementsImportedInterface` was
/// written), and #4092's review round at
/// `Binder.TypeParameterForwardsUserDeclaredConstraints` — that one by
/// CALLING #4068's walk rather than copying it. This change does not add a
/// fourth caller-side patch. It moves the fallback INTO
/// `SatisfiesClrInterfaceConstraint` itself, splitting the reflective
/// body out as `SatisfiesClrInterfaceConstraintReflectively` and wrapping
/// EVERY exit of it, then DELETES the two copies that were sitting at #4068's
/// and #4092's call sites. All three symbolic askers now bottom out in one
/// predicate, so a fifth site cannot appear: any future caller of the leaf
/// gets the symbolic answer for free.
///
/// <b>Why it was not done in #4092.</b> `Binder.SatisfiesConstraint`
/// is the central constraint predicate — it also gates extension-method
/// candidate unification in `BoundScope.TryUnifyAndCheckConstraints`,
/// where widening acceptance can turn a previously-skipped candidate into an
/// ambiguity. That is a blast radius that wants its own sweep rather than a
/// ride on an unrelated PR. The widening is MONOTONE in the satisfaction
/// direction — it only turns a `false` into a
/// `true`, and only for an argument with NO CLR type, which is
/// exactly the case reflection cannot see — so nothing the reflective path
/// already answers changes.
///
/// <b>The self-referential row was a bonus, and it was measured.</b>
/// `class Cmp : IComparable[Cmp]` against `[T IComparable[T]]` was
/// ALSO red on the parent, for the same reason. The reflective half already
/// substitutes the argument for the constrained parameter
/// (`GenericConstraintArgumentsMatch`); the symbolic half did not, so the
/// expected vector stayed `[T]` and never matched `[Cmp]`. Giving
/// the symbolic walk the same substitution is parity between the two halves of
/// one predicate, not a second feature.
///
/// <b>The consolidation was load-bearing within days.</b> Issue #4136
/// was filed independently against this very site while #4089/#4090 were being
/// closed — a same-compilation class failing an imported interface constraint
/// at a CONSTRUCTOR — and its stated fix was "route the arm through
/// `BoundCarriesClrInterface`", which is the fifth copy. Because the
/// fallback moved INTO the leaf instead, #4136's repro is answered here with
/// no additional code: measured `2 × GS0152` on this branch's parent
/// `b4478875` and `de` on this branch. It is a row below. Its
/// sibling #4139 is NOT closed here and is NOT the same defect — that one is
/// `IsNonNullableValueTypeForConstraint` missing an `EnumSymbol` arm
/// for the `struct`/`unmanaged` constraints, a different predicate
/// that never consults the interface walk. Measured red on the parent AND on
/// this branch (`2 × GS0152` both), and left where it belongs.
open class Issue4124SourceClassSatisfiesImportedInterfaceBoundTests {
    /// A same-compilation class that implements the imported interface now
    /// satisfies the bound, compiles, IL-verifies and runs.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("NowBinding")
    func ASourceClassSatisfiesAnImportedInterfaceBound(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4124_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(appPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal(expectedLines, SplitLines(output))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A type that does not carry the interface is still refused, with
    /// `GS0152` reported exactly once.
    /// @param name The case name.
    /// @param source The G# source.
    @Theory
    @MemberData("StillRefused")
    func ATypeThatDoesNotCarryTheInterfaceIsStillRefused(name string, source string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4124_neg_").FullName
        try {
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // Assert the COUNT, not the presence: a per-call report would turn
            // one violation into a number that is a function of how many
            // internal paths the binder happened to take.
            let occurrences = appLog.Split("GS0152", StringSplitOptions.None).Length - 1
            Assert.True(occurrences == 1, (`'` + "$name" + `' must report GS0152 exactly once, saw ` + "$occurrences" + `. Log:
` + "$appLog"))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The blast-radius row named by the issue: `SatisfiesConstraint` also
    /// gates extension-method candidate unification in
    /// `BoundScope.TryUnifyAndCheckConstraints`, where widening acceptance
    /// newly ADMITS a candidate — so the fallback here carries the SAME invoked
    /// name and genuinely competes with it.
    /// @remarks <b>Review finding, and it overturned an earlier claim of mine.</b>
    /// The first version of this row used a differently-named fallback
    /// (`DescribeAny`), which proves the constrained candidate is
    /// REACHABLE but can never observe a moved winner, because the two names
    /// never compete. Re-measured with a same-named fallback and a rebuilt
    /// compiler on each side, a winner DOES move:
    ///
    /// ```xmldoc
    /// <list type="table">
    /// <item><description><c>D().Describe()</c> over
    /// <c>Describe[T IDisposable](T)</c> + <c>Describe(object)</c> —
    /// <c>csc</c> <c>disposable</c>; parent <c>b4478875</c> <c>object</c>;
    /// here <c>disposable</c>. The constrained candidate was not applicable on
    /// the parent, so the boxing one won by default; now both are applicable
    /// and the more specific one wins. The move is TOWARD <c>csc</c> — the
    /// same divergence class as #4086 — and was verified by compiling and
    /// running the C# equivalent. It is THIS change's move, not #4086's:
    /// re-measured after rebasing onto <c>a83abc98</c>, which carries #4108's
    /// fix for #4086, the parent still answers <c>object</c>. The two repairs
    /// are adjacent but independent — #4108 fixed inferred type-parameter
    /// IDENTITY during ranking, this one fixed candidate APPLICABILITY before
    /// ranking runs.</description></item>
    /// <item><description><c>E().Describe()</c>, where <c>E</c> does NOT
    /// implement the interface — parent <c>any</c>; here <c>any</c>. The
    /// constrained candidate stays inapplicable, so nothing moves. This is the
    /// row that proves the widening is not indiscriminate.</description></item>
    /// </list>
    /// ```
    @Fact
    func AConstrainedExtensionIsReachedAndTheMoreSpecificOneWins() {
        const Source = `package P
import System

class D : IDisposable {
    public func Dispose() {
    }
}

func (value T) Describe[T IDisposable]() string {
    return "disposable"
}

func (value object) Describe() string {
    return "object"
}

Console.WriteLine(D().Describe())`
        const ReceiverFailsConstraint = `package P
import System

class E {
}

func (value T) Describe[T IDisposable]() string {
    return "disposable"
}

func (value U) Describe[U]() string {
    return "any"
}

Console.WriteLine(E().Describe())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4124_ext_").FullName
        try {
            for (name, source, expected) in[](string, string, string){
                ("Specific", Source, "disposable"),
                ("FallbackWins", ReceiverFailsConstraint, "any")
            } {
                let appPath = Path.Combine(tempDir, name + ".dll")
                let appLog = Compile(tempDir, name + ".gs", source, appPath, "/target:exe")
                Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
                IlVerifier.Verify(appPath, Array.Empty[string]())
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run. Exit ` + "$exit" + `:
` + "$output"))
                Assert.Equal(expected, output.Trim())
            }
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The rankings that do NOT move, measured on the parent and here. These
    /// bound the claim the row above makes: exactly one winner moves, and it
    /// moves toward `csc`.
    /// @remarks `TryUnifyAndCheckConstraints` scores specificity from the
    /// `struct`/`class` flags only, so an interface bound is worth 0
    /// and two same-name GENERIC extensions that both survive TIE. Measured:
    /// the pair below reported `GS0266` (ambiguous) on the parent AND
    /// here, so no program that compiled before stops compiling. The
    /// free-function pair `f[T IDisposable](T)` / `f(object)` picks
    /// the generic one on the parent AND here.
    @Fact
    func TheRankingsThatDoNotMove() {
        const AmbiguousExtensions = `package P
import System

class D : IDisposable {
    public func Dispose() {
    }
}

func (value T) Describe[T IDisposable]() string {
    return "disposable"
}

func (value U) Describe[U]() string {
    return "any"
}

Console.WriteLine(D().Describe())`
        const FreeFunctions = `package P
import System

class D : IDisposable {
    public func Dispose() {
    }
}

func f[T IDisposable](x T) string {
    return "generic"
}

func f(x object) string {
    return "object"
}

Console.WriteLine(f(D()))`
        let tempDir = Directory.CreateTempSubdirectory("gs_4124_rank_").FullName
        try {
            // Ambiguous on the parent and ambiguous here — an interface bound
            // is worth 0 specificity, so two same-name GENERIC extensions tie
            // whether or not the constrained one is applicable.
            let ambiguousPath = Path.Combine(tempDir, "Ambiguous.dll")
            let ambiguousLog = Compile(tempDir, "Ambiguous.gs", AmbiguousExtensions, ambiguousPath, "/target:exe")
            Assert.DoesNotContain("GS9998", ambiguousLog, StringComparison.Ordinal)
            Assert.False(File.Exists(ambiguousPath), (`the same-name generic extension pair must stay ambiguous. Log:
` + "$ambiguousLog"))
            let occurrences = ambiguousLog.Split("GS0266", StringSplitOptions.None).Length - 1
            Assert.True(occurrences == 1, (`the ambiguity must be reported exactly once, saw ` + "$occurrences" + `. Log:
` + "$ambiguousLog"))
            // The constrained generic already won on the parent and still does.
            let freePath = Path.Combine(tempDir, "Free.dll")
            let freeLog = Compile(tempDir, "Free.gs", FreeFunctions, freePath, "/target:exe")
            Assert.True(File.Exists(freePath), (`the free-function pair must compile. Log:
` + "$freeLog"))
            IlVerifier.Verify(freePath, Array.Empty[string]())
            let (exit, output) = RunDotnet(freePath)
            Assert.True(exit == 0, (`the free-function pair must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("generic", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Review finding: the self-reference in a generic interface bound may be
    /// NESTED — `[T IComparable[List[T]]]` — and the substitution is
    /// recursive, on BOTH halves of the predicate.
    /// @remarks The flat shape was closed by comparing the whole argument against
    /// the constrained parameter, which misses `List[T]`. Measured on this
    /// branch's parent `b4478875` AND on the first version of this change:
    /// `class C : IComparable[List[C]]` against
    /// `[T IComparable[List[T]]]` reported `GS0152`, the same
    /// false-rejection class as the issue, one level down.
    ///
    /// BOTH halves were red, and both are rows here: the SYMBOLIC half
    /// (a same-compilation argument, which has no CLR type) and the REFLECTIVE
    /// half (an imported argument, which has one). Fixing only one would have
    /// broken the parity this predicate's two halves are supposed to keep —
    /// they must agree on WHAT the expected argument is.
    @Fact
    func ANestedSelfReferenceIsSubstitutedOnBothHalves() {
        const SourceArgument = `package P
import System
import System.Collections.Generic

class C : IComparable[List[C]] {
    public func CompareTo(other List[C]?) int32 {
        return 0
    }
}

func take[T IComparable[List[T]]]() string {
    return "nested-ok"
}

Console.WriteLine(take[C]())`
        // The NEGATIVE: the nesting must still be COMPARED, not merely walked
        // through. `IComparable[List[Other]]` is not `IComparable[List[C2]]`.
        const WrongNestedArgument = `package P
import System
import System.Collections.Generic

class Other {
}

class C2 : IComparable[List[C2]] {
    public func CompareTo(other List[C2]?) int32 {
        return 0
    }
}

func take[T IComparable[List[Other]]]() string {
    return "nested-ok"
}

Console.WriteLine(take[C2]())`
        let tempDir = Directory.CreateTempSubdirectory("gs_4124_nested_").FullName
        try {
            let okPath = Path.Combine(tempDir, "Nested.dll")
            let okLog = Compile(tempDir, "Nested.gs", SourceArgument, okPath, "/target:exe")
            Assert.DoesNotContain("GS9998", okLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", okLog, StringComparison.Ordinal)
            Assert.True(File.Exists(okPath), (`the nested self-reference must bind. Log:
` + "$okLog"))
            IlVerifier.Verify(okPath, Array.Empty[string]())
            let (exit, output) = RunDotnet(okPath)
            Assert.True(exit == 0, (`the nested self-reference must run. Exit ` + "$exit" + `:
` + "$output"))
            Assert.Equal("nested-ok", output.Trim())
            let wrongPath = Path.Combine(tempDir, "Wrong.dll")
            let wrongLog = Compile(tempDir, "Wrong.gs", WrongNestedArgument, wrongPath, "/target:exe")
            Assert.DoesNotContain("GS9998", wrongLog, StringComparison.Ordinal)
            Assert.False(File.Exists(wrongPath), (`a nested argument that does not match must still be refused. Log:
` + "$wrongLog"))
            let occurrences = wrongLog.Split("GS0152", StringSplitOptions.None).Length - 1
            Assert.True(
                occurrences == 1,
                "the wrong nested argument must report GS0152 exactly once, saw $occurrences. " + (`Log:
` + "$wrongLog")
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 60_000

        /// Every shape that must now bind, compile, IL-verify and run. Each of
        /// these reported `GS0152` on the parent unless marked as a control.
        /// @returns Case name, G# source, expected stdout lines.
        func NowBinding() sequence[[]object] {
            // THE ISSUE'S OWN REPRO, verbatim. Both spellings — a generic FUNCTION
            // call and a generic TYPE construction — route through
            // `Binder.SatisfiesConstraint`, so both reported GS0152.
            yield[]object{"the-issues-repro-a-source-class-implements-an-imported-interface", `package P
import System

class D : IDisposable {
    public func Dispose() {
    }
}

func take[T IDisposable]() string {
    return "took"
}

open class Box[TB IDisposable] {
    public var Tag string = "b"
}

Console.WriteLine(take[D]())
Console.WriteLine(Box[D]().Tag)`, []string{"took", "b"}}
            // Through the SOURCE base chain: `EnumerateDeclaredClrInterfaces`
            // walks `BaseClass` as well as the class's own list.
            yield[]object{"a-source-base-class-supplies-the-imported-interface", `package P
import System

open class Base : IDisposable {
    public func Dispose() {
    }
}

class Sub : Base {
}

func take[T IDisposable]() string {
    return "took-sub"
}

Console.WriteLine(take[Sub]())`, []string{"took-sub"}}
            // Through a G#-DECLARED interface that itself extends the imported
            // one — the `EnumerateInterfaceClrBases` arm of the same walk.
            yield[]object{"a-gs-declared-interface-projects-onto-the-imported-one", `package P
import System

interface IGs : IDisposable {
}

class D2 : IGs {
    public func Dispose() {
    }
}

func take[T IDisposable]() string {
    return "took-iface"
}

Console.WriteLine(take[D2]())`, []string{"took-iface"}}
            // A SELF-REFERENTIAL generic bound. `[T IComparable[T]]` names the
            // constrained parameter as its own argument, so the expected vector is
            // `[T]` and the symbolic walk had to learn the substitution the
            // reflective half already performs.
            yield[]object{"a-self-referential-generic-bound-over-a-source-class", `package P
import System

class Cmp : IComparable[Cmp] {
    public func CompareTo(other Cmp?) int32 {
        return 0
    }
}

func take[T IComparable[T]]() string {
    return "took-cmp"
}

Console.WriteLine(take[Cmp]())`, []string{"took-cmp"}}
            // Issue #4136, filed independently against the SAME site while #4089/
            // #4090 were being closed, and closed by this change without a second
            // repair — which is the point of consolidating at the leaf rather than
            // patching a fourth caller. Its repro verbatim: a source class that
            // implements the imported interface DIRECTLY, and one that inherits it
            // from an IMPORTED base (`ArrayList` carries `IEnumerable`). Measured
            // `2 x GS0152` on this branch's parent `b4478875` and `de` here.
            yield[]object{"issue-4136-a-direct-implementation-and-an-imported-base-at-a-constructor", `package P
import System
import System.Collections

open class GsDisposable[TD IDisposable] {
    public var Tag string = "d"
}

open class GsEnumerable[TE IEnumerable] {
    public var Tag string = "e"
}

class DisposableSource : IDisposable {
    public func Dispose() {
    }
}

class EnumerableSource : ArrayList {
}

let a = GsDisposable[DisposableSource]()
let b = GsEnumerable[EnumerableSource]()
Console.WriteLine(a.Tag + b.Tag)`, []string{"de"}}
            // A CONTROL, green before and after: an IMPORTED type argument has a
            // CLR type, so the reflective half answers it and the new fallback is
            // never consulted. This is the control #4136's "Expected" section
            // names.
            yield[]object{"an-imported-type-argument-is-still-answered-reflectively", `package P
import System
import System.IO

func take[T IDisposable]() string {
    return "took-imported"
}

Console.WriteLine(take[MemoryStream]())`, []string{"took-imported"}}
        }

        /// Shapes that must STILL be refused. The widening is monotone in the
        /// satisfaction direction only; a type that does not carry the interface
        /// never starts satisfying the bound.
        /// @returns Case name and G# source.
        func StillRefused() sequence[[]object] {
            // The plain negative: a source class that implements nothing.
            yield[]object{"a-source-class-that-does-not-implement-the-interface", `package P
import System

class E {
}

func take[T IDisposable]() string {
    return "took"
}

Console.WriteLine(take[E]())`}
            // A source class carrying the WRONG imported interface. The walk
            // reaches an interface list; it must still compare it.
            yield[]object{"a-source-class-that-implements-a-different-imported-interface", `package P
import System

class F : ICloneable {
    public func Clone() object {
        return this
    }
}

func take[T IDisposable]() string {
    return "took"
}

Console.WriteLine(take[F]())`}
            // A GENERIC bound is decided on the SYMBOLIC arguments, so the wrong
            // argument is still wrong even though both project to the identical
            // erased `IComparable<object>`.
            yield[]object{"a-generic-bound-with-the-wrong-symbolic-argument", `package P
import System

class Other {
}

class Cmp2 : IComparable[Cmp2] {
    public func CompareTo(other Cmp2?) int32 {
        return 0
    }
}

func take[T IComparable[Other]]() string {
    return "took"
}

Console.WriteLine(take[Cmp2]())`}
        }

        private func SplitLines(output string)[]string -> output
            .Split('\n')
            .Select((line string) -> line.TrimEnd('\r'))
            .Where((line string) -> line.Length > 0)
            .ToArray()

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
