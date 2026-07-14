// <copyright file="Issue2327EnumReflectionSafetyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2327: comparing a nullable structural function type to <c>nil</c>
/// (<c>==</c> / <c>!=</c>) unconditionally routes through
/// <c>MethodBodyEmitter.IsUnsignedOrChar</c>, which asks
/// <c>EnumOperatorTable.IsUnsignedEnumUnderlying</c> whether the operand's CLR
/// type is an enum. Under explicit <c>/reference:</c> (MetadataLoadContext)
/// compilation, a compiler-synthesized structural delegate type closed over
/// an imported BCL parameter type is a
/// <see cref="System.Reflection.Emit.TypeBuilderInstantiation"/>, whose
/// <c>Type.IsEnum</c> throws <see cref="NotSupportedException"/> via the
/// unsupported <c>IsSubclassOf</c> path. These tests drive gsc through the
/// same explicit reference-pack closure the .NET SDK (and cs2gs) supply —
/// see <c>Issue2325NestedArrayDelegateEmitTests.RefPackReferences</c> for the
/// precedent — so the MetadataLoadContext path that reproduces GS9998 is
/// actually exercised, then ILVerify and run each emitted assembly end-to-end
/// for both <c>==</c> and <c>!=</c>.
/// </summary>
public class Issue2327EnumReflectionSafetyEmitTests
{
    [Theory]
    [InlineData("Guid", "(g Guid) -> {}")]
    [InlineData("TimeSpan", "(t TimeSpan) -> {}")]
    [InlineData("Uri", "(u Uri) -> {}")]
    [InlineData("Exception", "(e Exception) -> {}")]
    [InlineData("EventArgs", "(e EventArgs) -> {}")]
    [InlineData("ConsoleCancelEventArgs", "(e ConsoleCancelEventArgs) -> {}")]
    public void NullableFunctionType_OverImportedBclParameter_NilComparisons_CompileRunAndIlVerify(
        string paramTypeName, string handlerLambda)
    {
        var source = $$"""
            package Repro
            import System

            func IsNil(h (({{paramTypeName}}) -> void)?) bool -> h == nil
            func IsNotNil(h (({{paramTypeName}}) -> void)?) bool -> h != nil

            func Main() {
                Console.WriteLine(IsNil(nil))
                Console.WriteLine(IsNotNil(nil))
                Console.WriteLine(IsNil({{handlerLambda}}))
                Console.WriteLine(IsNotNil({{handlerLambda}}))
            }
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\n", CompileAndRun(source));
    }

    /// <summary>
    /// Exact Oahu shape: <c>ProcessHost.RunProcess</c> compares a nullable
    /// <c>DataReceivedEventHandler</c> to <c>nil</c> after cs2gs structurally
    /// translates the C# delegate type to
    /// <c>((object, DataReceivedEventArgs) -&gt; void)?</c>.
    /// </summary>
    [Fact]
    public void NullableFunctionType_ProcessHostDataReceivedEventHandlerShape_NilComparisons_CompileRunAndIlVerify()
    {
        var source = """
            package Repro
            import System
            import System.Diagnostics

            func IsNil(h ((object, DataReceivedEventArgs) -> void)?) bool -> h == nil
            func IsNotNil(h ((object, DataReceivedEventArgs) -> void)?) bool -> h != nil

            func Main() {
                Console.WriteLine(IsNil(nil))
                Console.WriteLine(IsNotNil(nil))
                Console.WriteLine(IsNil((s object, e DataReceivedEventArgs) -> {}))
                Console.WriteLine(IsNotNil((s object, e DataReceivedEventArgs) -> {}))
            }
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\n", CompileAndRun(source));
    }

    /// <summary>
    /// Primitive-alias control: per the issue, primitive aliases never
    /// reproduce the crash (their CLR backing is a plain BCL struct, never a
    /// TypeBuilderInstantiation). Confirms the fix does not regress the
    /// already-working case.
    /// </summary>
    [Fact]
    public void NullableFunctionType_OverPrimitiveParameter_NilComparisons_CompileRunAndIlVerify()
    {
        var source = """
            package Repro
            import System

            func IsNil(h ((int32) -> void)?) bool -> h == nil
            func IsNotNil(h ((int32) -> void)?) bool -> h != nil

            func Main() {
                Console.WriteLine(IsNil(nil))
                Console.WriteLine(IsNotNil(nil))
                Console.WriteLine(IsNil((n int32) -> {}))
                Console.WriteLine(IsNotNil((n int32) -> {}))
            }
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\n", CompileAndRun(source));
    }

    /// <summary>
    /// Same-compilation user-type control: per the issue, a same-compilation
    /// class parameter never reproduces the crash either. The class itself is
    /// a TypeBuilder while being defined, but by the time the structural
    /// delegate closes over it the type is complete, so this exercises the
    /// non-crashing sibling shape alongside the imported-BCL-parameter cases
    /// above.
    /// </summary>
    [Fact]
    public void NullableFunctionType_OverSameCompilationUserType_NilComparisons_CompileRunAndIlVerify()
    {
        var source = """
            package Repro
            import System

            class Widget {}

            func IsNil(h ((Widget) -> void)?) bool -> h == nil
            func IsNotNil(h ((Widget) -> void)?) bool -> h != nil

            func Main() {
                Console.WriteLine(IsNil(nil))
                Console.WriteLine(IsNotNil(nil))
                Console.WriteLine(IsNil((w Widget) -> {}))
                Console.WriteLine(IsNotNil((w Widget) -> {}))
            }
            """;

        Assert.Equal("True\nFalse\nFalse\nTrue\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2327_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            foreach (var reference in RefPackReferences())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Assembles the same reference closure the .NET SDK (and cs2gs) would
    /// pass to gsc via explicit <c>/reference:</c> flags — the
    /// <c>Microsoft.NETCore.App.Ref</c> targeting-pack facades for the
    /// running runtime. Loading these through gsc's isolated
    /// MetadataLoadContext (rather than the host's trusted-platform
    /// assemblies) is what actually exercises the GS9998 cross-context
    /// mismatch this issue is about — the TPA-backed default resolver shares
    /// the host runtime's own <c>System.Private.CoreLib</c> identity and
    /// would mask the bug. Throws (via <see cref="Xunit.Sdk.XunitException"/>)
    /// rather than silently skipping when the ref-pack is absent, so a CI
    /// environment missing the ref-pack surfaces a clear diagnostic instead
    /// of a false pass.
    /// </summary>
    private static IEnumerable<string> RefPackReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir))
        {
            throw new Xunit.Sdk.XunitException("host runtime directory not resolvable");
        }

        var sharedDir = Directory.GetParent(runtimeDir)?.Parent;
        var dotnetRoot = sharedDir?.Parent?.FullName;
        if (string.IsNullOrEmpty(dotnetRoot))
        {
            throw new Xunit.Sdk.XunitException("dotnet root not resolvable");
        }

        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        if (!Directory.Exists(packsRoot))
        {
            throw new Xunit.Sdk.XunitException($"ref pack root '{packsRoot}' missing");
        }

        var version = Environment.Version.ToString(3);
        var refDir = Path.Combine(packsRoot, version, "ref", tfm);
        if (!Directory.Exists(refDir))
        {
            var major = Environment.Version.Major.ToString();
            var candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", tfm))
                .FirstOrDefault(Directory.Exists);
            if (string.IsNullOrEmpty(candidate))
            {
                throw new Xunit.Sdk.XunitException($"no ref pack for net{major}.0 under '{packsRoot}'");
            }

            refDir = candidate;
        }

        return Directory.EnumerateFiles(refDir, "*.dll").ToArray();
    }
}
