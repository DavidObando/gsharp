// <copyright file="Issue4036CollectionCallUserDefinedConversionTests.cs" company="GSharp">
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
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import System.Text.RegularExpressions
import Xunit

/// Issue #4036: a user-defined implicit conversion was not APPLIED at an
/// author-written call on a generic collection, so
/// `List[float64]().Add(someCelsius)` compiled to verifiable IL and threw
/// `ArgumentException` from inside the BCL.
/// @remarks <b>Root cause.</b> A same-compilation struct has no CLR type while
/// binding, so `Celsius` presents to overload resolution as
/// `object`. Against a `List<double>` receiver that is an
/// IDENTITY match for `System.Collections.IList.Add(object)` and no match
/// at all for `Add(double)`, so the widening member won every betterness
/// ranking and the `Celsius` was boxed and handed to the BCL as-is. #4028
/// KEEPS that widening member here on purpose — the user-defined conversion
/// `Celsius -> float64` genuinely exists, so this is an erasure to
/// repair rather than the widening hole #4028 closes — but nothing ever
/// performed the repair.
///
/// <b>The call-vs-spread asymmetry, measured.</b> The issue's own table
/// says the spread form binds `IList.Add(object)` too and merely applies
/// the conversion first. Dumping the emitted IL says otherwise, and the
/// difference matters: the spread form calls
/// `Celsius::op_Implicit` and then
/// `List`1<Double>::Add`. It reaches that binding because
/// `ExpressionBinder.BindConvertedCollectionAddCall` types its item
/// placeholder as the collection's ELEMENT type and converts the item to it
/// BEFORE binding `Add` — overload resolution never sees the erased
/// argument. The ordinary call path binds its argument with no target type at
/// all, so the erased `object` is what reaches applicability.
///
/// <b>What the fix does about that.</b> It makes the two forms AGREE,
/// not share a path. Sharing would mean routing every call through the
/// collection-shaped lowering, which needs an element type an ordinary call
/// does not have. Instead
/// `MemberLookup.FindUserDefinedConversionRepairTargets` asks the same
/// question `ExcludeUnreachableNonGenericInterfaceCandidates` already asks
/// — would the receiver's own non-widening surface have taken this call, and
/// does any position need a user-defined implicit conversion to do so — and
/// names the target type per position. The call site converts, then binds. Both
/// forms now emit `op_Implicit` followed by
/// `List`1<Double>::Add`.
///
/// <b>#4028's release note stays literally true.</b> The widening member
/// is still collected and still applicable; nothing removes it. It simply stops
/// WINNING, because a real `double` beats a boxed one at betterness.
///
/// <b>Six more broken forms the issue did not list</b>, found by
/// sweeping the neighbours rather than by reading the report. The collection
/// LITERAL `List[float64]{ celsius }` and the two-argument
/// `Dictionary[string, float64]().Add("a", celsius)` threw the same way;
/// `Insert` threw; and worse than any throw, `Contains` answered
/// `False` and `IndexOf` answered `-1` silently, because
/// `IList.Contains(object)` is perfectly happy to say no. `Remove`
/// reported `GS0124 Expression must have a value`, because
/// `IList.Remove` is `void` while `ICollection<T>.Remove`
/// returns `bool`. The repair keys on the presence of a widening
/// candidate, not on the name `Add`, so all of them close together.
///
/// <b>Named arguments, added in review of PR #4060.</b> Both this repair
/// and #4028's candidacy filter compared SOURCE-order arguments against
/// DECLARATION-order parameters, so a call that named its arguments out of
/// order asked the wrong question of the wrong slot:
/// `Add(value: someCelsius, key: "a")` asked whether a `Celsius` fits
/// `key: string`, concluded the receiver's own `Add` could not take
/// the call, removed the widening member and reported `GS0159`. Measured
/// on the parent as well as here, so the candidacy half is #4028's and
/// PRE-EXISTING; the repair half would have inherited it. Both now reorder
/// through `ClrOverloadResolution.TryBuildNamedArgumentReordering` — the
/// resolver's own mapping, which is what #4026 reached for when
/// `BuildSymbolicMethodTypeArgs` hit this same hazard — so no second
/// implementation of named-argument binding can drift from it. Only the two
/// MULTI-argument forms were affected: with a single argument any mapping is
/// the identity, which is why `Add`, `Contains`, `IndexOf` and
/// `Remove` were already correct in their named spellings. The rows below
/// pin all of them, plus the negative control that reordering must not smuggle
/// a conversion that does not exist.
///
/// <b>Issue #4054 follow-up.</b> The formerly pinned
/// `Math.Abs(someCelsius)` failure is now a positive row below. Ordinary
/// imported calls preserve the symbolic argument just long enough for CLR
/// overload resolution to classify the same user-defined conversion.
open class Issue4036CollectionCallUserDefinedConversionTests {
    /// The conversion is applied: the program compiles, IL-verifies, RUNS, and
    /// prints the converted value. Compiling and verifying is not enough — the
    /// whole issue is a program that did both and then threw.
    /// @param name The case name.
    /// @param body The G# body appended to the shared preamble.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("ConversionIsApplied")
    func AUserDefinedConversionIsAppliedAtACollectionCall(
        name string,
        body string,
        expectedLines[]string
    ) -> RunAndExpect(name, body, expectedLines)

