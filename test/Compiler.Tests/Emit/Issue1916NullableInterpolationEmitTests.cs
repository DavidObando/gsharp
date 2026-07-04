// <copyright file="Issue1916NullableInterpolationEmitTests.cs" company="GSharp">
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
/// Issue #1916: interpolating a value-type <c>Nullable&lt;T&gt;</c> hole
/// (e.g. <c>"n=$n"</c> where <c>n</c> is <c>int32?</c>) emitted invalid IL —
/// ilverify reported <c>StackUnexpected</c> ("found Nullable`1&lt;int32&gt;
/// expected Int32") at the <c>AppendFormatted&lt;T&gt;</c> call site.
///
/// Root cause: <see cref="GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol"/>
/// reuses the underlying type's CLR <see cref="Type"/> as its own
/// <c>ClrType</c> (so binder-side ClrType probes see the lifted primitive),
/// but the emitter always pushes the full <c>Nullable&lt;T&gt;</c> struct for
/// a nullable-typed local/expression. <c>InterpolatedStringHandlerLowerer
/// .CloseAppendFormatted</c> closed the generic
/// <c>AppendFormatted&lt;T&gt;</c> call over <c>holeType.ClrType</c> (the bare
/// underlying type), producing a generic instantiation that expects
/// <c>Int32</c> while the actual stack value is <c>Nullable&lt;Int32&gt;</c>.
/// The fix routes through
/// <see cref="GSharp.Core.CodeAnalysis.Symbols.NullableTypeSymbol.GetEffectiveClrType"/>,
/// which already exists for exactly this "declared type vs. actual stack
/// shape" mismatch (see issue #530) and returns <c>Nullable&lt;T&gt;</c> for a
/// value-type nullable.
///
/// The bug was unrelated to <c>??=</c> itself — the original report's
/// <c>n ??= 9</c> repro only manifested the mismatch because the following
/// line interpolated <c>n</c>; a bare <c>Console.WriteLine(n)</c> after the
/// same <c>??=</c> already verified cleanly.
/// </summary>
public class Issue1916NullableInterpolationEmitTests
{
    [Fact]
    public void InterpolateNullableInt32_AfterCoalesceAssign_VerifiesAndPrintsUnderlying()
    {
        var source = """
            package P

            import System

            var n int32? = nil
            n ??= 9
            Console.WriteLine("n=$n")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=9\n", output);
    }

    [Fact]
    public void InterpolateNullableInt32_WithValue_VerifiesAndPrintsUnderlying()
    {
        var source = """
            package P

            import System

            var n int32? = 9
            Console.WriteLine("n=$n")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=9\n", output);
    }

    [Fact]
    public void InterpolateNullableInt32_Absent_VerifiesAndPrintsEmpty()
    {
        var source = """
            package P

            import System

            var n int32? = nil
            Console.WriteLine("n=[$n]")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("n=[]\n", output);
    }

    [Fact]
    public void InterpolateNullableBool_VerifiesAndPrintsUnderlying()
    {
        var source = """
            package P

            import System

            var b bool? = true
            Console.WriteLine("b=$b")
            """;

        var output = CompileAndRun(source);
        Assert.Equal("b=True\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1916_").FullName;
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
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
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
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
