// <copyright file="Issue2327EnumReflectionSafetyEmitTests.cs" company="GSharp">
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

/// Issue #2327: comparing a nullable structural function type to `nil`
/// (`==` / `!=`) unconditionally routes through
/// `MethodBodyEmitter.IsUnsignedOrChar`, which asks
/// `EnumOperatorTable.IsUnsignedEnumUnderlying` whether the operand's CLR
/// type is an enum. Under explicit `/reference:` (MetadataLoadContext)
/// compilation, a compiler-synthesized structural delegate type closed over
/// an imported BCL parameter type is a
/// (cref:System.Reflection.Emit.TypeBuilderInstantiation), whose
/// `Type.IsEnum` throws (cref:NotSupportedException) via the
/// unsupported `IsSubclassOf` path. These tests drive gsc through the
/// same explicit reference-pack closure the .NET SDK (and cs2gs) supply —
/// see `Issue2325NestedArrayDelegateEmitTests.RefPackReferences` for the
/// precedent — so the MetadataLoadContext path that reproduces GS9998 is
/// actually exercised, then ILVerify and run each emitted assembly end-to-end
/// for both `==` and `!=`.
open class Issue2327EnumReflectionSafetyEmitTests {
    @Theory
    @InlineData("Guid", "(g Guid) -> {}")
    @InlineData("TimeSpan", "(t TimeSpan) -> {}")
    @InlineData("Uri", "(u Uri) -> {}")
    @InlineData("Exception", "(e Exception) -> {}")
    @InlineData("EventArgs", "(e EventArgs) -> {}")
    @InlineData("ConsoleCancelEventArgs", "(e ConsoleCancelEventArgs) -> {}")
    func NullableFunctionType_OverImportedBclParameter_NilComparisons_CompileRunAndIlVerify(
        paramTypeName string,
        handlerLambda string
    ) {
        let source = (`package Repro
import System

func IsNil(h ((` + "$paramTypeName" + `) -> void)?) bool -> h == nil
func IsNotNil(h ((` + "$paramTypeName" + `) -> void)?) bool -> h != nil

func Main() {
    Console.WriteLine(IsNil(nil))
    Console.WriteLine(IsNotNil(nil))
    Console.WriteLine(IsNil(` + "$handlerLambda" + `))
    Console.WriteLine(IsNotNil(` + "$handlerLambda" + `))
}`)
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Exact Oahu shape: `ProcessHost.RunProcess` compares a nullable
    /// `DataReceivedEventHandler` to `nil` after cs2gs structurally
    /// translates the C# delegate type to
    /// `((object, DataReceivedEventArgs) -> void)?`.
    @Fact
    func NullableFunctionType_ProcessHostDataReceivedEventHandlerShape_NilComparisons_CompileRunAndIlVerify() {
        let source = `package Repro
import System
import System.Diagnostics

func IsNil(h ((object, DataReceivedEventArgs) -> void)?) bool -> h == nil
func IsNotNil(h ((object, DataReceivedEventArgs) -> void)?) bool -> h != nil

func Main() {
    Console.WriteLine(IsNil(nil))
    Console.WriteLine(IsNotNil(nil))
    Console.WriteLine(IsNil((s object, e DataReceivedEventArgs) -> {}))
    Console.WriteLine(IsNotNil((s object, e DataReceivedEventArgs) -> {}))
}`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Primitive-alias control: per the issue, primitive aliases never
    /// reproduce the crash (their CLR backing is a plain BCL struct, never a
    /// TypeBuilderInstantiation). Confirms the fix does not regress the
    /// already-working case.
    @Fact
    func NullableFunctionType_OverPrimitiveParameter_NilComparisons_CompileRunAndIlVerify() {
        let source = `package Repro
import System

func IsNil(h ((int32) -> void)?) bool -> h == nil
func IsNotNil(h ((int32) -> void)?) bool -> h != nil

func Main() {
    Console.WriteLine(IsNil(nil))
    Console.WriteLine(IsNotNil(nil))
    Console.WriteLine(IsNil((n int32) -> {}))
    Console.WriteLine(IsNotNil((n int32) -> {}))
}`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    /// Same-compilation user-type control: per the issue, a same-compilation
    /// class parameter never reproduces the crash either. The class itself is
    /// a TypeBuilder while being defined, but by the time the structural
    /// delegate closes over it the type is complete, so this exercises the
    /// non-crashing sibling shape alongside the imported-BCL-parameter cases
    /// above.
    @Fact
    func NullableFunctionType_OverSameCompilationUserType_NilComparisons_CompileRunAndIlVerify() {
        let source = `package Repro
import System

class Widget {}

func IsNil(h ((Widget) -> void)?) bool -> h == nil
func IsNotNil(h ((Widget) -> void)?) bool -> h != nil

func Main() {
    Console.WriteLine(IsNil(nil))
    Console.WriteLine(IsNotNil(nil))
    Console.WriteLine(IsNil((w Widget) -> {}))
    Console.WriteLine(IsNotNil((w Widget) -> {}))
}`
        Assert.Equal(
            "True${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2327_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                for reference in RefPackReferences() {
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
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        /// Assembles the same reference closure the .NET SDK (and cs2gs) would
        /// pass to gsc via explicit `/reference:` flags — the
        /// `Microsoft.NETCore.App.Ref` targeting-pack facades for the
        /// running runtime. Loading these through gsc's isolated
        /// MetadataLoadContext (rather than the host's trusted-platform
        /// assemblies) is what actually exercises the GS9998 cross-context
        /// mismatch this issue is about — the TPA-backed default resolver shares
        /// the host runtime's own `System.Private.CoreLib` identity and
        /// would mask the bug. Throws (via (cref:Xunit.Sdk.XunitException))
        /// rather than silently skipping when the ref-pack is absent, so a CI
        /// environment missing the ref-pack surfaces a clear diagnostic instead
        /// of a false pass.
        private func RefPackReferences() IEnumerable[string] {
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            if string.IsNullOrEmpty(runtimeDir) {
                throw XunitException("host runtime directory not resolvable")
            }
            let sharedDir DirectoryInfo? = Directory.GetParent(runtimeDir)?.Parent
            let dotnetRoot string? = sharedDir?.Parent?.FullName
            if string.IsNullOrEmpty(dotnetRoot) {
                throw XunitException("dotnet root not resolvable")
            }
            let tfm = "net${Environment.Version.Major}.0"
            let packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref")
            if !Directory.Exists(packsRoot) {
                throw XunitException("ref pack root '$packsRoot' missing")
            }
            let version = Environment.Version.ToString(3)
            var refDir string? = Path.Combine(packsRoot, version, "ref", tfm)
            if !Directory.Exists(refDir) {
                let major = Environment.Version.Major.ToString()
                let candidate string? = Directory
                    .EnumerateDirectories(packsRoot, major + ".*")
                    .OrderByDescending((d string) -> d, StringComparer.Ordinal)
                    .Select((d string) -> Path.Combine(d, "ref", tfm))
                    .FirstOrDefault(Directory.Exists)
                if string.IsNullOrEmpty(candidate) {
                    throw XunitException("no ref pack for net$major.0 under '$packsRoot'")
                }
                refDir = candidate
            }
            return Directory.EnumerateFiles(refDir, "*.dll").ToArray()
        }
    }
}
