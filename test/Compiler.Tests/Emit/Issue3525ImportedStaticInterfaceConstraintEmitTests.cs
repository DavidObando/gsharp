// <copyright file="Issue3525ImportedStaticInterfaceConstraintEmitTests.cs" company="GSharp">
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
/// Issue #3525 end-to-end coverage: static constrained dispatch (ADR-0089)
/// recognized static-virtual members declared by a G# source interface
/// constraint but not by an imported CLR interface constraint — e.g.
/// <c>T.TryParse(...)</c> with <c>T : System.IParsable[T]</c> reported
/// GS0333 even though <c>IParsable[T].TryParse</c> is a static-abstract
/// interface member. <c>BindTypeParameterStaticAccessorStep</c> only ever
/// inspected <c>TypeParameterSymbol.InterfaceConstraint</c> (the source-G#
/// shape) and never <c>ClrInterfaceConstraint</c> (the imported-CLR shape).
/// These tests round-trip the repro through compile → IL-verify → run.
/// <para>
/// Compiles against the full trusted-platform-assembly set explicitly:
/// <c>IParsable[T]</c> is a solitary-arity generic interface (unlike
/// <c>IComparable</c>/<c>IEquatable</c>, which also have a non-generic
/// sibling), and gsc's bare default reference resolution (no explicit
/// <c>/reference:</c>) does not pull in the assembly that defines it — an
/// unrelated pre-existing resolution gap, not part of this issue.
/// </para>
/// </summary>
public class Issue3525ImportedStaticInterfaceConstraintEmitTests
{
    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(
        () => TrustedPlatformAssemblies().ToArray());

    [Fact]
    public void TryParse_ThroughImportedIParsableConstraint_Roundtrips_Int32()
    {
        var source = """
            package P
            import System

            func ParseOrDefault[T IParsable[T]](text string) T {
                var value T
                T.TryParse(text, nil, &value)
                return value
            }

            Console.WriteLine(ParseOrDefault[int32]("42"))
            Console.WriteLine(ParseOrDefault[int32]("not-a-number"))
            """;

        var output = CompileAndRun(source, ignoredErrorScope: @"<Program>\.ParseOrDefault$");
        Assert.Equal($"42{Environment.NewLine}0{Environment.NewLine}", output);
    }

    [Fact]
    public void TryParse_ThroughImportedIParsableConstraint_ReturnsSuccessFlag()
    {
        var source = """
            package P
            import System

            func TryParseFlag[T IParsable[T]](text string) bool {
                var value T
                return T.TryParse(text, nil, &value)
            }

            Console.WriteLine(TryParseFlag[int32]("42"))
            Console.WriteLine(TryParseFlag[int32]("nope"))
            """;

        var output = CompileAndRun(source, ignoredErrorScope: @"<Program>\.TryParseFlag$");
        Assert.Equal($"True{Environment.NewLine}False{Environment.NewLine}", output);
    }

    [Fact]
    public void NonExistentStaticMember_OnImportedInterfaceConstraint_IsBindingError()
    {
        var source = """
            package P
            import System

            func Bad[T IParsable[T]](text string) T {
                var value T
                T.NotAMember(text, nil, &value)
                return value
            }

            var z = Bad[int32]("42")
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0333", diagnostics);
    }

    private static string CompileAndRun(string source, string ignoredErrorScope = null)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3525_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(BuildCompilerArgs(outPath, srcPath));
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");

            // ADR-0089 / issue #755: constrained-static-virtual dispatch (the
            // `constrained. !!T call` shape this issue's CLR-interface path
            // reuses) trips a pre-C#-11 dotnet-ilverify rule set — a known,
            // pre-existing gap (see IlVerifier.KnownIssues.StaticVirtualInterface),
            // not something this fix introduces.
            IlVerifier.Verify(
                outPath,
                ignoredErrorCodes: ignoredErrorScope is null
                    ? null
                    : IlVerifier.KnownIssues.StaticVirtualInterface,
                ignoredErrorScope: ignoredErrorScope);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore.
            }
        }
    }

    private static string CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue3525_err_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(BuildCompilerArgs(outPath, srcPath));
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            var combined = compileOut.ToString() + compileErr.ToString();
            Assert.True(compileExit != 0, $"expected compile to fail but it succeeded: {combined}");
            return combined;
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup; ignore.
            }
        }
    }

    private static string[] BuildCompilerArgs(string outPath, string srcPath)
    {
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        args.AddRange(BclReferences.Value.Select(reference => "/reference:" + reference));
        args.Add(srcPath);
        return args.ToArray();
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator);
    }
}
