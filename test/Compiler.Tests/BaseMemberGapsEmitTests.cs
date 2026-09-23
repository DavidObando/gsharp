// <copyright file="BaseMemberGapsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0192 follow-on 2: base-member shapes that the real
/// <c>[GeneratedRegex]</c> output uses once cs2gs back-translates it to G#.
/// A feasibility spike that ran the generator and translated its
/// <c>RegexRunner</c> subclass found three general gsc gaps:
/// <list type="number">
///   <item>compound assignment and increment/decrement of a base-qualified
///   member (<c>base.runtextpos++</c>) reported GS0125;</item>
///   <item><c>base.M()</c> inside a function literal (a translated C# local
///   function) reported GS0383;</item>
///   <item>a <c>protected</c> static member of an imported base
///   (<c>Regex.ValidateMatchTimeout</c>) could not be called from the derived
///   class.</item>
/// </list>
/// <para>
/// Every case compiles with gsc, passes ILVerify, and runs: binding alone
/// cannot show that a base accessor was called non-virtually, or that a
/// base call hosted in a closure verifies.
/// </para>
/// </summary>
public class BaseMemberGapsEmitTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // Gap 1: every compound form on a protected field of an imported base.
        yield return new object[]
        {
            "compound-imported-base-field",
            @"
package P
import System
import System.Text.RegularExpressions

class Runner : RegexRunner {
    func Step() string {
        base.runtextpos = 5
        base.runtextpos++
        ++base.runtextpos
        base.runtextpos += 10
        base.runtextpos--
        let old = base.runtextpos++
        let now = ++base.runtextpos
        return ""$old $now ${base.runtextpos}""
    }
}

Console.WriteLine(Runner().Step())
",
            new[] { "16 18 18" },
        };

        // Gap 1: same-compilation base, overridden property. The base
        // accessors must be called non-virtually for both halves of the
        // compound, or the override's x100 read shows up.
        yield return new object[]
        {
            "compound-overridden-base-property",
            @"
package P
import System

open class Base {
    var store int32 = 1
    protected var f int32
    open prop P int32 {
        get -> store
        set { store = value }
    }
}

class Derived : Base {
    override prop P int32 {
        get -> base.P * 100
        set { }
    }

    func Go() string {
        base.P++
        base.P += 5
        let old = base.P--
        base.f += 3
        --base.f
        return ""$old ${base.P} $P ${base.f}""
    }
}

Console.WriteLine(Derived().Go())
",
            new[] { "7 6 600 2" },
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
    public void BaseMemberShape_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_basegaps_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(exit == 0, $"gsc failed for '{name}':\nstdout:\n{stdout}\nstderr:\n{stderr}");
            var outPath = Path.Combine(tempDir, name + ".dll");
            IlVerifier.Verify(outPath);

            var (runExit, output) = RunDotnet(outPath);
            Assert.True(runExit == 0, $"'{name}' must run to completion. Exit {runExit}:\n{output}");

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

    private static (int Exit, string Stdout, string Stderr) Compile(string tempDir, string name, string source)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, name + ".dll");

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

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
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
