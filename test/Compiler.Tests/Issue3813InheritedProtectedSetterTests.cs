// <copyright file="Issue3813InheritedProtectedSetterTests.cs" company="GSharp">
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
/// Issue #3813: a G# class deriving from an imported CLR base may write that
/// base's <c>protected</c> property, exactly as C# does.
/// <para>
/// <c>ClrMemberVisibility</c> (issue #3705) admits only <c>public</c> and
/// friend-<c>internal</c> accessors, and every write path routed its
/// settable-ness question through it — including the paths whose own comments
/// promise inherited <c>protected</c> members (issues #319/#1582, which already
/// delivered it for <c>protected</c> <em>fields</em>). A
/// <c>{ get; protected set; }</c> base property was therefore reported
/// <c>GS0127 "read-only and cannot be assigned to"</c> inside the derived type's
/// own constructor.
/// </para>
/// <para>
/// This is one of the two errors walling
/// <c>bench/concurrency/clr/ClrBaseline</c> out of the issue #3501
/// self-migration gate: its <c>GoChan&lt;T&gt; : Channel&lt;T&gt;</c> constructor
/// writes <c>Reader</c> and <c>Writer</c>, whose setters
/// <c>System.Threading.Channels.Channel&lt;T&gt;</c> declares
/// <c>protected</c>.
/// </para>
/// <para>
/// Every case EXECUTES. Binding alone cannot see whether the emitted
/// <c>call</c>/<c>callvirt</c> to a <c>family</c> setter is the right slot, and
/// a wrong one is still verifiable IL; only running the program observes the
/// value that was actually stored.
/// </para>
/// </summary>
public class Issue3813InheritedProtectedSetterTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The ClrBaseline shape, reduced: a derived channel installs its own
        // reader/writer through the base's `protected set` accessors, and the
        // value written must be observable through the BASE-typed reference —
        // i.e. the setter really wrote the base's backing slot.
        yield return new object[]
        {
            "protected-setter-through-bare-name",
            @"
package P
import System
import System.Threading
import System.Threading.Channels

class Wrap : Channel[int32] {
    init(inner Channel[int32]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[int32]()
let w = Wrap(inner)
let asBase Channel[int32] = w
asBase.Writer.TryWrite(41)
var got = 0
if asBase.Reader.TryRead(&got) {
    Console.WriteLine((got + 1).ToString())
}
",
            new[] { "42" },
        };

        // The `this.`-qualified spelling takes a different binder path than the
        // bare name; both must agree.
        yield return new object[]
        {
            "protected-setter-through-this",
            @"
package P
import System
import System.Threading
import System.Threading.Channels

class Wrap : Channel[string] {
    init(inner Channel[string]) {
        this.Reader = inner.Reader
        this.Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[string]()
let w = Wrap(inner)
let asBase Channel[string] = w
asBase.Writer.TryWrite(""hi"")
var got = """"
if asBase.Reader.TryRead(&got) {
    Console.WriteLine(got)
}
",
            new[] { "hi" },
        };
    }

    /// <summary>
    /// Gets the cases that must still be REJECTED, so the fix widens exactly
    /// the inherited-protected hole and nothing else. Each is (name, source).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // ANTI-VACUITY: a genuinely get-only inherited property is still
        // read-only. `Task.IsCompleted` has no setter at all.
        yield return new object[]
        {
            "get-only-inherited-property-still-rejected",
            @"
package P
import System
import System.Threading.Tasks

class Bad : TaskCompletionSource {
    func Break() {
        this.Task = nil
    }
}

Console.WriteLine(""unreachable"")
",
        };

        // ANTI-VACUITY: `protected` stays out of reach from a NON-derived type.
        // The widening is keyed on the inherited-base write paths only.
        yield return new object[]
        {
            "protected-setter-not-reachable-from-outside",
            @"
package P
import System
import System.Threading.Channels

func Break(c Channel[int32]) {
    c.Reader = nil
}

Console.WriteLine(""unreachable"")
",
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
    public void InheritedProtectedSetter_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3813_").FullName;
        try
        {
            var outPath = CompileOrThrow(tempDir, name, source);
            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(
                exit == 0,
                $"'{name}' must run to completion. Exit {exit}:\n{output}");

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
    /// Asserts the guard rails: writes the fix must NOT have opened up.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void UnreachableSetter_IsStillRejected(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3813_neg_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(
                exit != 0,
                $"'{name}' must NOT compile — the #3813 widening is scoped to inherited "
                    + $"protected accessors on the derived type's own base.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileOrThrow(string tempDir, string name, string source)
    {
        var (exit, stdout, stderr) = Compile(tempDir, name, source);
        Assert.True(exit == 0, $"gsc failed for '{name}':\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return Path.Combine(tempDir, name + ".dll");
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
