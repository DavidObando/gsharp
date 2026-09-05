// <copyright file="Issue3956NamedTupleGenericArgumentIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3956 / ADR-0172: tuple element names are metadata over the positional
/// shape, so a generic instantiation recovered from a CLR signature
/// (<c>KeyValuePair&lt;string, ValueTuple&lt;…&gt;&gt;</c>) and the same
/// instantiation written in G# with element NAMES are one and the same type.
/// The binder classifies the conversion between them as identity; the emitter
/// used to key its identity fast path on symbol REFERENCE equality alone and
/// fell through every structural arm to a <c>NotSupportedException</c>.
/// <para>The names sit two levels deep — inside a <c>List</c>, inside a tuple,
/// inside a <c>KeyValuePair</c> — so a top-level-only fix does not pass these.
/// Every case COMPILES, ILVERIFIES and EXECUTES: an emitter defect of this kind
/// can bind clean and still produce a body the verifier or the runtime
/// rejects.</para>
/// </summary>
public sealed class Issue3956NamedTupleGenericArgumentIdentityTests
{
    /// <summary>
    /// The shape from the issue, verbatim: a LINQ call over a dictionary whose
    /// value type is a named tuple carrying a <c>List</c> of named tuples. The
    /// return type comes back from the CLR signature unnamed, and flows into a
    /// slot whose declared type carries every name.
    /// </summary>
    [Fact]
    public void NestedNamedTupleGenericArgument_ClrRecoveredKeyValuePair_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3956

            import System
            import System.Linq
            import System.Collections.Generic

            let blobs = Dictionary[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]()
            let awaits = List[(Yield int32, Resume int32, ResumeRid int32)]()
            awaits.Add((11, 22, 33))
            blobs["sum2"] = (7, 9, awaits)

            let only = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])]) bool {
                return kv.Key == "sum2"
            })

            Console.WriteLine(only.Value.Rid)
            Console.WriteLine(only.Value.CatchHandlerPlusOne)
            Console.WriteLine(only.Value.Awaits[0].Resume)
            """;

        Assert.Equal(
            $"7{Environment.NewLine}9{Environment.NewLine}22{Environment.NewLine}",
            CompileVerifyAndRun(Source));
    }

    /// <summary>
    /// The reverse direction: the CLR-recovered UNNAMED shape is the target and
    /// the named shape is the source. Names are metadata in both directions.
    /// </summary>
    [Fact]
    public void NestedNamedTupleGenericArgument_NamedSourceToUnnamedTarget_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3956

            import System
            import System.Linq
            import System.Collections.Generic

            let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
            let awaits = List[(Yield int32, Resume int32)]()
            awaits.Add((4, 5))
            blobs["a"] = (1, awaits)

            let only KeyValuePair[string, (int32, List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
                return kv.Key == "a"
            })

            Console.WriteLine(only.Value.Item1)
            Console.WriteLine(only.Value.Item2[0].Item2)
            """;

        Assert.Equal($"1{Environment.NewLine}5{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    /// <summary>
    /// A NESTED-ONLY name difference: both sides spell the outer tuple's names
    /// identically and differ only inside the <c>List</c> element two levels
    /// down. A fix that compares only the top-level tuple's names passes the
    /// cases above and fails this one.
    /// </summary>
    [Fact]
    public void NestedNamedTupleGenericArgument_InnerNamesOnly_CompileVerifyAndRun()
    {
        const string Source = """
            package Issue3956

            import System
            import System.Linq
            import System.Collections.Generic

            let blobs = Dictionary[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]()
            let awaits = List[(Yield int32, Resume int32)]()
            awaits.Add((6, 7))
            blobs["a"] = (2, awaits)

            let only KeyValuePair[string, (Rid int32, Awaits List[(int32, int32)])] = Enumerable.Single(blobs, func(kv KeyValuePair[string, (Rid int32, Awaits List[(Yield int32, Resume int32)])]) bool {
                return kv.Key == "a"
            })

            Console.WriteLine(only.Value.Rid)
            Console.WriteLine(only.Value.Awaits[0].Item1)
            """;

        Assert.Equal($"2{Environment.NewLine}6{Environment.NewLine}", CompileVerifyAndRun(Source));
    }

    private static string CompileVerifyAndRun(string source)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue3956NamedTupleGenericArgumentIdentityTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var sourcePath = Path.Combine(directory, "Program.gs");
            var outputPath = Path.Combine(directory, "Issue3956.dll");
            File.WriteAllText(sourcePath, source);

            var arguments = new List<string>
            {
                "/out:" + outputPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            foreach (var reference in ReferenceResolver.HostTrustedPlatformAssemblyPaths())
            {
                arguments.Add("/r:" + reference);
            }

            arguments.Add(sourcePath);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(arguments.ToArray());
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(exitCode == 0, $"gsc failed:{Environment.NewLine}{standardOut}{standardError}");
            IlVerifier.Verify(outputPath);

            using var process = Process.Start(new ProcessStartInfo("dotnet")
            {
                ArgumentList =
                {
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(outputPath, ".runtimeconfig.json"),
                    outputPath,
                },
                WorkingDirectory = directory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            var output = process.StandardOutput.ReadToEnd();
            var error = process.StandardError.ReadToEnd();
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(process.ExitCode == 0, error);
            return output.ReplaceLineEndings(Environment.NewLine);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
