// <copyright file="IlVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Smoke tests for the <see cref="IlVerifier"/> helper itself. These guard the
/// gate: if these break, every Compile…+Verify call elsewhere in this assembly
/// is producing meaningless results.
/// </summary>
public class IlVerifierTests
{
    [Fact]
    public void Verify_AcceptsValidEmittedAssembly_DoesNotThrow()
    {
        // Compile the smallest possible gs program and verify the result.
        // This is the actual usage pattern for Compile…Verify() helpers, and
        // guards against regressions in IlVerifier itself (e.g., wrong system
        // module name, missing reference probe).
        var tempDir = Directory.CreateTempSubdirectory("gs_ilv_smoke_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "smoke.gs");
            var outPath = Path.Combine(tempDir, "smoke.dll");
            File.WriteAllText(srcPath, "package P\n\nfunc Main() {\n}\n");

            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath), $"expected output at {outPath}");

            IlVerifier.Verify(outPath);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public void Verify_MissingAssembly_Throws()
    {
        var bogus = Path.Combine(Path.GetTempPath(), $"does-not-exist-{Guid.NewGuid():N}.dll");
        Assert.Throws<XunitException>(() => IlVerifier.Verify(bogus));
    }

    [Fact]
    public void Verify_MissingReference_Throws()
    {
        var bogus = Path.Combine(
            Directory.GetCurrentDirectory(),
            $"does-not-exist-{Guid.NewGuid():N}.dll");
        var exception = Assert.Throws<XunitException>(
            () => IlVerifier.Verify(typeof(IlVerifierTests).Assembly.Location, new[] { bogus }));

        Assert.Contains("reference assembly not found", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Verify_InvalidMethodBody_ReportsErrors()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_ilv_bad_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "bad.gs");
            var outPath = Path.Combine(tempDir, "bad.dll");
            File.WriteAllText(srcPath, "package P\n\npublic func Bad() {\n}\n");

            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exit);

            var bytes = File.ReadAllBytes(outPath);
            using (var peReader = new PEReader(new MemoryStream(bytes, writable: false)))
            {
                var metadata = peReader.GetMetadataReader();
                var method = metadata.MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single(m => metadata.GetString(m.Name) == "Bad");
                var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
                Assert.Equal(new byte[] { 0x2A }, body.GetILBytes());

                var section = peReader.PEHeaders.SectionHeaders.Single(s =>
                    method.RelativeVirtualAddress >= s.VirtualAddress
                    && method.RelativeVirtualAddress < s.VirtualAddress + s.SizeOfRawData);
                var bodyOffset = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData;
                var headerSize = 1;
                bytes[bodyOffset + headerSize] = 0x26;
            }

