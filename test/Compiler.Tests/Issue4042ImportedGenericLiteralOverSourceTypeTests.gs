// <copyright file="Issue4042ImportedGenericLiteralOverSourceTypeTests.cs" company="GSharp">
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

/// Issue #4042: an object literal of an IMPORTED generic over a
/// SAME-COMPILATION type argument.
/// @remarks <b>The defect.</b> `Handler[MyOptions]{Tag: "z"}` reported
/// `GS0157: Cannot find type Handler. Are you missing an import?` — not a
/// message about the literal, but the fall-through for a type that could not
/// be named at all — while the CONSTRUCTOR spelling
/// `Handler[MyOptions]()` of the very same instantiation compiled, IL-
/// verified and ran. Re-measured on the parent before anything was written.
///
/// <b>Why a same-compilation argument was not "CLR-faithful".</b> The
/// imported-generic literal branch was gated on
/// `!hasSymbolicArgument || HasOnlyClrFaithfulSymbolicArguments(...)`. A
/// same-compilation user class has NO reference-context CLR type while
/// binding — its TypeDef is only produced at emit — so
/// `TryResolveClrConstructionTypeArgs` closes it over the `object`
/// SURROGATE and `HasOnlyClrFaithfulSymbolicArguments` answers false by
/// its own definition (`argument.ClrType == null`). That predicate came
/// from #4024 and is CORRECT about what it says: the closed CLR type
/// `Handler<object>` does not describe the argument. It was being
/// used for the wrong thing — as a gate on ENTERING the branch, when the fact
/// it establishes only decides the RESULT TYPE. The fix moves it: the branch
/// is entered for every resolvable argument, and a non-faithful vector is
/// carried beside the erased shape as
/// `ImportedTypeSymbol.GetConstructed(...)`, which is exactly what the
/// CONSTRUCTOR path has done since #671 and is why that spelling worked.
///
/// <b>Measured, not assumed: this is binder-only.</b> The discriminating
/// probe was the ADR-0117 object-initializer SUFFIX,
/// `Handler[MyOptions](){Tag = "z"}`, which produces the same bound nodes
/// (`BoundClrConstructorCallExpression` plus member assignments) over a
/// constructed-symbol receiver. On the parent it compiled, IL-verified and
/// printed `z` — so the emitter already reified `Handler<MyOptions>`
/// from that shape and nothing in emit needed changing. The parity row below
/// asserts the reified runtime type
/// (`HelperLib2.Handler`1[P.MyOptions]`, not `…[System.Object]`) for
/// both spellings.
///
/// <b>The three LOSSY-BUT-REAL spellings are must-not-change rows.</b>
/// `Box[[]int32]{…}` (#4024), `Box[[3]int32]{…}` (#3962) and the
/// named-tuple spelling (ADR-0172) each retain a symbolic argument that DOES
/// have a faithful closed CLR type. They keep taking the plain path — the
/// predicate still decides which — and are pinned here as well as in
/// `Issue4024SliceTypeArgumentRetentionTests`.
///
/// <b>Widening the branch does not widen what is ACCEPTED.</b> #4032's
/// constraint check sits at the top of the branch, so
/// `Handler[NotOptions]{…}` now reports `GS0152` where it used to
/// report GS0157, and #4037's forwarding rule reaches the literal too, so
/// `Handler[T]{…}` inside an unconstrained `func f[T]` reports
/// `GS0580`. Both are rows here.
///
/// <b>Issue #4059 closed the shared follow-up.</b> A member whose type
/// is the erased type parameter now projects through the symbolic receiver on
/// both spellings, so `Handler[MyOptions]().Options!!.Name` and the literal
/// twin bind and execute against `MyOptions`, not `object`.
open class Issue4042ImportedGenericLiteralOverSourceTypeTests {
    /// A literal of an imported generic over a same-compilation type argument
    /// binds, IL-verifies, runs, and reifies the real closed type.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("BindingLiterals")
    func AnImportedGenericLiteral_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The parent's symptom, named explicitly: the fall-through that
            // could not name the type at all.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0152", appLog, StringComparison.Ordinal)
            Assert.DoesNotContain("GS0580", appLog, StringComparison.Ordinal)
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

