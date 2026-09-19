// <copyright file="Issue4301GeneratedRegexEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// End-to-end emit + execute + ilverify coverage for ADR-0187 / issue #4301:
/// a G# function annotated with <c>@GeneratedRegex</c> synthesizes a
/// private <c>shared</c>/static <c>Regex</c>-typed backing field
/// (ADR-0051's auto-property backing-field shape, not ADR-0092's two-method
/// P/Invoke shape), initialized once in the declaring type's
/// <c>.cctor</c>, with the annotated function's body reduced to a trivial
/// <c>return &lt;field&gt;</c>. These tests compile-and-run real programs —
/// not "it parses" — and assert real-Regex-object semantics (options,
/// timeout, and, critically, cross-instance reference identity for an
/// instance-method declaration).
/// </summary>
public class Issue4301GeneratedRegexEmitTests
{
    [Fact]
    public void StaticGeneratedRegex_ReturnsSameCachedInstance_OnEveryCall()
    {
        const string source = """
            package P
            import System
            import System.Text.RegularExpressions

            class C {
                shared {
                    @GeneratedRegex("^[a-z]+$")
                    func Pattern() Regex;
                }
            }

            var first = C.Pattern()
            var second = C.Pattern()
            Console.WriteLine(object.ReferenceEquals(first, second))
            Console.WriteLine(first.IsMatch("lowercase"))
            Console.WriteLine(first.IsMatch("UPPERCASE"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}", output);
    }

    [Fact]
    public void InstanceGeneratedRegex_ReturnsSameCachedInstance_AcrossDifferentReceivers()
    {
        // Issue #4301 / Cs2Gs.Tests Issue3086GeneratedRegex fixture: real
        // [GeneratedRegex] semantics are that the compiled pattern has no
        // per-instance state, so the cache is static-lifetime even behind
        // an instance method. Two DIFFERENT instances must return the SAME
        // cached Regex object.
        const string source = """
            package P
            import System
            import System.Text.RegularExpressions

            class Owner {
                @GeneratedRegex("^[a-z]+$")
                public func LowercaseWords() Regex;
            }

            var firstOwner = Owner()
            var secondOwner = Owner()
            var firstRegex = firstOwner.LowercaseWords()
            Console.WriteLine(object.ReferenceEquals(firstRegex, firstOwner.LowercaseWords()))
            Console.WriteLine(object.ReferenceEquals(firstRegex, secondOwner.LowercaseWords()))
            Console.WriteLine(firstRegex.IsMatch("lowercase"))
            Console.WriteLine(firstRegex.IsMatch("UPPERCASE"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal(
            $"True{Environment.NewLine}True{Environment.NewLine}True{Environment.NewLine}False{Environment.NewLine}",
            output);
    }

    [Fact]
    public void GeneratedRegex_PreservesExplicitOptionsAndMatchTimeout()
    {
        const string source = """
            package P
            import System
            import System.Text.RegularExpressions

            class C {
                shared {
                    @GeneratedRegex("^abc$", RegexOptions.ExplicitCapture, matchTimeoutMilliseconds: 1000)
                    func Pattern() Regex;
                }
            }

            var regex = C.Pattern()
            Console.WriteLine(regex.Options == RegexOptions.ExplicitCapture)
            Console.WriteLine(regex.MatchTimeout.TotalMilliseconds)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}1000{Environment.NewLine}", output);
    }

    [Fact]
    public void GeneratedRegex_NegativeOneTimeout_MatchesRegexInfiniteMatchTimeout()
    {
        const string source = """
            package P
            import System
            import System.Text.RegularExpressions

            class C {
                shared {
                    @GeneratedRegex("^abc$", RegexOptions.None, matchTimeoutMilliseconds: -1)
                    func Pattern() Regex;
                }
            }

            var regex = C.Pattern()
            Console.WriteLine(regex.MatchTimeout == Regex.InfiniteMatchTimeout)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"True{Environment.NewLine}", output);
    }

    [Fact]
    public void GeneratedRegex_NoExplicitTimeout_UsesProcessWideDefault()
    {
        // No `matchTimeoutMilliseconds` argument -> the two-argument
        // `Regex(string, RegexOptions)` constructor is used, so the
        // process-wide default match timeout (the AppContext switch
        // `REGEX_DEFAULT_MATCH_TIMEOUT`) applies exactly as it would for
        // real [GeneratedRegex]-generated C#.
        const string source = """
            package P
            import System
            import System.Text.RegularExpressions

            class C {
                shared {
                    @GeneratedRegex("^abc$")
                    func Pattern() Regex;
                }
            }

            AppContext.SetData("REGEX_DEFAULT_MATCH_TIMEOUT", TimeSpan.FromMilliseconds(250))
            var regex = C.Pattern()
            Console.WriteLine(regex.MatchTimeout.TotalMilliseconds)
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"250{Environment.NewLine}", output);
    }

    [Fact]
    public void GeneratedRegex_EmittedBackingField_IsPrivateStatic()
    {
        const string source = """
            package P
            import System.Text.RegularExpressions

            class C {
                shared {
                    @GeneratedRegex("^abc$")
                    func Pattern() Regex;
                }
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_generatedregex_meta_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "library");
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var md = pe.GetMetadataReader();

            var foundBackingField = false;
            foreach (var h in md.FieldDefinitions)
            {
                var f = md.GetFieldDefinition(h);
                var name = md.GetString(f.Name);
                if (name.Contains("Pattern") && name.Contains("k__BackingField"))
                {
                    foundBackingField = true;
                    Assert.True((f.Attributes & System.Reflection.FieldAttributes.Static) == System.Reflection.FieldAttributes.Static);
                    Assert.True((f.Attributes & System.Reflection.FieldAttributes.Private) == System.Reflection.FieldAttributes.Private);
                }
            }

            Assert.True(foundBackingField, "expected a synthesized static backing field for Pattern");
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

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_generatedregex_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);
            CompileOrThrow(srcPath, outPath, target: "exe");
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

            using var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

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
            }
        }
    }

    private static void CompileOrThrow(string srcPath, string outPath, string target)
    {
        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:" + target,
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
    }
}
