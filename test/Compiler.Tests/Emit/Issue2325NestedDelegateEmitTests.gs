// <copyright file="Issue2325NestedDelegateEmitTests.cs" company="GSharp">
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

/// Issue #2325: compiling with explicit `/reference:` assemblies (the
/// same MetadataLoadContext-backed mode cs2gs drives gsc with) previously
/// threw `GS9998 ArgumentException: This type '...' was not loaded by the
/// MetadataLoadContext that loaded the generic type or method` whenever a
/// function/delegate type was nested inside another delegate signature —
/// e.g. `Action<Action<object>, object>`.
///
/// Root cause: `ReflectionMetadataEmitter.ResolveDelegateClrType`
/// resolves the outer open generic delegate through the active reference
/// (MetadataLoadContext) context, but the per-argument helper
/// (`ResolveDelegateArgClrType`) called `MapToReferenceClrType`,
/// which only performed a flat `Type.FullName` lookup. A *constructed*
/// generic argument's `FullName` embeds each nested argument's
/// assembly-qualified name (e.g.
/// `"System.Action`1[[System.Object, System.Private.CoreLib, ...]]"`),
/// which never matches the reference index (built from open generic
/// *definitions* only), so the lookup silently fell back to the host-context
/// (cref:Type). `MakeGenericType` then combined a
/// MetadataLoadContext open definition with a host-context type argument —
/// exactly the mismatch `MakeGenericType` rejects at runtime.
/// `ResolveTargetDelegateClrType` already contained the correct
/// recursive constructed-generic remapping logic (for a delegate type
/// obtained by reflecting over a host CLR method), so the two code paths had
/// diverged. The fix makes `MapToReferenceClrType` itself the single
/// recursive reference-context remapper — resolving a constructed generic's
/// open definition in the active reference context and recursing into every
/// type argument through the same helper — so both
/// `ResolveDelegateArgClrType` and `ResolveTargetDelegateClrType`
/// share one implementation instead of maintaining divergent copies.
///
/// These tests drive gsc through explicit `/reference:` flags pointing
/// at the `Microsoft.NETCore.App.Ref` targeting-pack facades — the same
/// reference-assembly closure the .NET SDK (and cs2gs) supplies — so the
/// MetadataLoadContext code path that reproduces GS9998 is actually
/// exercised (the TPA-backed default resolver shares the host's runtime
/// identity and would mask the bug). Each test compiles, ILVerifies, and
/// runs the emitted assembly end-to-end.
open class Issue2325NestedDelegateEmitTests {
    @Fact
    func NestedAction_MinimalReproFromIssue_CompilesRunsAndIlVerifies() {
        // Exact minimal repro from the issue: an outer two-parameter Action
        // whose first parameter is itself an `(object?) -> void` function
        // type — i.e. Action<Action<object>, object> once both levels are
        // materialised as CLR delegates.
        let gsource = `package Repro
import System

func Invoke2(cb ((object?) -> void, object?) -> void) {
    cb((o object?) -> Console.WriteLine(o), nil)
}

Invoke2((inner (object?) -> void, arg object?) -> inner(arg))`
        Assert.Equal(Environment.NewLine, CompileAndRun(gsource))
    }

    @Fact
    func NestedFunc_ReturningVariant_CompilesRunsAndIlVerifies() {
        // A nested Func-shaped (returning) variant of the same bug: the
        // outer delegate's first parameter is itself a value-returning
        // `(int32) -> int32` function type, i.e.
        // Func<Func<int32,int32>, int32, int32>.
        let gsource = `package Repro
import System

func Invoke2(cb ((int32) -> int32, int32) -> int32) int32 {
    return cb((x int32) -> x + 1, 41)
}

Console.WriteLine(Invoke2((inner (int32) -> int32, arg int32) -> inner(arg)))`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func OahuSendOrPostCallbackShape_CompilesRunsAndIlVerifies() {
        // Structurally mirrors the real Oahu occurrence:
        // ExtensionsSyncContext.SendOrPost(Action<SendOrPostCallback, object> sendOrPost, Action delgat).
        // G# has no named-delegate type distinct from a structural function
        // type, so a CLR `SendOrPostCallback` parameter (Invoke shape
        // `void Invoke(object state)`) translates to the nested function
        // type `(object?) -> void` — exactly reproducing the two-parameter,
        // nested-first-argument shape that triggered GS9998.
        let gsource = `package Repro
import System

func SendOrPost(sendOrPost ((object?) -> void, object?) -> void, delgat () -> void) {
    sendOrPost((state object?) -> Console.WriteLine(state), "hello")
    delgat()
}

SendOrPost((callback (object?) -> void, state object?) -> callback(state), () -> Console.WriteLine("done"))`
        Assert.Equal("hello${Environment.NewLine}done${Environment.NewLine}", CompileAndRun(gsource))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2325_").FullName
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
