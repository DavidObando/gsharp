// <copyright file="Issue4032ConstrainedImportedGenericBaseTests.cs" company="GSharp">
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

/// Issue #4032: a class deriving from a CONSTRAINED imported generic base.
/// @remarks <b>The reported half did not reproduce, and that is measured.</b> The
/// issue reports `GS0149: Type 'Handler' is not generic` for
/// `class MyHandler : Handler[MyOptions]` when `Handler<TOptions>`
/// carries `where TOptions : SchemeOptions`. On `565b9a04` that
/// program compiles. It was re-measured across eleven shapes and four
/// reference kinds — the C# library's implementation assembly, its
/// `obj/…/ref/` reference assembly, the host shared runtime as the BCL,
/// and the `Microsoft.NETCore.App.Ref` targeting pack — and every
/// satisfying shape bound. Those shapes are the green rows below, so the
/// report is pinned rather than dismissed: if the GS0149 path exists on some
/// other input, these rows are what a fix would have to keep.
///
/// <b>The unreported half is real, and it is the same area.</b>
/// `Type.MakeGenericType` validates constraints for a live runtime
/// definition and does NOT for one loaded by a
/// `MetadataLoadContext` — which is where every `/reference`
/// assembly lives. The generic METHOD path has compensated for exactly this
/// since #750/ADR-0088 (`SatisfiesGenericConstraints`, whose own comment
/// says "MetadataLoadContext's MakeGenericMethod does not validate
/// constraints"); the generic TYPE path never did. So a base clause that
/// VIOLATES the constraint compiled with no diagnostic at all:
/// `class Bad : Handler[string]` emitted an `extends` row the CLR
/// refuses and threw `TypeLoadException: GenericArguments[0],
/// 'System.String', on 'HelperLib2.Handler`1[TOptions]' violates the
/// constraint of type parameter 'TOptions'` the first time the program
/// touched the type — measured on `565b9a04`. That is the second half of
/// the issue's own Expected section ("reports `GS0152` naming the
/// constraint when it does not"), and it is what this change delivers.
///
/// <b>Only CLOSED instantiations are asked.</b> A type argument that
/// still mentions a type parameter is erased to an `object` placeholder,
/// and asking a constraint of a placeholder is precisely how #4016/#4031's
/// projection broke constraint satisfaction for a SIBLING type parameter. An
/// open instantiation is skipped — it has no closed answer to give, and the
/// CLR only loads the type once it is closed. The same-compilation class case
/// is NOT skipped: the checker is handed the SYMBOLIC vector and walks a user
/// class's own base chain, so `class MyOptions : SchemeOptions` satisfies
/// `where TOptions : SchemeOptions` even though its CLR surrogate is
/// `object`. Both are green rows.
///
/// <b>One neighbour was out of scope here and is now FIXED by #4037.</b>
/// A G# generic class that derives from a constrained imported base WITHOUT
/// forwarding the bound to its own parameter —
/// `class MyGenericHandler[T] : Handler[T]` where `Handler` requires
/// `TOptions : SchemeOptions` — compiled, and its IL did not verify:
/// `[UnsatisfiedMethodParentInst] … Method parent instantiation has
/// unsatisfied class type parameter constraints`. It is NOT a closed
/// instantiation, so THIS change's check deliberately does not see it, and it
/// still does not: the rule it needed is different in kind — "does the derived
/// declaration's constraint set IMPLY the base's" — and it landed as its own
/// diagnostic, `GS0580`, in
/// `Issue4037UnforwardedConstrainedGenericBaseTests`. (Measured against
/// `csc`: the C# rule is <b>CS0314</b>, the type-PARAMETER-argument case,
/// not CS0311, which is the concrete-argument case G# already spells GS0152.)
/// The FORWARDED spelling
/// (`class MyGenericHandler[T SchemeOptions] : Handler[T]`) verified
/// before and after, and is the green row here.
///
/// <b>Review of PR #4040 found the clause sites were not enough.</b>
/// Three EXPRESSION spellings close an imported generic without passing
/// through a type clause — a direct constructor call `Handler[string]()`,
/// a static member through a closed receiver
/// `Handler[string].Describe()`, and an object literal
/// `Handler[string]{…}` — and the first version of this change checked
/// only the clause sites, so all three still compiled and threw
/// `TypeLoadException`. Enumerating `MakeGenericType` across the
/// binder found FOUR user-facing construction sites beyond the three clause
/// sites; all now route through the same shared validation, and each has a
/// violating row and a satisfying control here.
///
/// <b>The gap this class once pinned is closed (issue #4041).</b> A
/// DEPENDENT constraint over two distinct same-compilation classes
/// (`Coupled[A, List[Bee]]` against
/// `Coupled<T, U> where U : IList<T>`) used to be accepted,
/// because both classes erase to the same `object` placeholder and
/// `List<object>` honestly satisfies `IList<object>`.
/// The bound is now answered on the SYMBOLIC vector, where `IList[A]` and
/// `List[Bee]`'s own `IList[Bee]` differ, so the two violating
/// spellings are rows in `ConstraintViolations` and the matched, imported
/// and COVARIANT spellings are rows in `DependentBoundControls`. The
/// asserting row that used to stand here — the one whose message said to move
/// it — is gone, moved rather than deleted.
///
/// <b>#4031's reduction is constructible.</b> The ASP.NET
/// `AddScheme[TOptions, THandler]` shape — a two-parameter generic method
/// whose second constraint mentions the first
/// (`where THandler : AuthenticationHandler[TOptions]`), called with a
/// same-compilation options class and a same-compilation handler deriving from
/// the constrained imported base — compiles, IL-verifies and runs here. That
/// is the shape #4031 could pin only through the `cs2gs-code-exploder`
/// gate.
open class Issue4032ConstrainedImportedGenericBaseTests {
    /// Issue #4041's controls compile, IL-verify, run, and print. A dependent
    /// bound that HOLDS must stay green — a wrong "no" here would be a GS0152
    /// on a legal program, which is why the symbolic check is three-state and
    /// falls back to the CLR comparison rather than to a rejection.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("DependentBoundControls")
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

