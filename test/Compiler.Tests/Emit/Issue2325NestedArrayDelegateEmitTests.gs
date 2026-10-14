// <copyright file="Issue2325NestedArrayDelegateEmitTests.cs" company="GSharp">
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

/// Issue #2325 follow-up: an array-typed delegate parameter (G# slice syntax
/// `[]int32`, whose CLR shape is the SZArray `System.Int32[]` —
/// see `SliceTypeSymbol`/`ArrayTypeSymbol`, both of which build
/// their CLR type via `elementType.ClrType.MakeArrayType()` over the
/// element's *host-runtime* (cref:Type)) is subject to the exact same
/// cross-context mismatch as the nested-delegate case covered by
/// `Issue2325NestedDelegateEmitTests`: an array built over an unmapped
/// host-context element still carries the host identity, so combining it
/// with a reference-context (MetadataLoadContext) open generic definition
/// via `MakeGenericType` throws GS9998 the same way an unmapped
/// constructed-generic delegate argument did.
///
/// These tests drive gsc through explicit `/reference:` flags pointing
/// at the `Microsoft.NETCore.App.Ref` targeting-pack facades (the same
/// reference-assembly closure the .NET SDK and cs2gs supply), so the
/// MetadataLoadContext code path that reproduces the bug is actually
/// exercised. Each test compiles, ILVerifies, and runs the emitted assembly
/// end-to-end.
open class Issue2325NestedArrayDelegateEmitTests {
    @Fact
    func ArrayDelegateArgument_ActionShape_CompilesRunsAndIlVerifies() {
        // The delegate parameter `f`'s function type `([]int32, object?) -> void`
        // materialises as `Action<int32[], object>` — an array argument
        // alongside another argument in the same constructed generic, the
        // shape the array-remapping branch of MapToReferenceClrType exists
        // for. `PrintFirstAndTag` is a plain top-level function (rather than
        // a lambda) so the multi-statement void body needs no special lambda
        // block syntax; converting it to `f`'s function type still routes
        // through the same ResolveDelegateClrType/ResolveDelegateArgClrType
        // path a lambda literal would.
        let gsource = `package Repro
import System

func Apply(f ([]int32, object?) -> void, arr []int32, extra object?) {
    f(arr, extra)
}

func PrintFirstAndTag(values []int32, tag object?) {
    Console.WriteLine(values[0])
    Console.WriteLine(tag)
}

Apply(PrintFirstAndTag, []int32{7, 8, 9}, "tag")`
        Assert.Equal("7${Environment.NewLine}tag${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func ArrayDelegateArgument_DoubleNested_CompilesRunsAndIlVerifies() {
        // A doubly-nested variant matching the shape of the issue's minimal
        // Action<Action<object>, object> repro, but with the inner
        // delegate's own argument being the array: the outer delegate's
        // first parameter is itself a `([]int32, object?) -> void` function
        // type, i.e. `Action<Action<int32[], object>, object>`.
        let gsource = `package Repro
import System

func Invoke2(cb (([]int32, object?) -> void, object?) -> void) {
    cb(PrintFirstAndExtra, "outer")
}

func PrintFirstAndExtra(values []int32, extra object?) {
    Console.WriteLine(values[0])
    Console.WriteLine(extra)
}

Invoke2((inner ([]int32, object?) -> void, arg object?) -> inner([]int32{1, 2, 3}, arg))`
        Assert.Equal("1${Environment.NewLine}outer${Environment.NewLine}", CompileAndRun(gsource))
    }

    @Fact
    func ArrayReturningNestedFunc_CompilesRunsAndIlVerifies() {
        // A Func-shaped (returning) variant: the outer delegate's first
        // parameter is a value-returning `(int32) -> []int32` function type,
        // i.e. Func<Func<int32,int32[]>, int32, int32[]>.
        let gsource = `package Repro
import System

func Invoke2(cb ((int32) -> []int32, int32) -> []int32) []int32 {
    return cb(MakePair, 41)
}

func MakePair(n int32) []int32 {
    return []int32{n, n + 1}
}

let result = Invoke2((inner (int32) -> []int32, arg int32) -> inner(arg))
Console.WriteLine(result[0])
Console.WriteLine(result[1])`
        Assert.Equal("41${Environment.NewLine}42${Environment.NewLine}", CompileAndRun(gsource))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2325_array_").FullName
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
