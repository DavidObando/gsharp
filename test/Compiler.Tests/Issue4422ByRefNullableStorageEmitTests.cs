// <copyright file="Issue4422ByRefNullableStorageEmitTests.cs" company="GSharp">
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
/// Issue #4422: a by-reference argument whose storage is nullable-annotated
/// (<c>&amp;base.runstack</c>, where the reference pack declares
/// <c>RegexRunner.runstack</c> as <c>int[]?</c>) at a <c>ref []int32</c>
/// parameter. This is the shape the real <c>[GeneratedRegex]</c> runner uses
/// for a regex that backtracks inside a loop
/// (<c>Utilities.StackPush(ref base.runstack!, …)</c> after cs2gs). gsc
/// reported GS0154; C# accepts it, and now gsc does too, with a GS0612
/// warning.
/// <para>
/// Each case compiles, passes ILVerify and runs, so the address really is
/// passed to the callee and written through.
/// </para>
/// </summary>
public class Issue4422ByRefNullableStorageEmitTests
{
    private const string FixtureSource = """
        #nullable enable
        namespace Issue4422.Metadata
        {
            public class AnnotatedRunner
            {
                protected internal int[]? runstack;
                protected string? label;
            }
        }
        """;

    /// <summary>
    /// The generated runner's shape against a C# base that annotates the
    /// protected field <c>int[]?</c>, independent of whether the host's
    /// runtime assemblies carry nullable metadata.
    /// </summary>
    [Fact]
    public void AnnotatedProtectedField_PassedByRef_CompilesVerifiesAndRuns()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4422_fixture_").FullName;
        try
        {
            var metadataPath = EmitFixture(tempDir);
            const string source = @"
package P
import System
import Issue4422.Metadata

func StackPush(ref stack []int32, ref pos int32, arg0 int32) {
    if pos >= stack.Length {
        Array.Resize(&stack, pos * 2)
    }

    stack[pos] = arg0
    pos++
}

func Label(ref s string) {
    s = s + ""!""
}

class Runner : AnnotatedRunner {
    func Go() string {
        base.runstack = []int32{0}
        base.label = ""l""
        var pos int32 = 1
        StackPush(&base.runstack, &pos, 7)
        StackPush(&base.runstack, &pos, 8)
        Label(&base.label)
        let stack = base.runstack!!
        return ""${stack.Length} ${stack[1]} ${stack[2]} $pos ${base.label!!}""
    }
}

Console.WriteLine(Runner().Go())
";
            var outPath = Path.Combine(tempDir, "fixture.dll");
            var (exit, log) = Compile(tempDir, source, outPath, metadataPath);
            Assert.True(exit == 0, "a nullable-annotated field must be accepted by reference (GS0154 here is #4422):\n" + log);
            Assert.Equal(3, CountOccurrences(log, "warning GS0612"));

            IlVerifier.Verify(outPath, new[] { metadataPath });
            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"program must run. Exit {runExit}:\n{output}");
            Assert.Equal("4 7 8 3 l!", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// The real <c>RegexRunner</c> subclass shape, bound against the host's
    /// framework assemblies. Where those annotate <c>runstack</c> as
    /// <c>int[]?</c> (as the reference pack does) this was the #4422 GS0154;
    /// where they are oblivious it is a platform field. Either way it must
    /// compile, verify and run.
    /// </summary>
    [Fact]
    public void RegexRunnerRunstack_PassedByRef_CompilesVerifiesAndRuns()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4422_regex_").FullName;
        try
        {
            const string source = @"
package P
import System
import System.Text.RegularExpressions

func StackPush(ref stack []int32, ref pos int32, arg0 int32) {
    if pos >= stack.Length {
        Array.Resize(&stack, pos * 2)
    }

    stack[pos] = arg0
    pos++
}

class Runner : RegexRunner {
    func Go() string {
        base.runstack = []int32{0, 0}
        base.runstackpos = 0
        StackPush(&base.runstack, &base.runstackpos, 5)
        StackPush(&base.runstack, &base.runstackpos, 6)
        StackPush(&base.runstack, &base.runstackpos, 7)
        let stack = base.runstack!!
        return ""${stack.Length} ${stack[0]} ${stack[2]} ${base.runstackpos}""
    }
}

Console.WriteLine(Runner().Go())
";
            var outPath = Path.Combine(tempDir, "regex.dll");
            var (exit, log) = Compile(tempDir, source, outPath);
            Assert.True(exit == 0, "&base.runstack must be accepted at a ref []int32 parameter (#4422):\n" + log);
            Assert.DoesNotContain("GS0154", log, StringComparison.Ordinal);

            IlVerifier.Verify(outPath);
            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"program must run. Exit {runExit}:\n{output}");
            Assert.Equal("4 5 7 3", output.Trim());
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// A value-type <c>int32?</c> is <c>Nullable&lt;int32&gt;</c>, not an
    /// annotation. Before the fix this compiled with no diagnostic and the
    /// callee's <c>int32</c> store landed on the <c>Nullable</c>'s
    /// <c>hasValue</c> field, so the program printed <c>1</c> instead of
    /// <c>42</c>. It must be GS0154.
    /// </summary>
    [Fact]
    public void ValueTypeNullableStorage_AtRefInt32_IsGS0154()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4422_value_").FullName;
        try
        {
            const string source = @"
package P
import System

func SetI(ref i int32) {
    i = 42
}

var n int32? = 1
SetI(&n)
Console.WriteLine(n)
";
            var (exit, log) = Compile(tempDir, source, Path.Combine(tempDir, "value.dll"));
            Assert.True(exit != 0, "int32? storage must not be passed as ref int32:\n" + log);
            Assert.Contains("GS0154", log, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string EmitFixture(string tempDir)
    {
        var references = TrustedPlatformAssemblies().Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Issue4422.Metadata",
            new[] { CSharpSyntaxTree.ParseText(FixtureSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        var metadataPath = Path.Combine(tempDir, "Issue4422.Metadata.dll");
        var result = compilation.Emit(metadataPath);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return metadataPath;
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        var index = text.IndexOf(value, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal);
        }

        return count;
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