    /// A closed generic type clause that violates a declared constraint now
    /// reports `GS0152` at compile time instead of throwing
    /// `TypeLoadException` at run time.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("ConstraintViolations")
    func AConstraintViolatingGenericTypeClause_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4032_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The wrong message would be the issue's own complaint.
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal)
            // Issue #4032 (CI follow-up): assert the COUNT, not merely the
            // presence. `Assert.Contains` is what let a real defect through —
            // the binder PROBES the same receiver several times before it
            // commits to a reading of it, so `System.Nullable[string].Value`
            // reported the identical violation THREE times and
            // `Handler[string].Describe()` twice. An
            // author fixing one violation saw three errors, and the count was a
            // function of how many internal paths the binder happened to take.
            // One violation, one diagnostic — at every spelling.
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

    /// Every satisfying shape compiles, IL-verifies, runs, and prints what it
    /// always printed.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("SatisfyingShapes")
    func ASatisfyingGenericTypeClause_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4032_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0149", appLog, StringComparison.Ordinal)
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

    /// The `GS0152` text names the type argument, the type PARAMETER, and
    /// the constraint that failed — the three facts the issue's Expected
    /// section asks for and that `GS0149` gave none of.
    @Fact
    func TheDiagnosticNamesTheArgumentTheParameterAndTheConstraint() {
        const Source = `package P
import System
import HelperLib2

class Bad : Handler[string] {
}

Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4032_msg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Contains("GS0152", appLog, StringComparison.Ordinal)
            Assert.Contains("'string'", appLog, StringComparison.Ordinal)
            Assert.Contains("'TOptions'", appLog, StringComparison.Ordinal)
            Assert.Contains("'HelperLib2.SchemeOptions'", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. Mirrors the issue's own
        /// library, plus the ASP.NET `AuthenticationHandler`/`AddScheme`
        /// shape #4031 needed.
        private const LibrarySource string = (`namespace HelperLib2;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public string Tag { get; set; } = "t";

    public static string Describe() => "described";
}

public class Coupled<T, U>
    where U : System.Collections.Generic.IList<T>
{
    public string Tag { get; set; } = "coupled";
}

