// <copyright file="Issue4246ReverseEnumArrayCastTests.cs" company="GSharp">
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
/// Issue #4246: at c6ba1c17 (the commit the issue's evidence was captured
/// against), an enum-typed array could not convert to <c>object</c>
/// (<c>GS0155</c>) — reported and fixed forward by #4249 / commit
/// <c>30445de1</c>, which added a single implicit-conversion arm to
/// <c>Conversion.cs</c>: <c>from is SliceTypeSymbol or ArrayTypeSymbol &amp;&amp;
/// to.ClrType == typeof(object) → Implicit</c>. #4249's own commit message
/// says the REVERSE cast (<c>object</c> back to a same-compilation enum
/// array) "remains separate" and was deliberately not touched.
///
/// Measured against current <c>main</c>, the reverse cast already works —
/// in every spelling G# has for it (<c>as</c> + <c>!!</c>, an <c>is</c>
/// pattern, and the <c>T(x)</c> explicit-conversion-call form) — and was
/// independently confirmed broken (<c>GS0155</c>, at the <c>var boxed
/// object = values</c> line, before the reverse line is even reached) when
/// built at c6ba1c17. The explanation: G#, like C#, defines an explicit
/// conversion to exist between A and B whenever an implicit conversion
/// exists in EITHER direction (ECMA-335 / the C# spec's explicit-conversion
/// closure over implicit conversions) — so #4249's one-directional implicit
/// widening fix silently unlocked the explicit narrowing cast the other
/// way, contrary to its own commit message. This closes the issue's
/// remaining gap with the requested same-compilation/imported controls
/// (no product code change: the fix already landed as a side effect of
/// #4249).
/// </summary>
public class Issue4246ReverseEnumArrayCastTests
{
    public static IEnumerable<object[]> Cases()
    {
        // (case name, enum-array source, expected first-element stdout)
        yield return new object[]
        {
            "same-compilation-as-bang-bang",
            """
            import System
            enum Kind { First = 7 }
            let values = []Kind{Kind.First}
            var boxed object = values
            let back = (boxed as []Kind)!!
            Console.WriteLine(back[0])
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "7", "Kind[]" },
        };

        yield return new object[]
        {
            "same-compilation-is-pattern",
            """
            import System
            enum Kind { First = 7, Second = 9 }
            let values = []Kind{Kind.First, Kind.Second}
            var boxed object = values
            if boxed is []Kind arr {
                Console.WriteLine(arr[0])
                Console.WriteLine(arr[1])
            } else {
                Console.WriteLine("no match")
            }
            """,
            new[] { "7", "9" },
        };

        yield return new object[]
        {
            "same-compilation-explicit-conversion-call",
            """
            import System
            enum Kind { First = 7 }
            let values = []Kind{Kind.First}
            var boxed object = values
            let back = []Kind(boxed)
            Console.WriteLine(back[0])
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "7", "Kind[]" },
        };

        yield return new object[]
        {
            "same-compilation-empty-array",
            """
            import System
            enum Kind { First = 7 }
            let values = []Kind{}
            var boxed object = values
            let back = (boxed as []Kind)!!
            Console.WriteLine(back.Length)
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "0", "Kind[]" },
        };

        yield return new object[]
        {
            "imported-as-bang-bang",
            """
            import System
            let values = []DayOfWeek{DayOfWeek.Monday}
            var boxed object = values
            let back = (boxed as []DayOfWeek)!!
            Console.WriteLine(back[0])
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "Monday", "DayOfWeek[]" },
        };

        yield return new object[]
        {
            "imported-explicit-conversion-call",
            """
            import System
            let values = []DayOfWeek{DayOfWeek.Monday}
            var boxed object = values
            let back = []DayOfWeek(boxed)
            Console.WriteLine(back[0])
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "Monday", "DayOfWeek[]" },
        };

        // Primitive-array parity control: the reverse cast must behave the
        // same for a non-enum element type (no enum-specific regression).
        yield return new object[]
        {
            "primitive-explicit-conversion-call",
            """
            import System
            let values = []int32{7}
            var boxed object = values
            let back = []int32(boxed)
            Console.WriteLine(back[0])
            Console.WriteLine(back.GetType().Name)
            """,
            new[] { "7", "Int32[]" },
        };
    }

    /// <summary>
    /// Compiles each case, IL-verifies the emitted assembly, runs it, and
    /// asserts the program's own output — including the runtime
    /// <c>GetType().Name</c>, so a regression that silently widened the
    /// round-tripped array to its underlying integer type would fail
    /// (rather than only checking the numeric values, which survive that
    /// substitution unchanged).
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void ReverseEnumArrayCast_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4246_reverse_cast_").FullName;
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
