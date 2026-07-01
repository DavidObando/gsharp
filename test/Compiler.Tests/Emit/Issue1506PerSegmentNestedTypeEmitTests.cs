// <copyright file="Issue1506PerSegmentNestedTypeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1506 — a type clause naming a nested type of a <em>constructed</em>
/// generic (<c>List[int32].Enumerator</c>) must resolve, emit, and run in every
/// type-clause position. This end-to-end test declares such a type in local,
/// parameter, return, and field positions, drives a manual enumeration
/// (<c>MoveNext()</c>/<c>Current</c>), and asserts both correct output and
/// ilverify-clean IL. The BCL is supplied via explicit <c>/reference:</c>
/// entries (MetadataLoadContext) exactly like the corpus harness so the emitted
/// nested <c>TypeSpec</c> is exercised under the real reference-resolution path.
/// </summary>
public class Issue1506PerSegmentNestedTypeEmitTests
{
    [Fact]
    public void EndToEnd_NestedEnumeratorOfConstructedList_VerifiesAndRuns()
    {
        // Unique package/type/func names: the in-process FunctionTypeSymbol
        // cache is not cleared between tests, so names must not collide with
        // any other emit test.
        var source = """
            package Issue1506EmitProbe
            import System
            import System.Collections.Generic

            struct Issue1506Holder {
                var stash List[int32].Enumerator
            }

            func Issue1506SumViaParam(e List[int32].Enumerator) int32 {
                var total = 0
                while e.MoveNext() {
                    total = total + e.Current
                }
                return total
            }

            func Issue1506MakeEnumerator(values List[int32]) List[int32].Enumerator {
                return values.GetEnumerator()
            }

            func Main() {
                var values = List[int32]()
                values.Add(3)
                values.Add(4)
                values.Add(5)

                var localEnum List[int32].Enumerator = values.GetEnumerator()
                var localSum = 0
                while localEnum.MoveNext() {
                    localSum = localSum + localEnum.Current
                }

                var paramSum = Issue1506SumViaParam(Issue1506MakeEnumerator(values))

                var holder Issue1506Holder
                holder.stash = values.GetEnumerator()
                var fieldEnum = holder.stash
                var fieldSum = 0
                while fieldEnum.MoveNext() {
                    fieldSum = fieldSum + fieldEnum.Current
                }

                Console.WriteLine(localSum)
                Console.WriteLine(paramSum)
                Console.WriteLine(fieldSum)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("12\n12\n12\n", output);
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1506_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            // Pass the shared-framework assemblies as explicit `/reference:`
            // entries so gsc loads the BCL through a MetadataLoadContext, matching
            // the corpus harness and exercising the real nested-TypeSpec path.
            var frameworkReferences = FrameworkReferencePaths();

            var args = new List<string>
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
            };
            args.AddRange(frameworkReferences.Select(r => "/reference:" + r));
            args.Add(srcPath);

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
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
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
            }

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IReadOnlyList<string> FrameworkReferencePaths()
    {
        var runtimeDir = RuntimeEnvironment.GetRuntimeDirectory();
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();
    }
}
