// <copyright file="Issue4241NullableStructAsExpressionEmitTests.cs" company="GSharp">
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
/// Issue #4241: <c>boxed as Item?</c> over a same-compilation user struct
/// skipped <c>unbox.any</c> entirely — <c>EmitAsExpression</c>'s
/// nullable-value-target probe checked the underlying type's <c>ClrType</c>,
/// which is always <see langword="null"/> for a same-compilation struct/enum
/// during emit, so the <c>isinst</c> result (a boxed-object reference, or
/// null) was stored directly into the <c>Nullable&lt;Item&gt;</c>-typed spill
/// slot. The pointer's raw bytes were then reinterpreted as the struct's own
/// fields, corrupting every subsequent read (observed as a value that
/// changed across runs). The fix widens the probe to
/// <c>NullableLifting.IsAnyValueTypeNullable</c>, matching the predicate
/// <c>GetElementTypeToken</c> and the <c>!!</c>-unwrap slot planner already
/// use for this exact shape.
/// </summary>
public class Issue4241NullableStructAsExpressionEmitTests
{
    private const string DirectStructRoundtripSource = """
        import System
        struct Item { var Value int32 }
        var item = Item{Value: 6}
        var boxed object = item
        let restored = (boxed as Item?)!!
        Console.WriteLine(item.Value)
        Console.WriteLine(restored.Value)
        """;

    // Same defect shape as the struct case — an enum's underlying is also a
    // same-compilation symbolic value type with a null ClrType during emit,
    // and NullableLifting.IsUserValueTypeNullable/IsAnyValueTypeNullable
    // deliberately unify EnumSymbol with a non-class StructSymbol.
    private const string DirectEnumRoundtripSource = """
        import System
        enum Item { First = 6 }
        var item = Item.First
        var boxed object = item
        let restored = (boxed as Item?)!!
        Console.WriteLine(int32(item))
        Console.WriteLine(int32(restored))
        """;

    /// <summary>
    /// Gets the executable cases: each is (case name, source, temp-dir prefix).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        yield return new object[] { "struct", DirectStructRoundtripSource, "gs_4241_direct_struct_" };
        yield return new object[] { "enum", DirectEnumRoundtripSource, "gs_4241_direct_enum_" };
    }

    /// <summary>
    /// The exact repro from issue #4241 (plus an enum variant covering the
    /// same <c>NullableLifting.IsUserValueTypeNullable</c> predicate):
    /// compiles, IL-verifies, and runs the program, asserting both the
    /// original and the round-tripped value read the same, unmangled value.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="tempDirPrefix">The temp-directory name prefix.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void ObjectToNullableUserValueType_RoundTripsFieldValue(string name, string source, string tempDirPrefix)
    {
        var tempDir = Directory.CreateTempSubdirectory(tempDirPrefix).FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "DirectRoundtrip.dll");

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

            // Run the emitted program twice: pre-fix the corrupted value was
            // an uninitialized pointer's low bytes, which differed run to
            // run — a single passing run would not have caught the defect.
            for (var i = 0; i < 2; i++)
            {
                var (exit, output) = RunDotnet(outPath);
                Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

                var lines = output
                    .Split('\n')
                    .Select(line => line.TrimEnd('\r'))
                    .Where(line => line.Length > 0)
                    .ToArray();
                Assert.Equal(new[] { "6", "6" }, lines);
            }
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