            File.WriteAllBytes(outPath, bytes);
            var exception = Assert.Throws<XunitException>(() => IlVerifier.Verify(outPath));
            Assert.Contains("Error(s)", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public void Verify_RespectsSkipEnvVar()
    {
        var prev = Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY");
        Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", "1");
        try
        {
            // With the gate disabled, even a missing assembly is a no-op so
            // developers can locally bypass the tool requirement.
            var bogus = Path.Combine(Path.GetTempPath(), $"does-not-exist-{Guid.NewGuid():N}.dll");
            IlVerifier.Verify(bogus);
            Assert.False(IlVerifier.IsEnabled);
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", prev);
        }
    }

    [Fact]
    public void Verify_MethodScopedIgnore_DoesNotHideSameErrorInAnotherMethod()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_ilv_scope_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "scope.gs");
            var outPath = Path.Combine(tempDir, "scope.dll");
            File.WriteAllText(
                srcPath,
                """
                package P

                unsafe func Ignored(p *int32) int32 { return *p }
                unsafe func Visible(p *int32) int32 { return *p }
                """);

            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exit);

            var exception = Assert.Throws<XunitException>(
                () => IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: new[] { "UnmanagedPointer", "StackByRef" },
                    ignoredErrorScope: @"<Program>\.Ignored$"));
            Assert.Contains("::Visible(", exception.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("::Ignored(", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public void RunProcess_HungChild_TimesOutWithPartialOutput()
    {
        var assemblyPath = typeof(IlVerifierTests).Assembly.Location;
        var stopwatch = Stopwatch.StartNew();
        var exception = Assert.Throws<XunitException>(
            () => IlVerifier.RunProcess(
                CreateChildProcess(
                    "[Console]::Out.Write('timeout-stdout'); [Console]::Error.Write('timeout-stderr'); Start-Sleep -Seconds 6",
                    "printf timeout-stdout; printf timeout-stderr >&2; sleep 6"),
                assemblyPath,
                timeoutMilliseconds: 2_000));
        stopwatch.Stop();

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), $"timeout took {stopwatch.Elapsed}");
        Assert.Contains("timed out after 2000 ms", exception.Message, StringComparison.Ordinal);
        Assert.Contains(assemblyPath, exception.Message, StringComparison.Ordinal);
        Assert.Contains("timeout-stdout", exception.Message, StringComparison.Ordinal);
        Assert.Contains("timeout-stderr", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RunProcess_LargeStdoutAndStderr_DrainsBothPipes()
    {
        // A regression that blocks in either drain before WaitForExit hangs this test.
        // Starting a drain after the wait instead reaches the 10 s timeout and fails boundedly.
        // xUnit's Fact timeout is unavailable because this assembly disables test
        // parallelization, and RunProcess's timeout cannot cover a deadlock placed
        // before its wait. Treat such a hang as the regression, not a flake.
        const int OutputLength = 128 * 1024;
        var result = IlVerifier.RunProcess(
            CreateChildProcess(
                $"[Console]::Out.Write('o' * {OutputLength}); [Console]::Error.Write('e' * {OutputLength})",
                $"awk 'BEGIN {{ for (i = 0; i < {OutputLength}; i++) printf \"o\" }}'; " +
                $"awk 'BEGIN {{ for (i = 0; i < {OutputLength}; i++) printf \"e\" }}' >&2"),
            typeof(IlVerifierTests).Assembly.Location,
            timeoutMilliseconds: 10_000);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(new string('o', OutputLength), result.Stdout);
        Assert.Equal(new string('e', OutputLength), result.Stderr);
    }

    [Fact]
    public void TryProbe_LargeStdoutAndStderr_DrainsBothPipes()
    {
        const int OutputLength = 128 * 1024;
        Assert.True(
            IlVerifier.TryProbe(
                CreateChildProcess(
                    $"[Console]::Out.Write('o' * {OutputLength}); [Console]::Error.Write('e' * {OutputLength})",
                    $"awk 'BEGIN {{ for (i = 0; i < {OutputLength}; i++) printf \"o\" }}'; " +
                    $"awk 'BEGIN {{ for (i = 0; i < {OutputLength}; i++) printf \"e\" }}' >&2"),
                timeoutMilliseconds: 10_000));
    }

    [Fact]
    public void RunProcess_EscapedDescendantHoldingPipe_TimeoutRemainsBounded()
    {
        if (OperatingSystem.IsWindows())
        {
            // Process has no portable API for creating a reparented Windows
            // descendant that retains inherited redirected pipe handles.
            return;
        }

        var pidPath = Path.Combine(
            AppContext.BaseDirectory,
            $"ilverify-escaped-{Guid.NewGuid():N}.pid");
        try
        {
            var stopwatch = Stopwatch.StartNew();
            var exception = Assert.Throws<XunitException>(
                () => IlVerifier.RunProcess(
                    CreateChildProcess(
                        string.Empty,
                        $"(sleep 30 2>/dev/null & echo $! > '{pidPath}'); printf escaped-stdout; sleep 6"),
                    typeof(IlVerifierTests).Assembly.Location,
                    timeoutMilliseconds: 2_000));
            stopwatch.Stop();

            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(20), $"timeout took {stopwatch.Elapsed}");
            Assert.Contains("process '/bin/sh' timed out after 2000 ms", exception.Message, StringComparison.Ordinal);
            Assert.Contains(
                "<unavailable: output pipe held by a surviving descendant>",
                exception.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            if (File.Exists(pidPath)
                && int.TryParse(File.ReadAllText(pidPath), out var pid))
            {
                try
                {
                    using var escaped = Process.GetProcessById(pid);
                    escaped.Kill(entireProcessTree: true);
                    escaped.WaitForExit(5_000);
                }
                catch (ArgumentException)
                {
                }
            }

            File.Delete(pidPath);
        }
    }

    private static ProcessStartInfo CreateChildProcess(string windowsCommand, string unixCommand)
    {
        var startInfo = new ProcessStartInfo(OperatingSystem.IsWindows() ? "powershell.exe" : "/bin/sh")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (OperatingSystem.IsWindows())
        {
            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-NonInteractive");
            startInfo.ArgumentList.Add("-Command");
            startInfo.ArgumentList.Add(windowsCommand);
        }
        else
        {
            startInfo.ArgumentList.Add("-c");
            startInfo.ArgumentList.Add(unixCommand);
        }

        return startInfo;
    }
}
