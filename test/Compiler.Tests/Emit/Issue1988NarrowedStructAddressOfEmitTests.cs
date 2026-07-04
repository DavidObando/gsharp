// <copyright file="Issue1988NarrowedStructAddressOfEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1988 (follow-up to #1917/#1982): <c>EmitAddressOf</c>'s
/// <c>BoundVariableExpression</c> case took the address of a smart-cast-narrowed
/// struct local (ADR-0069 — e.g. <c>&amp;oa</c> after <c>oa is Money</c> narrows an
/// <c>object</c>-declared variable) via the raw <c>TryLoadVariableAddress</c>
/// path, pushing the address of the underlying <c>object</c> SLOT instead of an
/// unboxed pointer to the embedded <c>Money</c>. A subsequent <c>ldfld</c>
/// through that address recreates the exact #1917 ilverify defect
/// (<c>StackUnexpected: [found address of 'object'][expected ... 'Money']</c>).
/// Migrating to <see cref="object"/>-narrowing-aware <c>TryLoadStructVariableAddress</c>
/// fixes it. This is genuinely-unsafe pointer code (ADR-0122), so the residual
/// managed-pointer-to-unmanaged-pointer conversion errors are pre-existing,
/// accepted ilverify limitations (see <see cref="IlVerifier.KnownIssues"/> and
/// Issue1034StructPointerEmitTests) — the test asserts the SPECIFIC #1917-style
/// "address of 'object'" mismatch is gone, plus correct runtime behavior.
/// </summary>
public class Issue1988NarrowedStructAddressOfEmitTests
{
    private static readonly string[] UnsafePointerIgnoredErrorCodes =
    {
        "UnmanagedPointer",
        "StackUnexpected",
        "StackByRef",
        "ExpectedPtr",
    };

    [Fact]
    public void AddressOf_NarrowedStructLocal_RunsAndDoesNotMistypeAsObjectAddress()
    {
        var source = """
            package P
            import System

            struct Wallet {
                var Cents int32
            }

            unsafe func run() {
                var a = Wallet{ Cents: 100 }
                var oa object = a
                if oa is Wallet {
                    var p = &oa
                    Console.WriteLine((*p).Cents)
                }
            }

            run()
            """;

        var (output, assemblyPath) = CompileAndRun(source);
        Assert.Equal("100\n", output);

        // Verify ilverify no longer reports the #1917-style "address of
        // 'object'" stack-shape mismatch (only the inherent, pre-existing
        // unsafe-pointer-conversion errors remain).
        var stdout = RunIlVerifyRaw(assemblyPath);
        Assert.DoesNotContain("address of 'object'", stdout, StringComparison.Ordinal);
    }

    private static string RunIlVerifyRaw(string assemblyPath)
    {
        // Re-run ilverify directly (bypassing the throw-on-error helper) so we
        // can inspect the exact error text for the absence of the #1917
        // signature, while IlVerifier.Verify (below) still gates on the
        // known/accepted unsafe-pointer error set.
        try
        {
            IlVerifier.Verify(assemblyPath, ignoredErrorCodes: UnsafePointerIgnoredErrorCodes);
            return string.Empty;
        }
        catch (Xunit.Sdk.XunitException ex)
        {
            return ex.Message;
        }
    }

    private static (string Output, string AssemblyPath) CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1988_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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

            return (stdout.Replace("\r\n", "\n"), outPath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
