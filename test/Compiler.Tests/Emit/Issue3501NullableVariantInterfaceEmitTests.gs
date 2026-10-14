// <copyright file="Issue3501NullableVariantInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #3501 (Translator burn-down): declaration-site variance must compose
/// with a nullable-annotated reference type argument on an IMPORTED generic
/// interface. Roslyn's `SymbolEqualityComparer : IEqualityComparer<ISymbol?>`
/// passed to `HashSet<IMethodSymbol>(IEqualityComparer<T>?)` is the
/// motivating shape; the BCL-only equivalent is
/// `IEqualityComparer[object?] → IEqualityComparer[string]`. Three gaps
/// conspired:
/// 1. `TryClassifyConstructedImportedReferenceConversion` gated variance slots on
/// `Binder.IsReferenceTypeForConstraint`, which deliberately rejects `T?` (correct for
/// `where T : class`, wrong for variance eligibility — the annotation has no runtime shape);
/// 2. the same classifier bailed for a NON-generic imported source class (no symbolic type arguments),
/// never consulting its CLR interface closure;
/// 3. the CLR-level overload-resolution applicability check only knew exact-argument interface matches
/// (`ImplementsInterfaceByName`) and array covariance, so constructor arguments failed GS0267; and the
/// emitter's `IsReferenceCompatible` neither unwrapped `NullabilityAnnotatedTypeSymbol` nor admitted
/// the non-generic source, throwing NotSupportedException after the binder accepted.
open class Issue3501NullableVariantInterfaceEmitTests {
    @Fact
    func ContravariantNullableArgument_ParameterAndConstructor_CompileAndRun() {
        let output = CompileAndRun((`package Probe
import System
import System.Collections.Generic

func check(c IEqualityComparer[string]) bool {
    return c.Equals("a", "a")
}

// Contravariance composed with a nullable reference argument:
// IEqualityComparer[object?] -> IEqualityComparer[string].
let comparer IEqualityComparer[object?] = EqualityComparer[object?].Default
Console.WriteLine(check(comparer))

// Same conversion at a BCL constructor slot (the parameter is the
// nullable-annotated ` + "`" + `IEqualityComparer[T]?` + "`" + `).
let set = HashSet[string](EqualityComparer[object?].Default)
set.Add("x")
set.Add("x")
Console.WriteLine(set.Count)`))
        Assert.Equal(string.Join(Environment.NewLine, "True", "1") + Environment.NewLine, output)
    }

    @Fact
    func WrongDirectionContravariance_StillDiagnoses() {
        // Guardrail: the CLR interface-closure projection must not over-accept.
        // StringComparer implements IEqualityComparer[string]; converting it to
        // the WIDER IEqualityComparer[object] would need object -> string on
        // the contravariant slot and must keep failing.
        let diagnostics = CompileExpectingFailure(`package Probe
import System
import System.Collections.Generic

let c IEqualityComparer[object] = StringComparer.Ordinal
Console.WriteLine(c.GetHashCode())`)
        // GS0156: an explicit reference downcast exists, but the implicit
        // variance conversion must not.
        Assert.Contains("GS0156", diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func ValueTypeArgument_StaysVarianceIneligible() {
        // Guardrail: a value-type slot never participates in reference
        // variance, nullable-annotated or not.
        let diagnostics = CompileExpectingFailure(`package Probe
import System
import System.Collections.Generic

let c IEqualityComparer[int32] = EqualityComparer[object?].Default
Console.WriteLine(c.GetHashCode())`)
        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal)
    }

    shared {
        private func CompileAndRun(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3501_variance_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = RunCompiler(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath},
                    out var diagnostics
                )
                Assert.True(exitCode == 0, diagnostics)
                IlVerifier.Verify(outputPath)
                return RunAssembly(directory, outputPath)
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func CompileExpectingFailure(source string) string {
            let directory = Directory.CreateTempSubdirectory("gs_issue3501_variance_neg_").FullName
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                let exitCode = RunCompiler(
                    []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath},
                    out var diagnostics
                )
                Assert.NotEqual(0, exitCode)
                return diagnostics
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(arguments[]string, out diagnostics string) int32 {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(arguments)
                diagnostics = (`stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
                return exitCode
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func RunAssembly(workingDirectory string, assemblyPath string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`dotnet exec exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
