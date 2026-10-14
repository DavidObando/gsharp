// <copyright file="Issue4422ByRefNullableStorageEmitTests.cs" company="GSharp">
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

/// Issue #4422: a by-reference argument whose storage is nullable-annotated
/// (`&base.runstack`, where the reference pack declares
/// `RegexRunner.runstack` as `int[]?`) at a `ref []int32`
/// parameter. This is the shape the real `[GeneratedRegex]` runner uses
/// for a regex that backtracks inside a loop
/// (`Utilities.StackPush(ref base.runstack!, …)` after cs2gs). gsc
/// reported GS0154; C# accepts it, and now gsc does too, with a GS0612
/// warning.
///
/// Each case compiles, passes ILVerify and runs, so the address really is
/// passed to the callee and written through.
open class Issue4422ByRefNullableStorageEmitTests {
    /// The generated runner's shape against a C# base that annotates the
    /// protected field `int[]?`, independent of whether the host's
    /// runtime assemblies carry nullable metadata.
    @Fact
    func AnnotatedProtectedField_PassedByRef_CompilesVerifiesAndRuns() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_fixture_").FullName
        try {
            let metadataPath = EmitFixture(tempDir)
            const source = `
package P
import System
import Issue4422.Metadata

func StackPush(ref stack []int32, ref pos int32, arg0 int32) {
    if pos >= stack.Length {
        Array.Resize(&stack, pos * 2)
    }

    stack[pos] = arg0
    pos++
}

func Label(ref s string) {
    s = s + "!"
}

class Runner : AnnotatedRunner {
    func Go() string {
        base.runstack = []int32{0}
        base.label = "l"
        var pos int32 = 1
        StackPush(&base.runstack, &pos, 7)
        StackPush(&base.runstack, &pos, 8)
        Label(&base.label)
        let stack = base.runstack!!
        return "${stack.Length} ${stack[1]} ${stack[2]} $pos ${base.label!!}"
    }
}

Console.WriteLine(Runner().Go())
`
            let outPath = Path.Combine(tempDir, "fixture.dll")
            let (exit, log) = Compile(tempDir, source, outPath, metadataPath)
            Assert.True(
                exit == 0,
                "a nullable-annotated field must be accepted by reference (GS0154 here is #4422):\n" + log
            )
            Assert.Equal(3, CountOccurrences(log, "warning GS0612"))
            IlVerifier.Verify(outPath, []string{metadataPath})
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run. Exit ` + "$runExit" + `:
` + "$output"))
            Assert.Equal("4 7 8 3 l!", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The real `RegexRunner` subclass shape, bound against the host's
    /// framework assemblies. Where those annotate `runstack` as
    /// `int[]?` (as the reference pack does) this was the #4422 GS0154;
    /// where they are oblivious it is a platform field. Either way it must
    /// compile, verify and run.
    @Fact
    func RegexRunnerRunstack_PassedByRef_CompilesVerifiesAndRuns() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_regex_").FullName
        try {
            const source = `
package P
import System
import System.Text.RegularExpressions

func StackPush(ref stack []int32, ref pos int32, arg0 int32) {
    if pos >= stack.Length {
        Array.Resize(&stack, pos * 2)
    }

    stack[pos] = arg0
    pos++
}

class Runner : RegexRunner {
    func Go() string {
        base.runstack = []int32{0, 0}
        base.runstackpos = 0
        StackPush(&base.runstack, &base.runstackpos, 5)
        StackPush(&base.runstack, &base.runstackpos, 6)
        StackPush(&base.runstack, &base.runstackpos, 7)
        let stack = base.runstack!!
        return "${stack.Length} ${stack[0]} ${stack[2]} ${base.runstackpos}"
    }
}

Console.WriteLine(Runner().Go())
`
            let outPath = Path.Combine(tempDir, "regex.dll")
            let (exit, log) = Compile(tempDir, source, outPath)
            Assert.True(exit == 0, "&base.runstack must be accepted at a ref []int32 parameter (#4422):\n" + log)
            Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal)
            IlVerifier.Verify(outPath)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run. Exit ` + "$runExit" + `:
` + "$output"))
            Assert.Equal("4 5 7 3", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// A value-type `int32?` is `Nullable<int32>`, not an
    /// annotation. Before the fix this compiled with no diagnostic and the
    /// callee's `int32` store landed on the `Nullable`'s
    /// `hasValue` field, so the program printed `1` instead of
    /// `42`. It must be GS0154.
    @Fact
    func ValueTypeNullableStorage_AtRefInt32_IsGS0154() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_value_").FullName
        try {
            const source = `
package P
import System

func SetI(ref i int32) {
    i = 42
}

var n int32? = 1
SetI(&n)
Console.WriteLine(n)
`
            let (exit, log) = Compile(tempDir, source, Path.Combine(tempDir, "value.dll"))
            Assert.True(exit != 0, "int32? storage must not be passed as ref int32:\n" + log)
            Assert.Contains("GS0154", log, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Overloads that differ only in the by-ref parameter's nullability select
    /// the exact storage type, as C# does, for free functions, methods and
    /// constructors, and the selected call verifies. Before the review fix,
    /// `int32?` storage selected `ref int32`.
    @Fact
    func OverloadsOnByRefNullability_SelectTheExactStorageAndVerify() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_overload_").FullName
        try {
            const source = `
package P
import System

func P(ref x int32) { x = x + 1 }
func P(ref x int32?) { x = 10 }
func Q(ref s string) { s = "q" }
func Q(ref s string?) { s = "q?" }

class K {
    var v int32 = 0
    init() {}
    init(ref x int32?) { x = 20 }
    init(ref x int32) { x = x + 2 }
    func M(ref x int32?) { x = 30 }
    func M(ref x int32) { x = x + 3 }
}

var a int32? = 1
var b int32 = 1
var s string? = nil
P(&a)
P(&b)
Q(&s)
Console.WriteLine("${a!!} $b ${s!!}")
K().M(&a)
K().M(&b)
Console.WriteLine("${a!!} $b")
let k1 = K(&a)
let k2 = K(&b)
Console.WriteLine("${a!!} $b")
`
            let outPath = Path.Combine(tempDir, "overload.dll")
            let (exit, log) = Compile(tempDir, source, outPath)
            Assert.True(exit == 0, "the exact by-ref overload must be selected:\n" + log)
            Assert.DoesNotContain("GS0612", log, StringComparison.Ordinal)
            IlVerifier.Verify(outPath)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run. Exit ` + "$runExit" + `:
` + "$output"))
            Assert.Equal(
                []string{"10 2 q?", "30 5", "20 7"},
                output
                    .Split('\n')
                    .Select((line string) -> line.Trim())
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// An imported `ref int` parameter must not take `&int32?`
    /// storage: on main `Interlocked.Increment(&x)` and
    /// `Int32.TryParse("5", &x)` compiled, ILVerify reported the
    /// address of a `Nullable`1` where an `Int32` was expected, and
    /// the program printed 41 twice. Reference-type nullability at imported
    /// by-ref parameters is unchanged, and those calls still verify and run.
    @Fact
    func ClrByRefCallees_RejectValueNullableStorage_AndKeepReferenceNullability() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_clr_").FullName
        try {
            const rejected = `
package P
import System
import System.Threading

var x int32? = 41
Interlocked.Increment(&x)
Int32.TryParse("5", &x)
Console.WriteLine(x)
`
            let (rejectExit, rejectLog) = Compile(tempDir, rejected, Path.Combine(tempDir, "rejected.dll"))
            Assert.True(rejectExit != 0, "&int32? must not reach an imported ref int:\n" + rejectLog)
            Assert.Equal(2, CountOccurrences(rejectLog, "error GS0154"))
            const accepted = `
package P
import System
import System.Threading

var arr []?int32 = []int32{1}
Array.Resize(&arr, 3)
var o string? = nil
Interlocked.Exchange(&o, "a")
Interlocked.CompareExchange(&o, "b", "a")
var y int32 = 41
Interlocked.Increment(&y)
Console.WriteLine("${arr!!.Length} ${Volatile.Read(&o)} $y")
`
            let outPath = Path.Combine(tempDir, "accepted.dll")
            let (exit, log) = Compile(tempDir, accepted, outPath)
            Assert.True(exit == 0, log)
            Assert.DoesNotContain("GS0612", log, StringComparison.Ordinal)
            IlVerifier.Verify(outPath)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`program must run. Exit ` + "$runExit" + `:
` + "$output"))
            Assert.Equal("3 b 42", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// ADR-0175 amendment: gsc honours an `@SuppressDiagnostic("GS0612")`
    /// scope before it applies `/warnaserror`, so the suppressed call
    /// builds while the same call outside the scope is promoted to an error.
    @Fact
    func SuppressedGS0612_SurvivesWarnAsError_AndTheUnsuppressedOneDoesNot() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4422_suppress_").FullName
        try {
            const callee = `
package P
import System

func R(ref s string) { s = "r" }

var a string? = nil
`
            const suppressed = callee + `
@SuppressDiagnostic("GS0612") {
    R(&a)
}
Console.WriteLine(a)
`
            let outPath = Path.Combine(tempDir, "suppressed.dll")
            let (exit, log) = Compile(tempDir, suppressed, outPath, extraOption: "/warnaserror")
            Assert.True(exit == 0, "a suppressed GS0612 must not be promoted by /warnaserror:\n" + log)
            Assert.DoesNotContain("GS0612", log, StringComparison.Ordinal)
            IlVerifier.Verify(outPath)
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, output)
            Assert.Equal("r", output.Trim())
            const unsuppressed = callee + `
R(&a)
Console.WriteLine(a)
`
            let (failExit, failLog) = Compile(
                tempDir,
                unsuppressed,
                Path.Combine(tempDir, "unsuppressed.dll"),
                extraOption: "/warnaserror"
            )
            Assert.True(failExit != 0, failLog)
            Assert.Contains("error GS0612", failLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const FixtureSource string = `#nullable enable
namespace Issue4422.Metadata
{
    public class AnnotatedRunner
    {
        protected internal int[]? runstack;
        protected string? label;
    }
}`

        private func EmitFixture(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue4422.Metadata",
                []SyntaxTree{CSharpSyntaxTree.ParseText(FixtureSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let metadataPath = Path.Combine(tempDir, "Issue4422.Metadata.dll")
            let result = compilation.Emit(metadataPath)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return metadataPath
        }

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            var index = text.IndexOf(value, StringComparison.Ordinal)
            while index >= 0 {
                count++
                index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal)
            }
            return count
        }

        private func Compile(
            tempDir string,
            source string,
            outPath string,
            extraReference string? = nil,
            extraOption string? = nil
        )(Exit int32, Log string) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            if extraOption != nil {
                args.Add(extraOption)
            }
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            if extraReference != nil {
                args.Add("/reference:" + extraReference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, "stdout:\n" + compileOut.ToString() + `
stderr:
` + compileErr.ToString())
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
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
