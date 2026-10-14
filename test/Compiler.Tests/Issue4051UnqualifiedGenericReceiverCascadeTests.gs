// <copyright file="Issue4051UnqualifiedGenericReceiverCascadeTests.cs" company="GSharp">
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
import System.Text.RegularExpressions
import Xunit

/// Issue #4051: a constraint violation on an <em>unqualified</em> generic
/// receiver reported the accurate `GS0152` and then invented two more
/// reasons that were false.
/// @remarks <b>What happened.</b> #4032 (PR #4040) made gsc validate declared
/// generic constraints at every construction site. At the qualified spellings
/// the diagnostic stands alone, because `TryWalkQualifiedClrTypePath` was
/// given a `failureHandled` escape. The unqualified spellings had no such
/// hook: when `TryResolveConstructedGenericTypeReceiver` returned
/// `false` after the close had ALREADY reported, every caller
/// read that as "not a type" and fell through to binding `Name[Arg]` as an
/// ordinary INDEX expression — so `Name` and `Arg` were each looked
/// up as values. `Nullable[string].Value` told the author
/// `GS0125: Variable 'Nullable' doesn't exist.` and
/// `GS0125: Variable 'string' doesn't exist.` — and `string` is a
/// predefined type keyword.
///
/// <b>Where the false diagnostics actually came from</b> — measured, not
/// read off the issue. Not the `else if` chain in
/// `ExpressionBinder.Access.Accessor.cs` the filing agent named: by the
/// time that chain runs, `BindAccessorExpression` has already executed
/// `receiver = BindExpression(leftPart)` a few hundred lines earlier, and
/// THAT is what re-reads the receiver as an index expression. The remedy is
/// therefore an early return at the FIRST pair of resolver calls, before that
/// line, plus the matching escape in the write
/// (`BindMemberFieldAssignmentExpression`) and compound-assignment
/// (`BindEventSubscriptionExpression`) paths, which each fall through to a
/// `BindExpression` of their own.
///
/// <b>Scope.</b> The issue tabulated eight spellings. Sweeping every
/// spelling the resolver's call sites actually serve found FOUR more that
/// cascade the same way and were not listed: a static-field read, a
/// static-field write, a static-field compound assignment (each
/// `GS0125 x2`), and the generic-NAME receiver shape
/// `Handler[string?]` (`GS0124 x1` + `GS0159 x1`). The
/// unqualified-static row also carried a `GS0159` the issue's table
/// omitted. All twelve are covered here; nothing is left over.
///
/// <b>Four of the eight call sites are deliberately left on the
/// discarding overload</b>, in two pairs.
/// `TryResolveInheritedImportedNestedType`'s two consume only
/// `constructedStruct` — the USER-symbol output — and only the imported
/// close can report `GS0152`, so a wired `failureHandled` there would
/// be dead code. The `else if` chain's two are unreachable for this
/// failure once the early return above precedes them. The other four are
/// wired: the two read-path calls that carried the cascade, the write path
/// (`BindMemberFieldAssignmentExpression`), and the compound-assignment
/// path (`BindEventSubscriptionExpression`). Every one of those facts is
/// measured by the rows below reporting exactly one diagnostic each.
///
/// <b>Nothing individually correct is suppressed.</b> `GS0152` is
/// still reported, exactly once, at every spelling. What is removed is only the
/// second reading of a receiver the compiler had already refused.
open class Issue4051UnqualifiedGenericReceiverCascadeTests {
    /// A violating spelling reports `GS0152` and NOTHING ELSE. The
    /// assertion is on the exact multiset of diagnostic ids, in order, so a
    /// consequential error re-appearing is a failure rather than a silence.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedIds The exact diagnostic ids the log must carry, in order.
    @Theory
    @MemberData("ConstraintViolations")
    func AViolatingGenericReceiver_ReportsTheConstraintAndNothingElse(name string, source string, expectedIds[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4051_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            let ids = ErrorIds(appLog)
            Assert.Equal(expectedIds, ids)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The two messages the issue calls out by name are gone. Pinned
    /// separately from the id multiset because the complaint was about the
    /// TEXT: telling an author that `string` is a variable that does not
    /// exist is worse than saying nothing.
    @Fact
    func ThePredefinedTypeKeywordIsNeverReportedAsAMissingVariable() {
        const Source = `package P
import System

let v = Nullable[string].Value
Console.WriteLine("x")`
        let tempDir = Directory.CreateTempSubdirectory("gs_4051_msg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "Message.dll")
            let appLog = Compile(tempDir, "App.gs", Source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.Contains("GS0152", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("Variable 'string' doesn't exist", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("Variable 'Nullable' doesn't exist", appLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Every satisfying spelling still compiles, IL-verifies, runs, and prints
    /// what it always printed. The early returns this fix adds are reached only
    /// after a diagnostic was reported; these rows are what proves that.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("SatisfyingShapes")
    func ASatisfyingGenericReceiver_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4051_pos_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, "App.dll")
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

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. `Handler<TOptions>`
        /// carries the constraint, a static method, and a static field, so one type
        /// serves the static-call, static-read, static-write and compound-assignment
        /// spellings.
        private const LibrarySource string = `namespace HelperLib4051;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public static string Field = "f";

    public string Tag { get; set; } = "t";

    public static string Describe() => "described";
}`

        /// Every spelling that closes a constrained imported generic over an
        /// argument that violates the constraint. The expected value is the EXACT
        /// diagnostic-id multiset, not a containment check: the whole defect was a
        /// correct diagnostic keeping bad company, so a test that only asked
        /// whether `GS0152` was present would have passed before the fix.
        /// @returns Case name, G# source, and the exact expected diagnostic ids.
        func ConstraintViolations() sequence[[]object] {
            // The five spellings PR #4040 already left clean. They are here as the
            // control the fix must not disturb.
            yield[]object{"qualified-static", `package P
import System

Console.WriteLine(System.Nullable[string].Value)`, []string{"GS0152"}}
            yield[]object{"import-qualified", `package P
import System

let v = System.Nullable[string].Value
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"type-clause", `package P
import System
import HelperLib4051

var h Handler[string]
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"base-clause", `package P
import System
import HelperLib4051

class Bad : Handler[string] {
}

Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"object-literal", `package P
import System
import HelperLib4051

let h = Handler[string]{Tag: "z"}
Console.WriteLine("x")`, []string{"GS0152"}}
            // THE ISSUE'S THREE. Before the fix: GS0125 x2, GS0125 x2 + GS0159,
            // and GS0130 respectively, each beside the accurate GS0152.
            yield[]object{"import-alias", `package P
import System

let v = Nullable[string].Value
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"unqualified-static-call", `package P
import System
import HelperLib4051

let d = Handler[string].Describe()
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"constructor", `package P
import System
import HelperLib4051

let h = Handler[string]()
Console.WriteLine("x")`, []string{"GS0152"}}
            // FOUR MORE, found by sweeping the resolver's other call sites rather
            // than by reading the issue's table. Before the fix: GS0125 x2 each for
            // the three field spellings, and GS0124 + GS0159 for the generic-NAME
            // receiver shape, which reaches a different resolver overload.
            yield[]object{"static-field-read", `package P
import System
import HelperLib4051

let f = Handler[string].Field
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"static-field-write", `package P
import System
import HelperLib4051

Handler[string].Field = "z"
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"static-field-compound-assignment", `package P
import System
import HelperLib4051

Handler[string].Field += "z"
Console.WriteLine("x")`, []string{"GS0152"}}
            yield[]object{"generic-name-receiver-shape", `package P
import System
import HelperLib4051

let d = Handler[string?].Describe()
Console.WriteLine("x")`, []string{"GS0152"}}
        }

        /// A SATISFYING counterpart for each spelling. These are the programs the
        /// early returns must not swallow: every one has to go on compiling,
        /// IL-verifying, running, and printing what it always printed.
        /// @remarks Several rows deliberately use an IMPORTED type argument
        /// (`Handler[SchemeOptions]`) rather than a same-compilation one, and
        /// the qualified-static row names `Comparer` rather than
        /// `Nullable`. Three neighbouring shapes are broken for reasons that
        /// have nothing to do with this issue — all three measured on the parent
        /// AND on this change, identical, and filed rather than smuggled in
        /// here:
        ///
        /// 1. `System.Nullable[int32]()` — a fully-qualified generic CONSTRUCTOR call reports
        /// `GS0157 Cannot find type System`, about a namespace. Issue #4055.
        /// 2. `Handler[MyOptions]{Tag: "z"}` — an object literal of an imported generic over a same-compilation
        /// type argument does not bind, reporting `GS0157`. Already filed as #4042 by the #4032 work.
        /// 3. `Handler[MyOptions].Field += "z"` — a static compound assignment through a generic receiver over
        /// a same-compilation type argument emits `Handler<object>`: unverifiable IL and a run-time
        /// `TypeLoadException`, even though `MyOptions` satisfies the constraint. That is the
        /// generic-CONSTRUCTION placeholder erasure of #4016/#4041 one receiver shape over. Issue #4056.
        ///
        /// These rows exercise the receiver-RESOLUTION path this fix touches,
        /// not the emit path those three fail in.
        /// @returns Case name, G# source, expected stdout lines.
        func SatisfyingShapes() sequence[[]object] {
            yield[]object{"qualified-static", `package P
import System

Console.WriteLine(System.Collections.Generic.Comparer[int32].Default.Compare(1, 2))`, []string{"-1"}}
            yield[]object{"type-clause", `package P
import System
import HelperLib4051

class MyOptions : SchemeOptions {
}

var h Handler[MyOptions]
Console.WriteLine("x")`, []string{"x"}}
            yield[]object{"base-clause", `package P
import System
import HelperLib4051

class MyOptions : SchemeOptions {
}

class Good : Handler[MyOptions] {
}

let g = Good()
Console.WriteLine(g.Tag)`, []string{"t"}}
            yield[]object{"object-literal", `package P
import System
import HelperLib4051

let h = Handler[SchemeOptions]{Tag: "z"}
Console.WriteLine(h.Tag)`, []string{"z"}}
            yield[]object{"import-alias", `package P
import System

let v = Nullable[int32]()
Console.WriteLine(v.HasValue)`, []string{"False"}}
            yield[]object{"unqualified-static-call", `package P
import System
import HelperLib4051

class MyOptions : SchemeOptions {
}

Console.WriteLine(Handler[MyOptions].Describe())`, []string{"described"}}
            yield[]object{"constructor", `package P
import System
import HelperLib4051

class MyOptions : SchemeOptions {
}

let h = Handler[MyOptions]()
Console.WriteLine(h.Tag)`, []string{"t"}}
            yield[]object{"static-field-read", `package P
import System
import HelperLib4051

Console.WriteLine(Handler[SchemeOptions].Field)`, []string{"f"}}
            yield[]object{"static-field-write", `package P
import System
import HelperLib4051

Handler[SchemeOptions].Field = "z"
Console.WriteLine(Handler[SchemeOptions].Field)`, []string{"z"}}
            yield[]object{"static-field-compound-assignment", `package P
import System
import HelperLib4051

Handler[SchemeOptions].Field += "z"
Console.WriteLine(Handler[SchemeOptions].Field)`, []string{"fz"}}
            yield[]object{"generic-name-receiver-shape", `package P
import System
import System.Collections.Generic

Console.WriteLine(Comparer[List[int32]].Default.GetType().Name)`, []string{"ObjectComparer`1"}}
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
                "HelperLib4051",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib4051.dll")
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