// Issue #4041's variance control: ` + "`" + `IEnumerable<out T>` + "`" + ` is COVARIANT, so
// ` + "`" + `Covariant<CovBase, List<CovDerived>>` + "`" + ` is legal C# and identity is
// the wrong relation at that position.
public class Covariant<T, U>
    where U : System.Collections.Generic.IEnumerable<T>
{
    public string Tag { get; set; } = "covariant";
}

public class HandlerNew<TOptions>
    where TOptions : SchemeOptions, new()
{
    public string Tag { get; set; } = "n";
}

public interface IAuthenticationHandler
{
    string Scheme { get; }
}

public abstract class AuthenticationHandler<TOptions> : IAuthenticationHandler
    where TOptions : SchemeOptions, new()
{
    public string Scheme => "scheme";
}

public class AuthenticationBuilder
{
    public string AddScheme<TOptions, THandler>(string name)
        where TOptions : SchemeOptions, new()
        where THandler : AuthenticationHandler<TOptions>
        => "added:" + name;
}

public class ClassConstrained<T>
    where T : class
{
    public string Tag { get; set; } = "c";
}

public class StructConstrained<T>
    where T : struct
{
    public string Tag { get; set; } = "v";
}

public class Unconstrained<T>
{
    public string Tag { get; set; } = "u";
}`)

        /// Every closed instantiation that VIOLATES a constraint the imported
        /// definition declares. Each of these compiled with NO diagnostic on the
        /// parent and threw `TypeLoadException` at run time.
        /// @returns Case name, G# source, expected diagnostic id.
        func ConstraintViolations() sequence[[]object] {
            // An IMPORTED type argument that does not derive from the bound.
            yield[]object{"an-imported-type-argument-that-misses-the-base-constraint", `package P
import System
import HelperLib2

class Bad : Handler[string] {
}

let b = Bad()
Console.WriteLine(b.Tag)`, "GS0152"}
            // A SAME-COMPILATION class that does not derive from the bound. The
            // interesting one: its CLR surrogate is `object`, so the check has to
            // read the symbol's own base chain to answer at all.
            yield[]object{"a-same-compilation-class-that-misses-the-base-constraint", `package P
import System
import HelperLib2

class NotOptions {
    public var N int32
}

class Bad2 : Handler[NotOptions] {
}

let b = Bad2()
Console.WriteLine(b.Tag)`, "GS0152"}
            // A SPECIAL constraint, so the message comes from the attribute mask
            // rather than from a bound type.
            yield[]object{"a-reference-type-at-a-struct-constrained-base", `package P
import System
import HelperLib2

class BadStruct : StructConstrained[string] {
}

let b = BadStruct()
Console.WriteLine(b.Tag)`, "GS0152"}
            yield[]object{"a-value-type-at-a-class-constrained-base", `package P
import System
import HelperLib2

class BadClass : ClassConstrained[int32] {
}

let b = BadClass()
Console.WriteLine(b.Tag)`, "GS0152"}
            // REVIEW FINDING 1. Three EXPRESSION spellings close an imported
            // generic without ever reaching a type clause, and the first version of
            // this change checked only the clause sites. Each of these compiled,
            // emitted an instantiation the CLR refuses, and threw
            // `TypeLoadException` on that build.
            yield[]object{"review-a-direct-constructor-call-on-a-violating-instantiation", `package P
import System
import HelperLib2

let h = Handler[string]()
Console.WriteLine(h.Tag)`, "GS0152"}
            yield[]object{"review-a-static-member-through-a-violating-receiver", `package P
import System
import HelperLib2

Console.WriteLine(Handler[string].Describe())`, "GS0152"}
            yield[]object{"review-an-object-literal-of-a-violating-instantiation", `package P
import System
import HelperLib2

