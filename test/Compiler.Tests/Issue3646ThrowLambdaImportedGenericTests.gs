// <copyright file="Issue3646ThrowLambdaImportedGenericTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit
import Xunit.Sdk

/// Regression tests for issue #3646: a throw-expression lambda passed to an
/// imported generic method taking a delegate parameter (e.g. Roslyn's
/// `IncrementalGeneratorInitializationContext.RegisterSourceOutput(provider,
/// action)`, or the BCL's `Array.ForEach(array, action)`) failed with
/// GS0159 "Cannot find function". The lambda's natural function type returns
/// the bottom (`never`) type, which has no CLR erasure, so the erased
/// delegate CLR shape used to gate imported-overload applicability could not
/// be built and every candidate was rejected before overload resolution ran.
/// The fix erases a `never` return like `void` (issue #2716 already
/// lets a never-returning literal convert to any delegate result slot).
open class Issue3646ThrowLambdaImportedGenericTests {
    @Fact
    func ThrowLambda_ToImportedGenericMethodActionParameter_Compiles() {
        // Array.ForEach<T>(T[], Action<T>) — T inferred from the array
        // argument, the throw-expression lambda flows into Action<T>.
        CompileGsAgainstTpa(`package Probe

import System

func main() {
    var xs = []int32{1, 2, 3}
    Array.ForEach(xs, (v int32) -> throw InvalidOperationException("boom"))
}`)
    }

    @Fact
    func ThrowLambda_ToRoslynRegisterSourceOutput_Compiles() {
        // The exact shape from the migrated GeneratorHost tests: a generic
        // instance method on the imported STRUCT
        // IncrementalGeneratorInitializationContext, whose T flows from the
        // IncrementalValueProvider<Compilation> argument into the
        // Action<SourceProductionContext, T> delegate parameter, with a
        // throw-expression lambda as the action.
        CompileGsAgainstTpa(`package Probe

import System
import Microsoft.CodeAnalysis

public class ThrowingGenerator : IIncrementalGenerator {
    public func Initialize(context IncrementalGeneratorInitializationContext) {
        context.RegisterSourceOutput(
            context.CompilationProvider,
            (spc SourceProductionContext, _ Compilation) -> throw InvalidOperationException("boom"))
    }
}`, requiredAssemblySimpleName: "Microsoft.CodeAnalysis")
    }

    shared {
        /// Drives gsc in-process against the host's trusted-platform-assembly
        /// closure (which includes the test project's Microsoft.CodeAnalysis
        /// package assemblies), asserting a clean compile. Mirrors
        /// (cref:XunitAssertOverloadResolutionTests)' compile helper.
        /// @param source G# source to compile.
        /// @param requiredAssemblySimpleName Optional assembly simple name that must be present in the
        /// reference
        /// closure; when absent the test surfaces a missing-prerequisite failure
        /// instead of a misleading compile error.
        private func CompileGsAgainstTpa(source string, requiredAssemblySimpleName string? = nil) {
            let references = TrustedPlatformAssemblies().ToList()
            if requiredAssemblySimpleName != nil && !references.Any(
                (p string) -> string.Equals(
                    Path.GetFileNameWithoutExtension(p),
                    requiredAssemblySimpleName,
                    StringComparison.OrdinalIgnoreCase
                )
            ) {
                throw XunitException("prerequisite missing: '$requiredAssemblySimpleName' not present in the host TPA")
            }
            let tempDir = Directory.CreateTempSubdirectory("gs_issue3646_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "Probe.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Probe.dll")
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100"
                }
                for reference in references {
                    args.Add("/reference:" + reference)
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
                Assert.True(compileExit == 0, (`gsc failed (exit ` + "$compileExit" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                Assert.True(File.Exists(outPath), "expected emitted assembly")
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch {
                    // Best-effort cleanup only.

                }
            }
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
