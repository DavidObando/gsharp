// <copyright file="Issue1354InstanceMethodReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #1354 follow-up: imported INSTANCE method-call return types must honor
/// the reference-type nullability rule (oblivious/unannotated → `T?`,
/// explicit `[Nullable(1)]` → non-null) via
/// (cref:GSharp.Core.CodeAnalysis.Symbols.ClrNullability).
///
/// Before the follow-up fix, the non-generic instance-method fallback chain in
/// `ExpressionBinder.Calls` landed on a bare
/// `TypeSymbol.FromClrType(method.ReturnType)` that ignored nullability, so
/// an oblivious/annotated-nullable instance return was treated as NON-null and a
/// `... == nil` comparison was rejected with `GS0129`.
///
/// These tests build a G# library (whose emitter stamps complete nullability
/// metadata — a type-level `[NullableContext(1)]` plus per-member
/// `[Nullable]`), then compile a consumer that imports it and compares an
/// instance method's result to `nil`. The annotated-nullable return must
/// re-import as nullable (compare-to-nil compiles); the annotated-non-null
/// return must stay non-null (compare-to-nil is `GS0129`). The genuine
/// "oblivious external assembly" case (no nullability metadata at all) is
/// covered by the manual repro in the PR (gsc cannot emit an oblivious member).
open class Issue1354InstanceMethodReturnEmitTests {
    @Fact
    func AnnotatedNullableInstanceReturn_ComparesToNil_Compiles() {
        // `MakeMaybe` returns `Widget?` → re-imported as nullable → `== nil` is
        // allowed. Before the fix this fallback ignored the [Nullable(2)]
        // annotation and reported GS0129.
        let consumer = `package App
import Lib

class C {
    func F(f Factory) bool {
        return f.MakeMaybe() == nil
    }
}`
        let (exit, stdout, stderr) = CompileConsumerAgainstLibrary(consumer)
        Assert.True(exit == 0, (`expected compile success but failed (exit ` + "$exit" + `).
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
    }

    @Fact
    func AnnotatedNonNullInstanceReturn_ComparesToNil_IsRejected() {
        // `MakeNonNull` returns a non-null `Widget` (the emitter stamps
        // [NullableContext(1)]) → re-imported as non-null → `== nil` is a
        // never-null comparison and must be rejected with GS0129.
        let consumer = `package App
import Lib

class C {
    func F(f Factory) bool {
        return f.MakeNonNull() == nil
    }
}`
        let (exit, stdout, stderr) = CompileConsumerAgainstLibrary(consumer)
        Assert.True(exit != 0, (`expected compile failure but succeeded.
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
        Assert.Contains("GS0129", stdout + stderr)
    }

    shared {
        private const LibrarySource string = `package Lib

class Widget {
}

class Factory {
    func MakeNonNull() Widget {
        return Widget()
    }

    func MakeMaybe() Widget? {
        return nil
    }
}`

        private func CompileConsumerAgainstLibrary(consumerSource string)(Exit int32, Stdout string, Stderr string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_1354_inst_").FullName
            try {
                let libSrc = Path.Combine(tempDir, "lib.gs")
                let libDll = Path.Combine(tempDir, "Lib.dll")
                File.WriteAllText(libSrc, LibrarySource)
                let libArgs = List[string]{"/out:" + libDll, "/target:library", "/targetframework:net10.0", libSrc}
                let (libExit, libOut, libErr) = RunCompiler(libArgs.ToArray())
                Assert.True(libExit == 0, (`library compile failed:
stdout:
` + "$libOut" + `
stderr:
` + "$libErr"))
                IlVerifier.Verify(libDll)
                let consumerSrc = Path.Combine(tempDir, "consumer.gs")
                let consumerDll = Path.Combine(tempDir, "consumer.dll")
                File.WriteAllText(consumerSrc, consumerSource)
                let args = List[string]{"/out:" + consumerDll, "/target:library", "/targetframework:net10.0"}
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/reference:" + libDll)
                args.Add("/nowarn:GS9100")
                args.Add(consumerSrc)
                return RunCompiler(args.ToArray())
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func RunCompiler(args[]string)(Exit int32, Stdout string, Stderr string) {
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return (compileExit, stdoutWriter.ToString(), stderrWriter.ToString())
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
