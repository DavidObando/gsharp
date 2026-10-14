// <copyright file="Issue3802NotNullIfNotNullTests.cs" company="GSharp">
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

/// Issue #3802: gsc must honour `[return: NotNullIfNotNull(nameof(p))]` on
/// imported (BCL) members. `Path.ChangeExtension` is declared
/// `string? ChangeExtension(string? path, string? extension)` with that
/// conditional post-condition, so C# accepts
/// `string DestinationRelativePath(string source) => Path.ChangeExtension(source, ".gs");`.
///
/// Before this fix gsc reported `GS0155: Cannot convert type 'string?' to
/// 'string'` at every such site, which is what dropped the #3501
/// self-migration gate to 40/51 (`Cs2Gs.Pipeline` plus its three
/// consumers) once #3705 family 2 made imported nullability read correctly.
///
/// Every positive case EXECUTES: compile, IL-verify, run, assert the program's
/// own stdout. The narrowing is a bind-time type fact but a wrong
/// implementation (for example one that unconditionally strips the
/// annotation) is only visible at runtime, so binding-only assertions would
/// not be evidence.
open class Issue3802NotNullIfNotNullTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func NotNullIfNotNull_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3802_").FullName
        try {
            let outPath = Path.Combine(tempDir, name + ".dll")
            let (compileExit, compileLog) = Compile(tempDir, source, outPath)
            Assert.True(compileExit == 0, (`gsc failed for '` + "$name" + `' (a GS0155 here is the #3802 defect):
` + "$compileLog"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
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

    /// CONDITIONAL GUARD, compile half. The post-condition is CONDITIONAL: a
    /// nullable argument must still produce a nullable result. A fix that
    /// narrowed unconditionally would reintroduce exactly the unsoundness that
    /// #3705 family 2 removed — an imported `string?` silently binding as
    /// non-null `string` — so this case must still be REJECTED after the
    /// fix, and it fails on `origin/main` too (it is not the regression).
    @Fact
    func NullableArgument_StillYieldsNullableResult() {
        let tempDir = Directory.CreateTempSubdirectory("gs_3802_neg_").FullName
        try {
            let source = `
package P
import System
import System.IO

func Dest(source string?) string {
    return Path.ChangeExtension(source, ".gs")
}

Console.WriteLine(Dest("x.cs"))
`
            let outPath = Path.Combine(tempDir, "neg.dll")
            let (compileExit, compileLog) = Compile(tempDir, source, outPath)
            Assert.True(
                compileExit != 0,
                "a NULLABLE argument must NOT narrow the result: [NotNullIfNotNull] is a " +
                    "conditional post-condition, and narrowing it unconditionally would " +
                    "restore the #3705 family 2 unsoundness. Compile log:\n" +
                    compileLog
            )
            Assert.Contains("GS0155", compileLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// ANTI-VACUITY: a method with NO conditional post-condition and a genuinely
    /// nullable return must still be rejected when returned as non-nullable —
    /// including `Path.GetDirectoryName`, which sits on the same type as
    /// the annotated members and is deliberately NOT annotated (it returns
    /// `null` for a root path even when the argument is non-null, and C#
    /// rejects this source too). This is the behaviour #3705 family 2
    /// established; the #3802 fix must key off the attribute, not off the type.
    /// Passes on `origin/main` as well.
    /// @param name The case name.
    /// @param body The G# function body expression.
    @Theory
    @InlineData("environment-variable", "Environment.GetEnvironmentVariable(p)")
    @InlineData("get-directory-name-is-not-annotated", "Path.GetDirectoryName(p)")
    func UnannotatedNullableReturn_IsStillRejected(name string, body string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3802_anti_").FullName
        try {
            let source = `
package P
import System
import System.IO

func F(p string) string {
    return ` + body + `
}

Console.WriteLine(F("a/b/c.cs"))
`
            let outPath = Path.Combine(tempDir, "anti.dll")
            let (compileExit, compileLog) = Compile(tempDir, source, outPath)
            Assert.True(compileExit != 0, (`'` + "$name" + `': an unannotated nullable imported member must still be rejected:
`) + compileLog)
            Assert.Contains("GS0155", compileLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// The narrowing is wired on the imported INSTANCE call node as well as the
    /// static one. No .NET 10 BCL instance method carries
    /// `[return: NotNullIfNotNull]` (a reflection sweep of
    /// System.Private.CoreLib, System.Text.RegularExpressions and System.Private.Uri
    /// finds zero), so this case builds its own C# metadata assembly — which is
    /// also the shape any referenced third-party library would present.
    /// Compiles, IL-verifies and RUNS, and asserts the conditional half in the
    /// same reference context.
    @Fact
    func ImportedInstanceMethodCarrier_NarrowsAndStaysConditional() {
        let tempDir = Directory.CreateTempSubdirectory("gs_3802_inst_").FullName
        try {
            const metadataSource = `#nullable enable
using System.Diagnostics.CodeAnalysis;

namespace Issue3802.Metadata
{
    public sealed class Echo
    {
        [return: NotNullIfNotNull(nameof(input))]
        public string? Repeat(string? input) => input == null ? null : input + input;
    }
}`
            // TRUSTED_PLATFORM_ASSEMBLIES is always present under the test host;
            // its absence would be an environment fault, not a test condition.
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!))
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue3802.Metadata",
                []SyntaxTree{CSharpSyntaxTree.ParseText(metadataSource, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let metadataPath = Path.Combine(tempDir, "Issue3802.Metadata.dll")
            let metadataResult = compilation.Emit(metadataPath)
            Assert.True(metadataResult.Success, string.Join(Environment.NewLine, metadataResult.Diagnostics))
            const positive = `
package P
import System
import Issue3802.Metadata

func Twice(s string) string {
    return Echo().Repeat(s)
}

Console.WriteLine(Twice("ab"))
`
            let outPath = Path.Combine(tempDir, "inst.dll")
            let (exitCode, log) = Compile(tempDir, positive, outPath, metadataPath)
            Assert.True(exitCode == 0, "an imported INSTANCE carrier must narrow too:\n" + log)
            IlVerifier.Verify(outPath, []string{metadataPath})
            let (runExit, output) = RunDotnet(outPath)
            Assert.True(runExit == 0, (`instance carrier program must run. Exit ` + "$runExit" + `:
` + "$output"))
            Assert.Equal("abab", output.Trim())
            // CONDITIONAL GUARD for the instance path.
            const negative = `
package P
import System
import Issue3802.Metadata

func Twice(s string?) string {
    return Echo().Repeat(s)
}

Console.WriteLine(Twice("ab"))
`
            let (negExit, negLog) = Compile(tempDir, negative, Path.Combine(tempDir, "inst-neg.dll"), metadataPath)
            Assert.True(negExit != 0, "a nullable argument must not narrow the instance carrier:\n" + negLog)
            Assert.Contains("GS0155", negLog, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The exact reduction of the gate regression:
            // tools/cs2gs/Cs2Gs.Pipeline/RepositoryMirror.DestinationRelativePath.
            yield[]object{"change-extension-non-null-argument", `
package P
import System
import System.IO

func DestinationRelativePath(source string) string {
    return Path.ChangeExtension(source, ".gs")
}

Console.WriteLine(DestinationRelativePath("tools/cs2gs/Foo.cs"))
`, []string{"tools/cs2gs/Foo.gs"}}
            // Two more BCL carriers on the same type.
            yield[]object{"get-file-name-and-extension", `
package P
import System
import System.IO

func Leaf(p string) string {
    return Path.GetFileName(p)
}

func Ext(p string) string {
    return Path.GetExtension(p)
}

Console.WriteLine(Leaf("a/b/c.cs"))
Console.WriteLine(Ext("a/b/c.cs"))
`, []string{"c.cs", ".cs"}}
            // ANTI-VACUITY / CONDITIONAL GUARD, runtime half: when the named
            // argument IS nil the result really is nil, so the narrowed shape must
            // never be relied on to be non-nil. Binding this to `string?` still
            // works, and the value observed at runtime is nil.
            yield[]object{"nil-argument-still-yields-nil-at-runtime", `
package P
import System
import System.IO

func Dest(source string?) string? {
    return Path.ChangeExtension(source, ".gs")
}

let r = Dest(nil)
Console.WriteLine(if r == nil { "nil" } else { "not-nil" })
Console.WriteLine(Dest("x.cs")!!)
`, []string{"nil", "x.gs"}}
            // CONDITIONAL GUARD, by-ref half. `Volatile.Read[T](ref T location)` is
            // annotated `[return: NotNullIfNotNull(nameof(location))]`. The bound
            // argument is a BYREF, whose own type symbol is not a nullable one even
            // when it points at a nullable location — reading it naively narrows
            // the result and breaks issue #3727's `Volatile.Read(&r) != nil`. The
            // nullability that counts is the POINTEE's, and here it is nil.
            yield[]object{"byref-argument-uses-the-pointee-nullability", `
package P
import System
import System.Threading

class Result {
    var Value int32 = 0
}

func Guard() bool {
    var r Result? = nil
    return Volatile.Read(&r) == nil
}

Console.WriteLine(if Guard() { "nil" } else { "not-nil" })
`, []string{"nil"}}
        }

        private func Compile(tempDir string, source string, outPath string, extraReference string? = nil)(
            Exit int32,
            Log string
        ) {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
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
