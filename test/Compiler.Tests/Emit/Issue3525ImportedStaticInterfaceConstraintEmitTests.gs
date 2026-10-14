// <copyright file="Issue3525ImportedStaticInterfaceConstraintEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit
import Xunit.Sdk

/// Issue #3525 end-to-end coverage: static constrained dispatch (ADR-0089)
/// recognized static-virtual members declared by a G# source interface
/// constraint but not by an imported CLR interface constraint — e.g.
/// `T.TryParse(...)` with `T : System.IParsable[T]` reported
/// GS0333 even though `IParsable[T].TryParse` is a static-abstract
/// interface member. `BindTypeParameterStaticAccessorStep` only ever
/// inspected `TypeParameterSymbol.InterfaceConstraint` (the source-G#
/// shape) and never `ClrInterfaceConstraint` (the imported-CLR shape).
/// These tests round-trip the repro through compile → IL-verify → run.
///
/// Compiles against the full trusted-platform-assembly set explicitly:
/// `IParsable[T]` is a solitary-arity generic interface (unlike
/// `IComparable`/`IEquatable`, which also have a non-generic
/// sibling), and gsc's bare default reference resolution (no explicit
/// `/reference:`) does not pull in the assembly that defines it — an
/// unrelated pre-existing resolution gap, not part of this issue.
open class Issue3525ImportedStaticInterfaceConstraintEmitTests {
    @Fact
    func TryParse_ThroughImportedIParsableConstraint_Roundtrips_Int32() {
        let source = `package P
import System

func ParseOrDefault[T IParsable[T]](text string) T {
    var value T
    T.TryParse(text, nil, &value)
    return value
}

Console.WriteLine(ParseOrDefault[int32]("42"))
Console.WriteLine(ParseOrDefault[int32]("not-a-number"))`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.ParseOrDefault$$")
        Assert.Equal("42${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func TryParse_ThroughImportedIParsableConstraint_ReturnsSuccessFlag() {
        let source = `package P
import System

func TryParseFlag[T IParsable[T]](text string) bool {
    var value T
    return T.TryParse(text, nil, &value)
}

Console.WriteLine(TryParseFlag[int32]("42"))
Console.WriteLine(TryParseFlag[int32]("nope"))`
        let output = CompileAndRun(source, ignoredErrorScope: "<Program>\\.TryParseFlag$$")
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func NonExistentStaticMember_OnImportedInterfaceConstraint_IsBindingError() {
        let source = `package P
import System

func Bad[T IParsable[T]](text string) T {
    var value T
    T.NotAMember(text, nil, &value)
    return value
}

var z = Bad[int32]("42")`
        let diagnostics = CompileExpectingFailure(source)
        Assert.Contains("GS0333", diagnostics)
    }

    shared {
        private let BclReferences Lazy[IReadOnlyList[string]] = Lazy[IReadOnlyList[string]](
            func () IReadOnlyList[string] {
                return TrustedPlatformAssemblies().ToArray()
            }
        )

        private func CompileAndRun(source string, ignoredErrorScope string? = nil) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3525_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(BuildCompilerArgs(outPath, srcPath))
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                // ADR-0089 / issue #755: constrained-static-virtual dispatch (the
                // `constrained. !!T call` shape this issue's CLR-interface path
                // reuses) trips a pre-C#-11 dotnet-ilverify rule set — a known,
                // pre-existing gap (see IlVerifier.KnownIssues.StaticVirtualInterface),
                // not something this fix introduces.
                IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: if ignoredErrorScope == nil {
                        default([]?string)
                    } else {
                        IlVerifier.KnownIssues.StaticVirtualInterface
                    },
                    ignoredErrorScope: ignoredErrorScope
                )
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore.

                }
            }
        }

        private func CompileExpectingFailure(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3525_err_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(BuildCompilerArgs(outPath, srcPath))
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                let combined = compileOut.ToString() + compileErr.ToString()
                Assert.True(compileExit != 0, "expected compile to fail but it succeeded: $combined")
                return combined
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup; ignore.

                }
            }
        }

        private func BuildCompilerArgs(outPath string, srcPath string)[]string {
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            args.AddRange(BclReferences.Value.Select((reference string) -> ("/reference:" + reference)))
            args.Add(srcPath)
            return args.ToArray()
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let value string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(value) {
                Enumerable.Empty[string]()
            } else {
                cast[IEnumerable[string]](value!!.Split(Path.PathSeparator))
            }
        }
    }
}
