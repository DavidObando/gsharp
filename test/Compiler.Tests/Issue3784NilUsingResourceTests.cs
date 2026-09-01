// <copyright file="Issue3784NilUsingResourceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3784: a <c>using</c> resource that is legitimately <c>nil</c> must be
/// a no-op at cleanup, exactly as C#'s
/// <c>using (var s = cond ? null : File.Create(p))</c> is. Before the fix the
/// finally block issued an unconditional <c>Dispose()</c> and the statement
/// threw a <see cref="NullReferenceException"/> on the very path the language
/// defines as doing nothing.
/// <para>
/// This is the defect behind the migrated compiler's <c>GS9998</c>: the
/// self-migration translation of <c>src/Compiler/Program.cs</c> carries
/// <c>using let refStream = if string.IsNullOrEmpty(refOutputPath) {
/// default(FileStream?) } else { File.Create(refOutputPath!!) }</c> — three
/// such optional streams, one per <c>/refout</c>, <c>/pdb</c> and
/// <c>/doc</c> — so EVERY <c>gsc /out:</c> invocation of the MIGRATED compiler
/// faulted in the finally, whatever it was asked to compile.
/// </para>
/// <para>
/// Every case EXECUTES: the divergence is invisible to binding and to
/// ILVerify — the unguarded <c>callvirt</c> is perfectly verifiable IL — so
/// only running the program can see it.
/// </para>
/// </summary>
public class Issue3784NilUsingResourceTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The reduction of the defect: a nilable resource that IS nil.
        yield return new object[]
        {
            "nil-resource-is-a-no-op",
            @"
package P
import System
import System.IO

func Run() string {
    using let s FileStream? = nil
    return ""ran""
}

Console.WriteLine(Run())
",
            new[] { "ran" },
        };

        // The exact shape the migrated src/Compiler/Program.cs carries: a
        // conditional whose nil arm is spelled `default(T?)`, nested two deep
        // so the inner cleanup runs inside the outer protected region.
        yield return new object[]
        {
            "optional-stream-pair-both-nil",
            @"
package P
import System
import System.IO

func Emit(refPath string?, docPath string?) string {
    using let refStream = if string.IsNullOrEmpty(refPath) { default(FileStream?) } else { File.Create(refPath!!) }
    {
        using let docStream = if string.IsNullOrEmpty(docPath) { default(FileStream?) } else { File.Create(docPath!!) }
        return ""emitted""
    }
}

Console.WriteLine(Emit(nil, nil))
",
            new[] { "emitted" },
        };

        // ANTI-VACUITY: a real resource must still be disposed exactly once,
        // and the nil sibling in the same statement list must still be skipped.
        yield return new object[]
        {
            "real-resource-still-disposed-once",
            @"
package P
import System
import System.IO

class Probe {
    var Count int32 = 0

    func Dispose() {
        Count = Count + 1
        Console.WriteLine(""disposed"")
    }
}

let probe = Probe()

func Run(p Probe) string {
    using let a = p
    {
        using let b FileStream? = nil
        return ""body""
    }
}

Console.WriteLine(Run(probe))
Console.WriteLine(probe.Count.ToString())
",
            new[] { "disposed", "body", "1" },
        };

        // ANTI-VACUITY: an exception thrown inside the protected region still
        // reaches the caller, and the nil cleanup does not mask it with an NRE
        // of its own.
        yield return new object[]
        {
            "throw-through-a-nil-resource",
            @"
package P
import System
import System.IO

func Boom() {
    using let s FileStream? = nil
    throw InvalidOperationException(""boom"")
}

try {
    Boom()
} catch (ex InvalidOperationException) {
    Console.WriteLine(ex.Message)
}
",
            new[] { "boom" },
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output — the only assertion that can see this
    /// class of defect.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void NilUsingResource_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3784_").FullName;
        try
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
                $"gsc failed for '{name}':\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(
                exit == 0,
                $"'{name}' must run to completion (this is the #3784 assertion; a "
                    + $"NullReferenceException here is the unguarded nil cleanup). Exit {exit}:\n{output}");

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
