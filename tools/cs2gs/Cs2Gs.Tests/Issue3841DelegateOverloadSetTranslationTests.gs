// <copyright file="Issue3841DelegateOverloadSetTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3841 — a legal C# overload set that discriminates on DELEGATE
/// IDENTITY (`Add(Predicate<T>)` / `Add(Func<T, bool>)`)
/// was translated into two members with the same G# signature, and gsc
/// correctly rejected the result with `GS0264`.
///
/// The issue was filed as a G# type-system gap wanting an ADR. It is not one:
/// gsc already declares and dispatches such an overload set when the delegate
/// types are spelled nominally. The duplicate is manufactured by cs2gs —
/// issue #2835's nominal-identity rule was scoped to SOURCE-declared
/// delegates, so imported ones (`Predicate`, `Func`) still erased to
/// the arrow form.
///
/// Imported delegates retain their nominal names, except canonical
/// `System.Func`/`System.Action`, which retain arrow form unless
/// overload collisions require their nominal identity. The
/// `NonCollidingCanonicalDelegates_StillRenderInArrowForm` test is the guard on
/// canonical-delegate exception.
open class Issue3841DelegateOverloadSetTranslationTests {
    /// The colliding method overload set keeps both nominal delegate names, so
    /// the two members no longer print the same signature.
    @Fact
    func CollidingMethodOverloadSet_KeepsNominalDelegateNames() {
        let rendered = Render()
        Assert.Contains("Add(callback Predicate[int32])", rendered, StringComparison.Ordinal)
        Assert.Contains("Add(callback Func[int32, bool])", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Add(callback (int32) -> bool)", rendered, StringComparison.Ordinal)
    }

    /// The same for the `.ctor` shape, which is the second of the two
    /// fingerprints this issue split out of #3837.
    @Fact
    func CollidingConstructorOverloadSet_KeepsNominalDelegateNames() {
        let rendered = Render()
        Assert.Contains("init(callback Predicate[int32])", rendered, StringComparison.Ordinal)
        Assert.Contains("init(callback Func[int32, bool])", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("init(callback (int32) -> bool)", rendered, StringComparison.Ordinal)
    }

    /// The generic shape from the migrated Interpreter.Tests fixture — the two
    /// members that actually reported the `GS0264`. Its type argument is
    /// an open `T`, so the collision rule must fire on the erased shapes
    /// rather than on any closed type.
    @Fact
    func GenericFixtureShape_KeepsNominalDelegateNames() {
        let rendered = Render()
        Assert.Contains("Add(callback Predicate[T])", rendered, StringComparison.Ordinal)
        Assert.Contains("Add(callback Func[T, bool])", rendered, StringComparison.Ordinal)
        Assert.Contains("init(callback Predicate[T])", rendered, StringComparison.Ordinal)
        Assert.Contains("init(callback Func[T, bool])", rendered, StringComparison.Ordinal)
    }

    /// The scoping guard. Delegate parameters that do NOT participate in a
    /// colliding overload set keep ADR-0115 §B.8's arrow form when their CLR
    /// identity is Func/Action. Predicate has a distinct identity (#4679),
    /// even without an overload collision.
    @Fact
    func NonCollidingCanonicalDelegates_StillRenderInArrowForm() {
        let rendered = Render()
        Assert.Contains("Length(length (string) -> int32)", rendered, StringComparison.Ordinal)
        Assert.Contains("Sink(sink (string) -> void)", rendered, StringComparison.Ordinal)
        Assert.Contains("Test(test Predicate[string])", rendered, StringComparison.Ordinal)
        Assert.Contains("Both(test Predicate[string], length (string) -> int32)", rendered, StringComparison.Ordinal)
    }

    /// The executing proof. Binding alone would pass a fix that preserved the
    /// names but crossed the wires, so the translated program is compiled by
    /// the real gsc and RUN: each call must reach the overload C# would have
    /// reached.
    ///
    /// Only the CLOSED shapes are exercised at run time. gsc cannot yet
    /// DISPATCH the generic shape — `Add(Predicate[T])` vs
    /// `Add(Func[T, bool])` on a substituted receiver reports
    /// `GS0266` — which is a separate, already-filed gsc defect (#3874)
    /// in applicability after generic substitution, not in the declaration
    /// model. The generic shapes are still COMPILED here (the classes are
    /// declared in the same program), which is what #3841 asked for.
    @Fact
    func TranslatedProgram_DispatchesEachDelegateOverloadLikeCSharp() {
        let printed = Render()
        let (exitCode, stdout) = CompileAndRun(printed)
        Assert.Equal(0, exitCode)
        let lines = stdout
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select((line string) -> line.Trim())
            .ToArray()
        Assert.True(
            lines.SequenceEqual([]string{"pred", "func", "pred", "func"}),
            "wrong overload reached: [" + string.Join(", ", lines) + `]

Translated G#:
` + printed
        )
    }

    shared {
        // Both the CLOSED shape (which gsc can also DISPATCH today) and the
        // GENERIC shape from the migrated fixture that reported the GS0264
        // (test/Interpreter.Tests/Issue2918InlineLambdaErasedReceiverEmittedOracleTests.cs).
        private const Source string = `
using System;

namespace Overloads
{
    public sealed class ClosedDelegateOverloads
    {
        public string Add(Predicate<int> callback) => "pred";

        public string Add(Func<int, bool> callback) => "func";
    }

    public sealed class ClosedConstructorOverloads
    {
        public ClosedConstructorOverloads(Predicate<int> callback)
        {
            Kind = "pred";
        }

        public ClosedConstructorOverloads(Func<int, bool> callback)
        {
            Kind = "func";
        }

        public string Kind;
    }

    public sealed class Issue2948MethodDelegateOverloads<T>
    {
        public string Add(Predicate<T> callback) => "pred";

        public string Add(Func<T, bool> callback) => "func";
    }

    public sealed class Issue2948ConstructorDelegateOverloads<T>
    {
        public Issue2948ConstructorDelegateOverloads(Predicate<T> callback)
        {
            Kind = "pred";
        }

        public Issue2948ConstructorDelegateOverloads(Func<T, bool> callback)
        {
            Kind = "func";
        }

        public string Kind;
    }

    public sealed class NonCollidingDelegates
    {
        public int Length(Func<string, int> length)
        {
            return length("x");
        }

        public void Sink(Action<string> sink)
        {
            sink("y");
        }

        public bool Test(Predicate<string> test)
        {
            return test("z");
        }

        public string Both(Predicate<string> test, Func<string, int> length)
        {
            return test("z").ToString() + length("x").ToString();
        }
    }

    public static class Program
    {
        public static bool Always(int value)
        {
            return true;
        }

        public static void Main()
        {
            var methods = new ClosedDelegateOverloads();
            Predicate<int> predicate = Always;
            Func<int, bool> function = Always;
            Console.WriteLine(methods.Add(predicate));
            Console.WriteLine(methods.Add(function));
            Console.WriteLine(new ClosedConstructorOverloads(predicate).Kind);
            Console.WriteLine(new ClosedConstructorOverloads(function).Kind);
        }
    }
}
`

        private func Render() string -> GSharpPrinter.Print(Translate(Source))

        private func Translate(source string) CompilationUnit {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Overloads.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            return CSharpToGSharpTranslator().TranslateDocument(document, context)
        }

        private func CompileAndRun(printed string)(ExitCode int32, Stdout string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3841-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            try {
                let gsPath = Path.Combine(workDir, "Program.gs")
                File.WriteAllText(gsPath, printed)
                let dllPath = Path.Combine(workDir, "Program.dll")
                let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
                Assert.True(
                    compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                    "gsc must compile the translated program with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
                )
                return RunDotnet("\"$dllPath\"")
            } finally {
                TryDelete(workDir)
            }
        }

        private func RunDotnet(arguments string)(ExitCode int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("failed to start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup; a locked file must not fail the test.

            } catch (UnauthorizedAccessException) {
                // Same.

            }
        }
    }
}