    /// The neighbours are untouched.
    /// @param name The case name.
    /// @param body The G# body appended to the shared preamble.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("UnchangedNeighbours")
    func ANeighbouringShapeIsUnchanged(name string, body string, expectedLines[]string) -> RunAndExpect(
        name,
        body,
        expectedLines
    )

    /// A call with no conversion to apply is still refused at compile time.
    /// @param name The case name.
    /// @param body The G# body appended to the shared preamble.
    /// @param expectedId The diagnostic id the log must carry exactly once.
    @Theory
    @MemberData("StillRefused")
    func ACallWithNoConversionIsStillRefused(name string, body string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4036_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(
                tempDir,
                "App.gs",
                Preamble + body + "\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            Assert.Equal([]string{expectedId}, ErrorIds(appLog))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The emitted call names the receiver's OWN member, not the widening
    /// interface one. Asserted on metadata rather than on stdout because a
    /// correct answer could in principle be reached either way, and the point
    /// of the fix is which member is bound.
    @Fact
    func TheEmittedCallBindsTheReceiversOwnAddNotTheWideningInterfaceMember() {
        const Body = `let list = List[float64]()
list.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(list[0])`
        let tempDir = Directory.CreateTempSubdirectory("gs_4036_il_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(
                tempDir,
                "App.gs",
                Preamble + Body + "\n",
                appPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.True(File.Exists(appPath), (`the program must compile. Log:
` + "$appLog"))
            IlVerifier.Verify(appPath, []string{libPath})
            let referencedMembers = ReferencedMemberNames(appPath)
            // The widening member is a MemberRef whose parent is the
            // NON-GENERIC `System.Collections.IList` TypeRef; the receiver's own
            // `Add` is a MemberRef parented at the constructed
            // `List`1<double>` TypeSpec, so it carries no type-reference
            // prefix. Before the fix the first was present and the second was
            // not; after it, exactly the other way round.
            Assert.DoesNotContain("System.Collections.IList::Add", referencedMembers)
            Assert.Contains("Add", referencedMembers)
            // The same-compilation conversion operator is DEFINED in this
            // assembly, so it is a MethodDef rather than a MemberRef — and the
            // program only prints 2.5 because it is now called.
            Assert.Contains("op_Implicit", DefinedMethodNames(appPath))
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The G# preamble every row shares: a same-compilation struct with a
        /// user-defined implicit conversion to `float64`. Its CLR type does
        /// not exist while binding, which is the whole premise.
        private const Preamble string = `package P
import System
import System.Collections.Generic
import HelperLib4036

struct Celsius {
    var Degrees float64
}

func operator implicit(value Celsius) float64 {
    return value.Degrees
}
`

        /// A referenced C# library whose `Fahrenheit` carries the same
        /// conversion but DOES have a CLR type. It is the control that separates
        /// "user-defined conversions at a CLR parameter" (which already worked)
        /// from "a same-compilation argument erased to `object`" (which is the
        /// defect).
        private const LibrarySource string = `namespace HelperLib4036;

public readonly struct Fahrenheit
{
    public Fahrenheit(double degrees) => Degrees = degrees;

    public double Degrees { get; }

    public static implicit operator double(Fahrenheit value) => value.Degrees;
}`

        /// Every form that must now apply the conversion, run, and print. All of
        /// them except the spread row compiled before the fix and then either threw
        /// at run time or answered the wrong value in silence. The spread row is
        /// the CONTROL: it always worked, and it pins the behaviour the others now
        /// match.
        /// @returns Case name, the G# body appended to the preamble, expected stdout lines.
        func ConversionIsApplied() sequence[[]object] {
            // THE ISSUE'S OWN REPRO. Threw ArgumentException from
            // List`1.System.Collections.IList.Add.
            yield[]object{"the-issues-author-written-add", `let list = List[float64]()
list.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(list[0])`, []string{"2.5"}}
            // THE SPREAD FORM the issue contrasts it with. Green before and after.
            yield[]object{"the-spread-form-that-always-worked", `let source = []Celsius{ Celsius{ Degrees: 2.5 } }
let list = List[float64](){ ...source }
Console.WriteLine(list[0])`, []string{"2.5"}}
            // ISSUE #4054: the pinned ordinary-CLR-call failure. There is no
            // widening interface member beside Math.Abs(double); symbolic
            // conversion classification now makes the overload applicable.
            yield[]object{
                "an-ordinary-static-clr-parameter",
                "Console.WriteLine(Math.Abs(Celsius{ Degrees: 0.0 - 2.5 }))",
                []string{"2.5"}
            }
            // NOT IN THE ISSUE: the collection LITERAL threw the same way.
            yield[]object{
                "the-collection-literal-form",
                "let list = List[float64]{ Celsius{ Degrees: 2.5 } }\nConsole.WriteLine(list[0])",
                []string{"2.5"}
            }
            // NOT IN THE ISSUE: a two-argument widening member, where only the
            // SECOND position needs repairing.
            yield[]object{"a-two-argument-add-where-only-the-value-converts", `let lookup = Dictionary[string, float64]()
lookup.Add("a", Celsius{ Degrees: 2.5 })
Console.WriteLine(lookup["a"])`, []string{"2.5"}}
            // NOT IN THE ISSUE, and worse than a throw: `IList.Contains(object)`
            // answered False and `IList.IndexOf(object)` answered -1, silently.
            yield[]object{"contains-answered-false-in-silence", `let list = List[float64]()
list.Add(2.5)
Console.WriteLine(list.Contains(Celsius{ Degrees: 2.5 }))
Console.WriteLine(list.IndexOf(Celsius{ Degrees: 2.5 }))`, []string{"True", "0"}}
            // NOT IN THE ISSUE: Insert threw; Remove reported GS0124 because
            // `IList.Remove` is void while `ICollection<T>.Remove` returns bool.
            yield[]object{"insert-and-remove", `let list = List[float64]()
list.Insert(0, Celsius{ Degrees: 2.5 })
Console.WriteLine(list[0])
Console.WriteLine(list.Remove(Celsius{ Degrees: 2.5 }))
Console.WriteLine(list.Count)`, []string{"2.5", "True", "0"}}
            // REVIEW FINDING (#4060). Every form above has a NAMED-argument
            // spelling, and the repair compared source-order arguments against
            // declaration-order parameters. The single-argument forms were fine by
            // luck — with one argument any mapping is the identity — but the two
            // multi-argument forms were not, and `Dictionary.Add` reordered was the
            // reviewer's repro.
            yield[]object{"named-arguments-reordered-on-a-two-argument-add", `let lookup = Dictionary[string, float64]()
lookup.Add(value: Celsius{ Degrees: 2.5 }, key: "a")
Console.WriteLine(lookup["a"])`, []string{"2.5"}}
            yield[]object{"named-arguments-in-source-order-on-a-two-argument-add", `let lookup = Dictionary[string, float64]()
lookup.Add(key: "a", value: Celsius{ Degrees: 2.5 })
Console.WriteLine(lookup["a"])`, []string{"2.5"}}
            yield[]object{"named-arguments-reordered-on-insert", `let list = List[float64]()
list.Insert(item: Celsius{ Degrees: 2.5 }, index: 0)
Console.WriteLine(list[0])`, []string{"2.5"}}
            yield[]object{"named-arguments-on-the-single-argument-forms", `let list = List[float64]()
list.Add(item: Celsius{ Degrees: 2.5 })
Console.WriteLine(list[0])
Console.WriteLine(list.Contains(item: Celsius{ Degrees: 2.5 }))
Console.WriteLine(list.IndexOf(item: Celsius{ Degrees: 2.5 }))
Console.WriteLine(list.Remove(item: Celsius{ Degrees: 2.5 }))`, []string{"2.5", "True", "0", "True"}}
        }

        /// The neighbours the repair must leave exactly as they are: the shapes a
        /// careless gate would break. #4013's and #4028's own refusal rows are
        /// separate, in (cref:StillRefused).
        /// @returns Case name, the G# body appended to the preamble, expected stdout lines.
        func UnchangedNeighbours() sequence[[]object] {
            // The receiver genuinely wants `object`, and `Celsius -> object` is an
            // ordinary boxing conversion — so no position needs repairing and the
            // element stays a boxed Celsius.
            yield[]object{"a-list-of-object-still-boxes", `let list = List[object]()
list.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(list.Count)`, []string{"1"}}
            // The element type IS the same-compilation type, so the RECEIVER is
            // erased and nothing here may judge the call.
            yield[]object{"an-erased-receiver-is-not-judged", `let list = List[Celsius]()
list.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(list.Count)`, []string{"1"}}
            // A conversion at a CLR parameter with a REAL argument CLR type
            // already worked; this row proves the fix did not change how.
            yield[]object{"an-imported-argument-with-a-conversion-was-already-right", `let list = List[float64]()
list.Add(Fahrenheit(2.5))
Console.WriteLine(list[0])`, []string{"2.5"}}
            // A plain float64 argument needs no repair at all.
            yield[]object{"a-plain-float64-argument-is-untouched", `let list = List[float64]()
list.Add(2.5)
Console.WriteLine(list[0])`, []string{"2.5"}}
        }

        /// The rows that must still be REFUSED. #4028's whole point is that a
        /// widening member reachable with no erasure to repair is not a licence,
        /// and a repair that fired without a conversion would undo that.
        /// @returns Case name, the G# body appended to the preamble, expected diagnostic id.
        func StillRefused() sequence[[]object] {
            // #4028's row: a same-compilation Celsius at an int32 it does not
            // convert to. No conversion exists, so no repair, and the widening
            // member is still removed by the #4028 filter.
            yield[]object{"a-same-compilation-argument-with-no-conversion", `let list = List[int32]()
list.Add(Celsius{ Degrees: 2.5 })
Console.WriteLine(list.Count)`, "GS0159"}
            // #4013's row: a genuine string at a genuine int32.
            yield[]object{"a-genuine-string-at-a-genuine-int32", `let list = List[int32]()
list.Add("x")
Console.WriteLine(list.Count)`, "GS0159"}
            // REVIEW FINDING (#4060), negative control. Reordering the names must
            // not become a way to smuggle a conversion that does not exist: the
            // repair reorders in order to ask the RIGHT question, not to stop
            // asking it.
            yield[]object{"named-arguments-reordered-with-no-conversion-to-the-value-type", `let lookup = Dictionary[string, int32]()
lookup.Add(value: Celsius{ Degrees: 2.5 }, key: "a")
Console.WriteLine(lookup.Count)`, "GS0159"}
        }

        private func RunAndExpect(name string, body string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4036_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, "App.dll")
                let appLog = Compile(
                    tempDir,
                    "App.gs",
                    Preamble + body + "\n",
                    appPath,
                    "/target:exe",
                    "/reference:" + libPath
                )
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

        private func DefinedMethodNames(assemblyPath string) IReadOnlyCollection[string] {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let md = pe.GetMetadataReader()
            return md
                .MethodDefinitions
                .Select((handle MethodDefinitionHandle) -> md.GetString(md.GetMethodDefinition(handle).Name))
                .ToList()
        }

        private func ReferencedMemberNames(assemblyPath string) IReadOnlyCollection[string] {
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let md = pe.GetMetadataReader()
            let names = List[string]()
            for handle in md.MemberReferences {
                let member = md.GetMemberReference(handle)
                let name = md.GetString(member.Name)
                let parent = member.Parent
                if parent.Kind == HandleKind.TypeReference {
                    let typeRef = md.GetTypeReference(TypeReferenceHandle(parent))
                    let ns = md.GetString(typeRef.Namespace)
                    let typeName = md.GetString(typeRef.Name)
                    names.Add(
                        (
                            if ns.Length == 0 {
                                typeName
                            } else {
                                ns + "." + typeName
                            }
                        ) +
                            "::" +
                            name
                    )
                } else {
                    names.Add(name)
                }
            }
            return names
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .ToArray()

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib4036",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4036.dll")
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
