// <copyright file="Issue3868SymbolicStaticContainerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Compiler.Tests.Fixtures
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #3868 — a static call on an imported generic type closed over a
/// SAME-COMPILATION user type (`Verifier[MyType].M(...)`) is parented at
/// the constructed `Verifier<MyType>` TypeSpec by the #1330 symbolic
/// path. That path declined `params`-expanded and defaulted-parameter call
/// shapes and fell through to the ordinary resolution, which emitted the
/// type-erased `Verifier<object>` parent (ADR-0004 / #313: a
/// same-compilation type has no CLR `Type` during binding, so it rides
/// through imported-member resolution as `object`).
///
/// The result compiled clean, failed ilverify with
/// `UnsatisfiedMethodParentInst` (11 of the 19 findings in the migrated
/// `test/Core.Tests`, issue #3863) and threw
/// `TypeLoadException: GenericArguments[0], 'System.Object' … violates the
/// constraint of type parameter` the first time the call ran. Every test
/// here EXECUTES the emitted program, because ilverify accepts a wrong parent
/// instantiation whenever the constraint happens to be satisfiable.
open class Issue3868SymbolicStaticContainerEmitTests {
    /// The regression: the `params` and defaulted shapes must reach the
    /// real `Issue3868Verifier<MyAnalyzer>`. Before the fix this
    /// aborted with `TypeLoadException` on the first variadic call.
    @Fact
    func EndToEnd_ParamsAndDefaultedStaticCalls_UseTheRealTypeArgument() {
        let source = `package N3868A
import System
import GSharp.Compiler.Tests.Fixtures

class MyAnalyzer3868 : Issue3868Base {
    override func Name() string {
        return "mine"
    }
}

func Main() {
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s"))
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s", "A"))
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Variadic("s", "A", "B"))
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868].Defaulted("s"))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "variadic:mine:s:0",
                "variadic:mine:s:1",
                "variadic:mine:s:2",
                "defaulted:mine:s:d"
            ) +
                Environment.NewLine,
            output
        )
    }

    /// Anti-vacuity guard: the fixed-arity and fully-supplied shapes were
    /// ALREADY correct on `origin/main` (they take the #1330 symbolic
    /// path). They must stay correct — a fix that changed how the symbolic
    /// container is chosen would show up here.
    @Fact
    func EndToEnd_FixedAndFullySuppliedStaticCalls_StayCorrect() {
        let source = `package N3868B
import System
import GSharp.Compiler.Tests.Fixtures

class MyAnalyzer3868B : Issue3868Base {
    override func Name() string {
        return "mineB"
    }
}

func Main() {
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868B].Fixed("s"))
    Console.WriteLine(Issue3868Verifier[MyAnalyzer3868B].Defaulted("s", "t"))
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            string.Join(Environment.NewLine, "fixed:mineB:s", "defaulted:mineB:s:t") + Environment.NewLine,
            output
        )
    }

    shared {
        private let FixtureAssemblyPath string = typeof(Issue3868Base).Assembly.Location

        /// Compiles [`source`](paramref) against the host reference closure
        /// plus this test assembly (which hosts the fixture), emits into the test
        /// output directory so the fixture assembly resolves by ordinary app-dir
        /// probing, ILVerifies, then RUNS the program and returns its stdout.
        /// @param source G# source to compile.
        /// @returns The program's stdout.
        private func CompileAndRun(source string) string {
            let outputDir = Path.GetDirectoryName(FixtureAssemblyPath) ??
                throw InvalidOperationException("fixture assembly has no directory")
            let stem = "gs3868_" + Guid.NewGuid().ToString("N")
            let srcPath = Path.Combine(Path.GetTempPath(), stem + ".gs")
            let dllPath = Path.Combine(outputDir, stem + ".dll")
            let rtConfig = Path.Combine(outputDir, stem + ".runtimeconfig.json")
            try {
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", "/nowarn:GS9100"}
                for reference in ReferenceAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add(srcPath)
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath, []string{FixtureAssemblyPath})
                File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = outputDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(60_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                for path in[]string{srcPath, dllPath, rtConfig, Path.ChangeExtension(dllPath, ".pdb")} {
                    try {
                        File.Delete(path)
                    } catch (IOException) {
                        // Best-effort cleanup; a locked artifact must not fail the test.

                    } catch (UnauthorizedAccessException) {
                        // Best-effort cleanup.

                    }
                }
            }
        }

        private func ReferenceAssemblies() IEnumerable[string] -> ReferenceClosure
            .TrustedPlatformAssemblies()
            .Append(FixtureAssemblyPath)
            .Distinct(StringComparer.Ordinal)
    }
}
