// <copyright file="Issue3802NotNullIfNotNullTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3802: gsc must honour <c>[return: NotNullIfNotNull(nameof(p))]</c> on
/// imported (BCL) members. <c>Path.ChangeExtension</c> is declared
/// <c>string? ChangeExtension(string? path, string? extension)</c> with that
/// conditional post-condition, so C# accepts
/// <c>string DestinationRelativePath(string source) =&gt; Path.ChangeExtension(source, ".gs");</c>.
/// <para>
/// Before this fix gsc reported <c>GS0155: Cannot convert type 'string?' to
/// 'string'</c> at every such site, which is what dropped the #3501
/// self-migration gate to 40/51 (<c>Cs2Gs.Pipeline</c> plus its three
/// consumers) once #3705 family 2 made imported nullability read correctly.
/// </para>
/// <para>
/// Every positive case EXECUTES: compile, IL-verify, run, assert the program's
/// own stdout. The narrowing is a bind-time type fact but a wrong
/// implementation (for example one that unconditionally strips the
/// annotation) is only visible at runtime, so binding-only assertions would
/// not be evidence.
/// </para>
/// </summary>
public class Issue3802NotNullIfNotNullTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The exact reduction of the gate regression:
        // tools/cs2gs/Cs2Gs.Pipeline/RepositoryMirror.DestinationRelativePath.
        yield return new object[]
        {
            "change-extension-non-null-argument",
            @"
package P
import System
import System.IO

func DestinationRelativePath(source string) string {
    return Path.ChangeExtension(source, "".gs"")
}

Console.WriteLine(DestinationRelativePath(""tools/cs2gs/Foo.cs""))
",
            new[] { "tools/cs2gs/Foo.gs" },
        };

        // Two more BCL carriers on the same type.
        yield return new object[]
        {
            "get-file-name-and-extension",
            @"
package P
import System
import System.IO

func Leaf(p string) string {
    return Path.GetFileName(p)
}

func Ext(p string) string {
    return Path.GetExtension(p)
}

Console.WriteLine(Leaf(""a/b/c.cs""))
Console.WriteLine(Ext(""a/b/c.cs""))
",
            new[] { "c.cs", ".cs" },
        };

        // ANTI-VACUITY / CONDITIONAL GUARD, runtime half: when the named
        // argument IS nil the result really is nil, so the narrowed shape must
        // never be relied on to be non-nil. Binding this to `string?` still
        // works, and the value observed at runtime is nil.
        yield return new object[]
        {
            "nil-argument-still-yields-nil-at-runtime",
            @"
package P
import System
import System.IO

func Dest(source string?) string? {
    return Path.ChangeExtension(source, "".gs"")
}

let r = Dest(nil)
Console.WriteLine(if r == nil { ""nil"" } else { ""not-nil"" })
Console.WriteLine(Dest(""x.cs"")!!)
",
            new[] { "nil", "x.gs" },
        };


        // CONDITIONAL GUARD, by-ref half. `Volatile.Read[T](ref T location)` is
        // annotated `[return: NotNullIfNotNull(nameof(location))]`. The bound
        // argument is a BYREF, whose own type symbol is not a nullable one even
        // when it points at a nullable location — reading it naively narrows
        // the result and breaks issue #3727's `Volatile.Read(&r) != nil`. The
        // nullability that counts is the POINTEE's, and here it is nil.
        yield return new object[]
        {
            "byref-argument-uses-the-pointee-nullability",
            @"
package P
import System
import System.Threading

class Result {
    var Value int32 = 0
}

func Guard() bool {
    var r Result? = nil
    return Volatile.Read(&r) == nil
}

Console.WriteLine(if Guard() { ""nil"" } else { ""not-nil"" })
",
            new[] { "nil" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void NotNullIfNotNull_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3802_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, name + ".dll");
            var (compileExit, compileLog) = Compile(tempDir, source, outPath);

            Assert.True(
                compileExit == 0,
                $"gsc failed for '{name}' (a GS0155 here is the #3802 defect):\n{compileLog}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// CONDITIONAL GUARD, compile half. The post-condition is CONDITIONAL: a
    /// nullable argument must still produce a nullable result. A fix that
    /// narrowed unconditionally would reintroduce exactly the unsoundness that
    /// #3705 family 2 removed — an imported <c>string?</c> silently binding as
    /// non-null <c>string</c> — so this case must still be REJECTED after the
    /// fix, and it fails on <c>origin/main</c> too (it is not the regression).
    /// </summary>
    [Fact]
    public void NullableArgument_StillYieldsNullableResult()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3802_neg_").FullName;
        try
        {
            var source = @"
package P
import System
import System.IO

func Dest(source string?) string {
    return Path.ChangeExtension(source, "".gs"")
}

Console.WriteLine(Dest(""x.cs""))
";
            var outPath = Path.Combine(tempDir, "neg.dll");
            var (compileExit, compileLog) = Compile(tempDir, source, outPath);

            Assert.True(
                compileExit != 0,
                "a NULLABLE argument must NOT narrow the result: [NotNullIfNotNull] is a "
                    + "conditional post-condition, and narrowing it unconditionally would "
                    + "restore the #3705 family 2 unsoundness. Compile log:\n" + compileLog);
            Assert.Contains("GS0155", compileLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// ANTI-VACUITY: a method with NO conditional post-condition and a genuinely
    /// nullable return must still be rejected when returned as non-nullable —
    /// including <c>Path.GetDirectoryName</c>, which sits on the same type as
    /// the annotated members and is deliberately NOT annotated (it returns
    /// <c>null</c> for a root path even when the argument is non-null, and C#
    /// rejects this source too). This is the behaviour #3705 family 2
    /// established; the #3802 fix must key off the attribute, not off the type.
    /// Passes on <c>origin/main</c> as well.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="body">The G# function body expression.</param>
    [Theory]
    [InlineData("environment-variable", @"Environment.GetEnvironmentVariable(p)")]
    [InlineData("get-directory-name-is-not-annotated", @"Path.GetDirectoryName(p)")]
    public void UnannotatedNullableReturn_IsStillRejected(string name, string body)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3802_anti_").FullName;
        try
        {
            var source = @"
package P
import System
import System.IO

func F(p string) string {
    return " + body + @"
}

Console.WriteLine(F(""a/b/c.cs""))
";
            var outPath = Path.Combine(tempDir, "anti.dll");
            var (compileExit, compileLog) = Compile(tempDir, source, outPath);

            Assert.True(
                compileExit != 0,
                $"'{name}': an unannotated nullable imported member must still be rejected:\n" + compileLog);
            Assert.Contains("GS0155", compileLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The narrowing is wired on the imported INSTANCE call node as well as the
    /// static one. No .NET 10 BCL instance method carries
    /// <c>[return: NotNullIfNotNull]</c> (a reflection sweep of
    /// System.Private.CoreLib, System.Text.RegularExpressions and System.Private.Uri
    /// finds zero), so this case builds its own C# metadata assembly — which is
    /// also the shape any referenced third-party library would present.
    /// Compiles, IL-verifies and RUNS, and asserts the conditional half in the
    /// same reference context.
    /// </summary>
    [Fact]
    public void ImportedInstanceMethodCarrier_NarrowsAndStaysConditional()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3802_inst_").FullName;
        try
        {
            const string metadataSource = """
                #nullable enable
                using System.Diagnostics.CodeAnalysis;

                namespace Issue3802.Metadata
                {
                    public sealed class Echo
                    {
                        [return: NotNullIfNotNull(nameof(input))]
                        public string? Repeat(string? input) => input == null ? null : input + input;
                    }
                }
                """;

            // TRUSTED_PLATFORM_ASSEMBLIES is always present under the test host;
            // its absence would be an environment fault, not a test condition.
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator)
                .Where(File.Exists)
                .Select(path => MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                "Issue3802.Metadata",
                new[] { CSharpSyntaxTree.ParseText(metadataSource, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable));
            var metadataPath = Path.Combine(tempDir, "Issue3802.Metadata.dll");
            var metadataResult = compilation.Emit(metadataPath);
            Assert.True(metadataResult.Success, string.Join(Environment.NewLine, metadataResult.Diagnostics));

            const string positive = @"
package P
import System
import Issue3802.Metadata

func Twice(s string) string {
    return Echo().Repeat(s)
}

Console.WriteLine(Twice(""ab""))
";
            var outPath = Path.Combine(tempDir, "inst.dll");
            var (exitCode, log) = Compile(tempDir, positive, outPath, metadataPath);
            Assert.True(exitCode == 0, "an imported INSTANCE carrier must narrow too:\n" + log);

            IlVerifier.Verify(outPath, new[] { metadataPath });
            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"instance carrier program must run. Exit {runExit}:\n{output}");
            Assert.Equal("abab", output.Trim());

            // CONDITIONAL GUARD for the instance path.
            const string negative = @"
package P
import System
import Issue3802.Metadata

func Twice(s string?) string {
    return Echo().Repeat(s)
}

Console.WriteLine(Twice(""ab""))
";
            var (negExit, negLog) = Compile(
                tempDir,
                negative,
                Path.Combine(tempDir, "inst-neg.dll"),
                metadataPath);
            Assert.True(negExit != 0, "a nullable argument must not narrow the instance carrier:\n" + negLog);
            Assert.Contains("GS0155", negLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static (int Exit, string Log) Compile(
        string tempDir,
        string source,
        string outPath,
        string extraReference = null)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

        if (extraReference != null)
        {
            args.Add("/reference:" + extraReference);
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

        return (compileExit, "stdout:\n" + compileOut + "\nstderr:\n" + compileErr);
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