let h = Handler[string]{Tag: "z"}
Console.WriteLine(h.Tag)`, "GS0152"}
            // ISSUE #4041, moved here from its own asserting row. A DEPENDENT
            // bound over two DISTINCT same-compilation classes: `A` and `Bee` both
            // erase to the same `System.Object` placeholder, so the vector handed
            // to the erased check was `Coupled<object, List<object>>` — and
            // `List<object>` honestly does satisfy `IList<object>`. The check
            // passed on what it was given; the information that distinguishes `A`
            // from `Bee` was gone before it was asked, and emission then reified
            // `Coupled<A, List<Bee>>`, which the CLR refuses with
            // `TypeLoadException: GenericArguments[1] … violates the constraint of
            // type parameter 'U'`. The bound is now answered on the SYMBOLIC
            // vector, where `IList[A]` and `List[Bee]`'s `IList[Bee]` differ.
            yield[]object{"a-dependent-constraint-over-two-distinct-erased-classes", `package P
import System
import System.Collections.Generic
import HelperLib2

class A {
    public var N int32
}

class Bee {
    public var M int32
}

var c Coupled[A, List[Bee]]
Console.WriteLine("compiled")`, "GS0152"}
            // The same violation through the CONSTRUCTOR spelling, which #4041
            // records as additionally failing `ilverify` with
            // `UnsatisfiedMethodParentInst`. One repair covers both because the
            // constructor path routes through the same shared checker #4032 built.
            yield[]object{"a-dependent-constraint-violated-through-the-constructor-spelling", `package P
import System
import System.Collections.Generic
import HelperLib2

class A {
    public var N int32
}

class Bee {
    public var M int32
}

let c = Coupled[A, List[Bee]]()
Console.WriteLine(c.Tag)`, "GS0152"}
            // Not only base clauses: any closed generic TYPE clause goes through
            // the same construction.
            yield[]object{"a-field-type-that-violates-the-constraint", `package P
import System
import HelperLib2

class Holder {
    public var H Handler[int32]
}

Console.WriteLine("x")`, "GS0152"}
        }

        /// Every satisfying shape — including the issue's own repro, which is
        /// green before and after — plus the open instantiations the check must
        /// not touch.
        /// @returns Case name, G# source, expected stdout lines.
        func SatisfyingShapes() sequence[[]object] {
            // THE ISSUE'S OWN REPRO. Reported as GS0149; measured green.
            yield[]object{"the-issues-repro-a-same-compilation-class-at-a-constrained-imported-base", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

class MyHandler : Handler[MyOptions] {
}

let h = MyHandler()
Console.WriteLine(h.Tag)`, []string{"t"}}
            // The issue's `new()` control.
            yield[]object{"the-issues-new-control", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

class MyHandler : HandlerNew[MyOptions] {
}

let h = MyHandler()
Console.WriteLine(h.Tag)`, []string{"n"}}
            // The issue's no-constraint control.
            yield[]object{"control-the-unconstrained-base-still-binds", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

class MyPlain : Unconstrained[MyOptions] {
}

let h = MyPlain()
Console.WriteLine(h.Tag)`, []string{"u"}}
            // THE ASP.NET SHAPE, and #4031's reduction. `AddScheme[TOptions,
            // THandler]`'s second constraint MENTIONS the first, which is the
            // dependent-bound case #4016's projection broke.
            yield[]object{"the-aspnet-addscheme-shape-that-4031-could-only-pin-through-the-corpus", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

class MyHandler : AuthenticationHandler[MyOptions] {
}

let b = AuthenticationBuilder()
Console.WriteLine(b.AddScheme[MyOptions, MyHandler]("bearer"))`, []string{"added:bearer"}}
            // A satisfying IMPORTED type argument, so the green side is not only
            // the erased-symbol path.
            yield[]object{"an-imported-type-argument-that-satisfies-the-base-constraint", `package P
import System
import HelperLib2

class Derived : Handler[SchemeOptions] {
}

let d = Derived()
Console.WriteLine(d.Tag)`, []string{"t"}}
            // Special constraints, satisfied.
            yield[]object{"satisfied-special-constraints", `package P
import System
import HelperLib2

class OkClass : ClassConstrained[string] {
}

class OkStruct : StructConstrained[int32] {
}

Console.WriteLine(OkClass().Tag)
Console.WriteLine(OkStruct().Tag)`, []string{"c", "v"}}
            // REVIEW FINDING 1's green side: the same three expression spellings
            // over a SATISFYING argument must keep binding, running and printing.
            // The literal used an IMPORTED type argument because the literal
            // spelling over a SAME-COMPILATION one did not bind at all — it took
            // the `hasSymbolicArgument` branch and reported GS0157 "Cannot find
            // type Handler". That was pre-existing, was filed as #4042, and is
            // FIXED by the follow-up PR; this row keeps the imported-argument
            // spelling exactly as it was, so that the fix is measured by the new
            // fixture rather than by silently changing a #4032 row.
            yield[]object{"review-the-expression-spellings-still-bind-when-the-constraint-holds", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let h = Handler[MyOptions]()
Console.WriteLine(h.Tag)
Console.WriteLine(Handler[MyOptions].Describe())
let lit = Handler[SchemeOptions]{Tag: "z"}
Console.WriteLine(lit.Tag)`, []string{"t", "described", "z"}}
            // THE OPEN-INSTANTIATION SKIP. Every one of these erases its type
            // argument to `object`, which does NOT satisfy `: SchemeOptions`.
            // Asking THIS change's closed check here is the #4031 lesson; it must
            // not.
            //
            // Issue #4037 (follow-up PR): the bounds are FORWARDED at every open
            // position in this row, and that is now load-bearing rather than
            // incidental. #4032's check still does not see an open instantiation —
            // that skip is unchanged, and it is what keeps this row out of GS0152 —
            // but a separate rule (GS0580) now asks the DIFFERENT question "does
            // the declaration's own constraint set IMPLY the base's", which `csc`
            // spells CS0314 and reports at a base clause, a field type and a local
            // type alike (measured). The UNFORWARDED spellings this row used to
            // carry (`class Holder[T] { var H Handler[T] }` and
            // `func openLocal[T]()`) are the #4037 repro and are violation rows in
            // `Issue4037UnforwardedConstrainedGenericBaseTests`. What belongs here
            // is the invariant #4032 owns: a forwarded open instantiation is not
            // constraint-CHECKED against the erased vector, and stays green.
            yield[]object{"control-open-instantiations-are-not-constraint-checked", `package P
import System
import HelperLib2

class Holder[T SchemeOptions] {
    public var H Handler[T]
}

class MyGenericHandler[T SchemeOptions] : Handler[T] {
}

func openLocal[T SchemeOptions]() int32 {
    var h Handler[T]
    if h == nil { return 1 }
    return 2
}

Console.WriteLine(openLocal[SchemeOptions]())`, []string{"1"}}
            // A same-compilation class at an UNCONSTRAINED imported generic is the
            // commonest shape in the whole corpus. It must not have acquired a
            // constraint answer.
            yield[]object{"control-a-same-compilation-class-at-an-unconstrained-generic", `package P
import System
import System.Collections.Generic

class Thing {
    public var N int32
}

let list = List[Thing]()
let t = Thing()
t.N = 4
list.Add(t)
Console.WriteLine(list.Count)

let lookup = Dictionary[string, Thing]()
lookup.Add("a", t)
Console.WriteLine(lookup["a"].N)`, []string{"1", "4"}}
        }

        /// Issue #4041's controls, which are what the symbolic dependent-bound
        /// check must not break: the MATCHED same-compilation spelling
        /// `Coupled[A, List[A]]`, the matched IMPORTED spelling
        /// `Coupled[string, List[string]]`, and the COVARIANT bound
        /// `where U : IEnumerable<T>` where
        /// `Coupled2[Base, List[Derived]]` is legal C# — identity is the wrong
        /// relation at a variant position, so that shape is deliberately left to
        /// the CLR comparison rather than answered symbolically.
        /// @returns Case name, G# source, expected stdout lines.
        func DependentBoundControls() sequence[[]object] {
            yield[]object{"a-dependent-constraint-matched-over-one-erased-class", `package P
import System
import System.Collections.Generic
import HelperLib2

class A {
    public var N int32
}

var c Coupled[A, List[A]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            yield[]object{"a-dependent-constraint-matched-over-imported-types", `package P
import System
import System.Collections.Generic
import HelperLib2

var c Coupled[string, List[string]]
Console.WriteLine("compiled")`, []string{"compiled"}}
            yield[]object{"a-covariant-dependent-constraint-over-erased-classes", `package P
import System
import System.Collections.Generic
import HelperLib2

open class CovBase {
    public var N int32
}

class CovDerived : CovBase {
    public var M int32
}

var c Covariant[CovBase, List[CovDerived]]
Console.WriteLine("compiled")`, []string{"compiled"}}
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib2",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib2.dll")
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