    /// The checks at the top of the widened branch still refuse what they
    /// refused, and say why.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedId The diagnostic id the log must carry.
    @Theory
    @MemberData("RefusedLiterals")
    func AnInvalidImportedGenericLiteral_IsRefused(name string, source string, expectedId string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_neg_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not compile. Log:
` + "$appLog"))
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
            // The parent's wrong message must not be what a reader sees.
            Assert.DoesNotContain("GS0157", appLog, StringComparison.Ordinal)
            // Issue #4032's lesson: assert the COUNT, not the presence.
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

    /// Issue #4059: a member whose type is the erased type parameter must be
    /// projected through the symbolic receiver on both construction spellings.
    /// @remarks Both spellings must bind, execute, and produce the same value.
    @Fact
    func AMemberTypedByTheErasedParameter_ProjectsOnBothSpellings() {
        const ViaLiteral = (`package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let o = MyOptions()
o.Name = "n1"
let h = Handler[MyOptions]{Tag: "z", Options: o}
// Issue #4356: ` + "`" + `Options` + "`" + ` is declared ` + "`" + `TOptions?` + "`" + `; the chained read asserts.
Console.WriteLine(h.Options!!.Name)`)
        const ViaConstructor = (`package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let o = MyOptions()
o.Name = "n1"
let h = Handler[MyOptions]()
h.Options = o
// Issue #4356: ` + "`" + `Options` + "`" + ` is declared ` + "`" + `TOptions?` + "`" + `; the chained read asserts.
Console.WriteLine(h.Options!!.Name)`)
        let tempDir = Directory.CreateTempSubdirectory("gs_4042_erasure_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let literalPath = Path.Combine(tempDir, "ViaLiteral.dll")
            let literalLog = Compile(
                tempDir,
                "ViaLiteral.gs",
                ViaLiteral,
                literalPath,
                "/target:exe",
                "/reference:" + libPath
            )
            let constructorPath = Path.Combine(tempDir, "ViaConstructor.dll")
            let constructorLog = Compile(
                tempDir,
                "ViaConstructor.gs",
                ViaConstructor,
                constructorPath,
                "/target:exe",
                "/reference:" + libPath
            )
            Assert.DoesNotContain("error GS", literalLog, StringComparison.Ordinal)
            Assert.DoesNotContain("error GS", constructorLog, StringComparison.Ordinal)
            Assert.True(File.Exists(literalPath), literalLog)
            Assert.True(File.Exists(constructorPath), constructorLog)
            let literalRun = RunDotnet(literalPath)
            let constructorRun = RunDotnet(constructorPath)
            Assert.Equal(0, literalRun.Exit)
            Assert.Equal(0, constructorRun.Exit)
            Assert.Equal("n1", literalRun.Output.Trim())
            Assert.Equal("n1", constructorRun.Output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library every row links against. Mirrors the issue's own
        /// library, plus an UNCONSTRAINED generic and a member typed by the type
        /// parameter itself.
        private const LibrarySource string = `namespace HelperLib2;

public class SchemeOptions
{
    public string? Name { get; set; }
}

public class Handler<TOptions>
    where TOptions : SchemeOptions
{
    public string Tag { get; set; } = "t";

    public TOptions? Options { get; set; }
}

public class Box<T>
{
    public string Tag { get; set; } = "b";

    public T? Value { get; set; }
}`

        /// Every literal spelling that must bind, verify and run.
        /// @returns Case name, G# source, expected stdout lines.
        func BindingLiterals() sequence[[]object] {
            // THE ISSUE'S OWN REPRO. GS0157 on the parent.
            yield[]object{"the-issues-repro-a-literal-over-a-same-compilation-type-argument", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let lit = Handler[MyOptions]{Tag: "z"}
Console.WriteLine(lit.Tag)`, []string{"z"}}
            // PARITY WITH THE CONSTRUCTOR SPELLING, which is what the issue's
            // Expected asks for — and the reified runtime type is asserted, so
            // "it printed the right answer" is not the whole claim. `Handler<object>`
            // would print `HelperLib2.Handler`1[System.Object]`.
            yield[]object{"the-literal-and-the-constructor-spellings-reify-the-same-closed-type", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

let ctor = Handler[MyOptions]()
ctor.Tag = "c"
let lit = Handler[MyOptions]{Tag: "c"}
Console.WriteLine(ctor.Tag)
Console.WriteLine(lit.Tag)
Console.WriteLine(ctor.GetType().ToString())
Console.WriteLine(lit.GetType().ToString())`, []string{
                    "c",
                    "c",
                    "HelperLib2.Handler`1[P.MyOptions]",
                    "HelperLib2.Handler`1[P.MyOptions]"
                }}
            // A TYPE PARAMETER as the argument. The constructor path admits one, so
            // the literal must too — and #4037's forwarding rule is what makes the
            // FORWARDED spelling the legal one.
            yield[]object{"a-literal-over-a-forwarded-type-parameter", `package P
import System
import HelperLib2

class MyOptions : SchemeOptions {
}

func viaParam[T SchemeOptions]() string {
    let h = Handler[T]{Tag: "p"}
    return h.Tag
}

Console.WriteLine(viaParam[MyOptions]())`, []string{"p"}}
            // A SAME-COMPILATION class at an UNCONSTRAINED imported generic — the
            // commonest shape, and the one that would have shown any regression in
            // ordinary code. GS0157 on the parent too.
            yield[]object{"a-literal-of-an-unconstrained-imported-generic-over-a-same-compilation-class", `package P
import System
import HelperLib2

class Thing {
    public var N int32
}

let t = Thing()
t.N = 4
let b = Box[Thing]{Tag: "u", Value: t}
Console.WriteLine(b.Tag)
Console.WriteLine(b.GetType().ToString())`, []string{"u", "HelperLib2.Box`1[P.Thing]"}}
            // MUST NOT CHANGE: the IMPORTED type argument, which bound before this
            // change and is the spelling Issue4032's green row uses.
            yield[]object{"control-a-literal-over-an-imported-type-argument-still-binds", `package P
import System
import HelperLib2

let lit = Handler[SchemeOptions]{Tag: "z"}
Console.WriteLine(lit.Tag)
Console.WriteLine(lit.GetType().ToString())`, []string{"z", "HelperLib2.Handler`1[HelperLib2.SchemeOptions]"}}
            // MUST NOT CHANGE: the three LOSSY-BUT-REAL spellings. Each retains a
            // symbolic argument that nonetheless has a faithful closed CLR type, so
            // each keeps taking the plain path. `[]T` is #4024's row, `[N]T` is
            // #3962's, the named tuple is ADR-0172's.
            //
            // The `!!` on the two reads is issue #4356, not a change of
            // subject: `Box<T>.Value` is declared `T?`, so the read is a
            // dereference of an ANNOTATED-nullable imported member. Member lookup
            // used to wave that through — the carve-out #4356 deleted could not
            // tell it from an oblivious member — and now reports it like any other
            // `T?`. What this row asserts is the literal SPELLING still binding,
            // which it does; the reads are how the row observes the values.
            yield[]object{"control-the-three-lossy-but-real-spellings-still-bind", `package P
import System
import HelperLib2

let slice = Box[[]int32]{ Value: []int32{1, 2, 3} }
Console.WriteLine(slice.Value!!.Length)

let fixedLen = Box[[3]int32]{ Value: [3]int32{1, 2, 3} }
Console.WriteLine(fixedLen.Value!!.Length)

let named = Box[(a int32, b string)]{ Tag: "nt" }
Console.WriteLine(named.Tag)`, []string{"3", "3", "nt"}}
        }

        /// Widening the branch must not widen what is ACCEPTED: the checks that
        /// sit at the top of it now reach the literal spelling too.
        /// @returns Case name, G# source, expected diagnostic id.
        func RefusedLiterals() sequence[[]object] {
            // #4032's constraint check. On the parent this reported GS0157
            // ("Cannot find type Handler") — the wrong message for the wrong
            // reason. Now it reports the violation.
            yield[]object{"a-literal-over-a-same-compilation-class-that-misses-the-bound", `package P
import System
import HelperLib2

class NotOptions {
    public var N int32
}

let bad = Handler[NotOptions]{Tag: "z"}
Console.WriteLine(bad.Tag)`, "GS0152"}
            // #4037's forwarding rule, reached through the literal.
            yield[]object{"a-literal-over-an-unforwarded-type-parameter", `package P
import System
import HelperLib2

func viaOpen[T]() string {
    let h = Handler[T]{Tag: "p"}
    return h.Tag
}

Console.WriteLine(viaOpen[SchemeOptions]())`, "GS0580"}
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
