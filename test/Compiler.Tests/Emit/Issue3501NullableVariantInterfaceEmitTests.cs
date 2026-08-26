// <copyright file="Issue3501NullableVariantInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501 (Translator burn-down): declaration-site variance must compose
/// with a nullable-annotated reference type argument on an IMPORTED generic
/// interface. Roslyn's <c>SymbolEqualityComparer : IEqualityComparer&lt;ISymbol?&gt;</c>
/// passed to <c>HashSet&lt;IMethodSymbol&gt;(IEqualityComparer&lt;T&gt;?)</c> is the
/// motivating shape; the BCL-only equivalent is
/// <c>IEqualityComparer[object?] → IEqualityComparer[string]</c>. Three gaps
/// conspired:
/// <list type="number">
/// <item><c>TryClassifyConstructedImportedReferenceConversion</c> gated
/// variance slots on <c>Binder.IsReferenceTypeForConstraint</c>, which
/// deliberately rejects <c>T?</c> (correct for <c>where T : class</c>, wrong
/// for variance eligibility — the annotation has no runtime shape);</item>
/// <item>the same classifier bailed for a NON-generic imported source class
/// (no symbolic type arguments), never consulting its CLR interface
/// closure;</item>
/// <item>the CLR-level overload-resolution applicability check only knew
/// exact-argument interface matches (`ImplementsInterfaceByName`) and array
/// covariance, so constructor arguments failed GS0267; and the emitter's
/// <c>IsReferenceCompatible</c> neither unwrapped
/// <c>NullabilityAnnotatedTypeSymbol</c> nor admitted the non-generic
/// source, throwing NotSupportedException after the binder accepted.</item>
/// </list>
/// </summary>
public class Issue3501NullableVariantInterfaceEmitTests
{
    [Fact]
    public void ContravariantNullableArgument_ParameterAndConstructor_CompileAndRun()
    {
        var output = CompileAndRun("""
            package Probe
            import System
            import System.Collections.Generic

            func check(c IEqualityComparer[string]) bool {
                return c.Equals("a", "a")
            }

            // Contravariance composed with a nullable reference argument:
            // IEqualityComparer[object?] -> IEqualityComparer[string].
            let comparer IEqualityComparer[object?] = EqualityComparer[object?].Default
            Console.WriteLine(check(comparer))

            // Same conversion at a BCL constructor slot (the parameter is the
            // nullable-annotated `IEqualityComparer[T]?`).
            let set = HashSet[string](EqualityComparer[object?].Default)
            set.Add("x")
            set.Add("x")
            Console.WriteLine(set.Count)
            """);

        Assert.Equal(
            string.Join(Environment.NewLine, "True", "1") + Environment.NewLine,
            output);
    }

    [Fact]
    public void WrongDirectionContravariance_StillDiagnoses()
    {
        // Guardrail: the CLR interface-closure projection must not over-accept.
        // StringComparer implements IEqualityComparer[string]; converting it to
        // the WIDER IEqualityComparer[object] would need object -> string on
        // the contravariant slot and must keep failing.
        var diagnostics = CompileExpectingFailure("""
            package Probe
            import System
            import System.Collections.Generic

            let c IEqualityComparer[object] = StringComparer.Ordinal
            Console.WriteLine(c.GetHashCode())
            """);

        // GS0156: an explicit reference downcast exists, but the implicit
        // variance conversion must not.
        Assert.Contains("GS0156", diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ValueTypeArgument_StaysVarianceIneligible()
    {
        // Guardrail: a value-type slot never participates in reference
        // variance, nullable-annotated or not.
        var diagnostics = CompileExpectingFailure("""
            package Probe
            import System
            import System.Collections.Generic

            let c IEqualityComparer[int32] = EqualityComparer[object?].Default
            Console.WriteLine(c.GetHashCode())
            """);

        Assert.Contains("GS0155", diagnostics, StringComparison.Ordinal);
    }

    private static string CompileAndRun(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3501_variance_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }, out string diagnostics);
            Assert.True(exitCode == 0, diagnostics);
            IlVerifier.Verify(outputPath);
            return RunAssembly(directory, outputPath);
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileExpectingFailure(string source)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue3501_variance_neg_").FullName;
        try
        {
            var sourcePath = Path.Combine(directory, "test.gs");
            var outputPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);

            int exitCode = RunCompiler(new[]
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            }, out string diagnostics);
            Assert.NotEqual(0, exitCode);
            return diagnostics;
        }
        finally
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static int RunCompiler(string[] arguments, out string diagnostics)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            int exitCode = Program.Main(arguments);
            diagnostics = $"stdout:\n{stdout}\nstderr:\n{stderr}";
            return exitCode;
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string RunAssembly(string workingDirectory, string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDirectory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exec exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }
}
