// <copyright file="Issue4013ExplicitInterfaceMemberCandidacyTests.cs" company="GSharp">
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

/// Issue #4013: an explicitly-implemented non-generic interface member was a
/// candidate for an ordinary member call on the implementing type, so
/// `List[int32]().Add("x")` compiled and threw at run time.
/// @remarks <b>The hole.</b> `MemberLookup.SafeGetMethodsIncludingSelfAndInterfaces`
/// finishes by walking the receiver's transitive interfaces, a step whose
/// stated purpose is to surface DEFAULT interface methods the concrete type
/// does not re-declare. It admitted every interface member, abstract ones
/// included. `List<T>` implements the non-generic
/// `System.Collections.IList`, whose `Add(object)` accepts anything,
/// so when the argument did not fit the generic `Add(T)` resolution fell
/// through to the interface member instead of reporting an error. The stack
/// trace named `List`1.System.Collections.IList.Add`, so the call really
/// did bind to the explicit implementation. This is the unsound direction: a
/// static type error became a run-time `ArgumentException`, and it
/// silently widened every such call site to `object`.
///
/// <b>The rule, and why it is spelled <c>!IsAbstract</c>.</b> In C# an
/// explicitly-implemented interface member is not a member of the implementing
/// type's own surface; it is reachable only through an interface-typed
/// reference. A class MUST implement every abstract member of the interfaces it
/// declares, and how it did so decides the answer: implemented IMPLICITLY, the
/// class's own public method is already in the candidate set from the self/base
/// walk, so the interface's copy adds nothing; implemented EXPLICITLY, C# says
/// it is off the surface. Either way an ABSTRACT interface member has no
/// business being offered on a class receiver — which leaves exactly the
/// non-abstract ones, i.e. genuine DIMs, which is what the walk was for.
/// Reconstructing C#'s dotted `Namespace.IFace<T>.Method` metadata
/// names would be fragile, and `Type.GetInterfaceMap` throws under the
/// `MetadataLoadContext` reference assemblies are loaded in (it is used
/// nowhere in this repo for that reason), so neither is needed here.
///
/// <b>An interface receiver keeps the full walk.</b> A base interface's
/// abstract members really are members of the derived interface, so the rule is
/// gated on the receiver not being an interface. That is the
/// `an-interface-receiver-still-reaches-its-base-interface-members` row.
///
/// <b>Two exemptions the compiler still depends on, both measured, both
/// leaving the hole open where they apply.</b> The member stays offered in
/// exactly two situations.
///
/// 1. <b>A synthesized collection-initializer <c>Add</c>.</b> ADR-0117 literals and the #3096 spread
/// form synthesize an `Add` and bind it through this same path. `Dictionary[K, V](){ ...pairs }` fills
/// through the explicitly-implemented `ICollection<KeyValuePair<K, V>>.Add`; narrowing it reported
/// `GS0369` ("no accessible 'Add' method or settable indexer"). Restricting the exemption to GENERIC
/// interfaces, which would have closed the literal hole too, broke
/// `Issue3096CollectionSpreadEmitTests.UserDefinedSpreadConversions_ArrayAndCollection_RunAndVerify`: a
/// `[]Celsius` spread into a `List[float64]` cannot match `Add(double)` through its user-defined
/// conversion, because a same-compilation struct has no CLR type while binding, and `IList.Add(object)`
/// was what accepted it.
/// 2. <b>An argument carrying a SAME-COMPILATION type</b>, where `IList.Add(object)` is an erasure
/// escape hatch wherever two erasures of one type disagree.
/// `List[System.Action[Mode]].Add((item Mode) -> …)` for a same-compilation enum `Mode`
/// (`Issue2918InlineLambdaErasedReceiverTests`) is that shape: the receiver is built over the flat
/// `System.Object` placeholder and presents as `List<Action<object>>`, while the lambda erases the enum
/// to `int` and presents as `Action<int>`, so the type's own `Add(Action<object>)` is inapplicable.
/// That is #4016's defect at the generic-CONSTRUCTION placeholder rather than at the
/// method-type-argument one.
///
/// Both exemptions turn on something the CALL SITE has, not on the
/// member: a synthesized node, or an argument with no CLR identity. The
/// reported hole is closed because its argument is a genuine `string` at a
/// genuine `int32` and so qualifies for neither. What remained open was
/// `List[int32]{"x"}` (the literal form, exemption 1) and an ordinary call
/// passing a same-compilation argument (exemption 2); both were filed as #4028
/// and are now closed there — not by narrowing this candidate-collection rule
/// further, but by asking at APPLICABILITY, where the receiver's and the
/// arguments' real types are in hand, whether a NON-GENERIC interface's
/// widening member has an erasure to repair at all. See
/// `Issue4028CollectionLiteralExplicitInterfaceTests`. The exemptions
/// themselves are unchanged, and so is every row here.
///
/// <b>Blast radius, measured.</b> An instrumented compiler logged every
/// drop this rule makes while compiling the whole `samples/` +
/// `e2etests/` `.gs` corpus: 27 drops, all of
/// `IList.Add(object)`, `IDictionary.Add(object, object)`,
/// `ICollection<KeyValuePair<K, V>>.Add` and
/// `IFormattable.ToString(string, IFormatProvider)`, and EVERY one of them
/// had another candidate of the same name already on the type's own surface
/// (`onlyCandidate=False` on all 27). Nothing in the corpus depended on an
/// explicit member as its only candidate, and the corpus still compiles.
///
/// <b>The adjacent question the issue does not settle.</b> A call with no
/// other candidate at all now has nothing to bind to. It used to reach the
/// explicit member; it now reports `GS0577`, which names the member, the
/// interface that declares it and the way to reach it, rather than the
/// `GS0159 Cannot find function Contains` a misspelling produces. That is
/// the `map-contains` row, and it is a BEHAVIOUR CHANGE: the call used to
/// compile.
///
/// <b>GS0577 is chosen only when an excluded member is APPLICABLE.</b> A
/// name match alone would make the diagnostic lie: its advice — reach it
/// through an interface-typed receiver — is a dead end unless one of the
/// excluded members could really have taken the call. So the finder ranks them
/// against the bound arguments and keeps `GS0159` otherwise
/// (`map[string, int32]{}.Contains(1, 2)` and `Greeter{}.Secret(1)`
/// are those rows, from the review on PR #4031). Ranking also picks the RIGHT
/// interface to name: for `d.Contains("k")` it reports `IDictionary`,
/// whose `Contains(object)` accepts the string, rather than
/// `ICollection<KeyValuePair<K, V>>`, whose does not — so
/// `cast[IDictionary](d).Contains("k")` is advice that actually
/// works.
///
/// <b>What the issue expected, and what the compiler actually does.</b>
/// The issue expects `ys.Add("x")` to report `GS0154` naming
/// `int32` and `string`. It reports `GS0159` — and so does the
/// control `Stack[int32]().Push("x")`, whose `Push(T)` has no
/// non-generic sibling and never had this hole. GS0159 is simply what an
/// inapplicable imported overload reports, before and after this change; the
/// fix makes `List.Add` behave EXACTLY like that control, which is the
/// point. The control is pinned as the
/// `a-member-with-no-interface-sibling-reports-the-same-thing` row so the
/// equivalence stays measured.
open class Issue4013ExplicitInterfaceMemberCandidacyTests {
    /// The control: an imported member with NO non-generic interface sibling
    /// reported `GS0159` for an inapplicable argument before this change
    /// and still does. This is what pins the claim that the fix makes
    /// `List.Add` behave like every other imported overload, rather than
    /// inventing a new failure mode for it.
    @Fact
    func AMemberWithNoInterfaceSibling_ReportsTheSameThing() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4013_ctl_").FullName
        try {
            const Source = `package P
import System.Collections.Generic

let s = Stack[int32]()
s.Push("x")`
            let appPath = Path.Combine(tempDir, "control.dll")
            let log = Compile(tempDir, "App.gs", Source, appPath, "/target:exe")
            Assert.False(File.Exists(appPath), (`the control must not compile. Log:
` + "$log"))
            Assert.Contains("GS0159", log, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// An explicitly-implemented interface member is no longer a candidate for
    /// an ordinary call on the implementing type.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RejectedCases")
    func AnExplicitInterfaceMember_IsNotACandidateForAnOrdinaryCall(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4013_neg_").FullName
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

    /// Every legitimate neighbour of the refused bind still compiles,
    /// IL-verifies, runs, and prints what it always did.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("LegitimateCases")
    func ALegitimateNeighbour_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4013_").FullName
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

        /// The C# library the DIM and explicit-implementation rows link against.
        private const LibrarySource string = (`namespace Interop;

public interface IGreeter
{
    // A genuine DEFAULT interface method: the implementing class need
    // not declare it at all, so it stays a candidate on a class
    // receiver. This is what the interface walk exists for.
    string Greet() => "dim:" + this.Name;

    string Name { get; }
}

public interface IHidden
{
    // Abstract, and implemented EXPLICITLY below: off the class surface.
    string Secret();
}

public interface IBase
{
    string FromBase();
}

public interface IDerivedIface : IBase
{
    string FromDerived();
}

public sealed class Greeter : IGreeter, IHidden, IDerivedIface
{
    public string Name => "g";

    public string FromBase() => "frombase";

    public string FromDerived() => "fromderived";

    // Explicit: ` + "`" + `new Greeter().Secret()` + "`" + ` is CS1061 in C# too.
    string IHidden.Secret() => "secret";
}`)

        /// Calls that must no longer bind to an explicitly-implemented interface
        /// member.
        /// @returns Case name, G# source, expected diagnostic id.
        func RejectedCases() sequence[[]object] {
            // The reported repro. `IList.Add(object)` accepted the string, and the
            // program threw `ArgumentException` at run time.
            yield[]object{"the-reported-repro-a-string-does-not-reach-ilist-add-object", `package P
import System.Collections.Generic

func main2() {
    var ys = List[int32]()
    ys.Add("x")
}

main2()`, "GS0159"}
            // Not specific to `List`: `Dictionary<K, V>` implements
            // `IDictionary.Add(object, object)` explicitly and had the same hole.
            yield[]object{"a-dictionary-does-not-reach-idictionary-add-object-object", `package P
import System.Collections.Generic

let d = Dictionary[string, int32]()
d.Add(1, "x")`, "GS0159"}
            // The same hole in a user-written imported type, with an explicit
            // implementation that has NO same-named sibling on the class surface.
            // Before #4013 this bound and printed `secret`; now the type has no
            // member of that name at all, so the new GS0577 explains why.
            yield[]object{"an-explicit-implementation-with-no-sibling-reports-gs0577", `package P
import System
import Interop

let g = Greeter{}
Console.WriteLine(g.Secret())`, "GS0577"}
            // The no-other-candidate case on a BCL type, and the behaviour change
            // this PR is explicit about: `Dictionary<K, V>` has no public
            // `Contains`, so the call used to bind `IDictionary.Contains(object)`
            // and compile. It now names the interface instead of reading like a
            // misspelling.
            yield[]object{"map-contains-had-no-other-candidate-and-now-reports-gs0577", `package P
import System
import System.Collections.Generic

let d = map[string, int32]{}
Console.WriteLine(d.Contains("k"))`, "GS0577"}
            // Review finding on PR #4031: GS0577 must not fire when NO excluded
            // interface member could have taken the call. `Contains` matches by
            // name, but every `Contains` on `Dictionary<K, V>` is unary, so
            // "reach it through an interface-typed receiver" would be a dead end.
            // The ordinary GS0159 is the honest answer here.
            yield[]object{"an-inapplicable-arity-keeps-gs0159-rather-than-gs0577", `package P
import System
import System.Collections.Generic

let d = map[string, int32]{}
Console.WriteLine(d.Contains(1, 2))`, "GS0159"}
            // The same rule on a user-written type: `IHidden.Secret()` is
            // parameterless, so a one-argument call cannot reach it either.
            yield[]object{"an-inapplicable-explicit-member-keeps-gs0159-rather-than-gs0577", `package P
import System
import Interop

let g = Greeter{}
Console.WriteLine(g.Secret(1))`, "GS0159"}
        }

        /// Every legitimate neighbour that must keep binding.
        /// @returns Case name, G# source, expected stdout lines.
        func LegitimateCases() sequence[[]object] {
            // The type's own public members are untouched — this is the overload
            // that was always meant to win, and the surrounding collection surface
            // still works.
            yield[]object{"the-types-own-public-members-still-bind", `package P
import System
import System.Collections.Generic

let ys = List[int32]()
ys.Add(3)
ys.Add(4)
Console.WriteLine(ys.Count)
Console.WriteLine(ys.Contains(4))
Console.WriteLine(ys.IndexOf(4))

let d = Dictionary[string, int32]()
d.Add("k", 1)
Console.WriteLine(d.Count)
Console.WriteLine(d.ContainsKey("k"))`, []string{"2", "True", "1", "1", "True"}}
            // The issue's own "Expected" section: the explicit member is still
            // reachable, through an interface-typed receiver. `IList.Add` returns
            // the new index, and the value really does land in the list.
            yield[]object{"an-interface-typed-receiver-still-reaches-the-explicit-member", `package P
import System
import System.Collections
import System.Collections.Generic

let ys = List[int32]()
let il = cast[IList](ys)
Console.WriteLine(il.Add(7))
Console.WriteLine(ys.Count)
Console.WriteLine(ys[0])`, []string{"0", "1", "7"}}
            // A genuine DEFAULT interface method is exactly what the interface walk
            // exists to surface, and it is NOT abstract, so it survives the rule.
            // Without this row the change would only have been shown to say no.
            yield[]object{"a-default-interface-method-is-still-a-candidate-on-a-class-receiver", `package P
import System
import Interop

let g = Greeter{}
Console.WriteLine(g.Greet())`, []string{"dim:g"}}
            // An interface receiver keeps the full walk: a base interface's
            // abstract members are members of the derived interface.
            yield[]object{"an-interface-receiver-still-reaches-its-base-interface-members", `package P
import System
import Interop

let g = Greeter{}
let i = cast[IDerivedIface](g)
Console.WriteLine(i.FromBase())
Console.WriteLine(i.FromDerived())`, []string{"frombase", "fromderived"}}
            // An IMPLICIT implementation is on the class surface and must still
            // bind from a class-typed receiver — the case the rule must not catch.
            yield[]object{"an-implicitly-implemented-interface-member-still-binds-on-the-class", `package P
import System
import Interop

let g = Greeter{}
Console.WriteLine(g.FromBase())
Console.WriteLine(g.FromDerived())`, []string{"frombase", "fromderived"}}
            // `for … in` over a `List[T]` goes through the enumerator, whose
            // `GetEnumerator` on `List<T>` has both a public struct-returning
            // overload and explicit `IEnumerable`/`IEnumerable<T>` ones. The public
            // one must keep winning.
            yield[]object{"iteration-and-collection-literals-still-work", `package P
import System
import System.Collections.Generic

let ys = List[int32]{1, 2, 3}
var total = 0
for v in ys {
    total = total + v
}

Console.WriteLine(total)

let m = map[string, int32]{"a": 1, "b": 2}
Console.WriteLine(m.Count)
Console.WriteLine(m["b"])`, []string{"6", "2", "2"}}
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
