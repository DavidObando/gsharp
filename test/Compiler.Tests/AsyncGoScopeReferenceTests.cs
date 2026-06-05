// <copyright file="AsyncGoScopeReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression tests for #291: spawning an <c>async func</c> with <c>go</c>
/// inside a <c>scope</c> must (a) join the spawned <see cref="System.Threading.Tasks.Task"/>
/// before the scope completes and (b) emit valid IL for the go-thunk even when
/// the spawned func awaits an imported <c>Task&lt;T&gt;</c> instance method.
/// </summary>
/// <remarks>
/// The defect only manifests in <em>cross-targeting</em> compilations — those
/// passing explicit <c>/reference</c> paths, which load BCL types through a
/// <see cref="System.Reflection.MetadataLoadContext"/>. In that context the
/// resolved <c>System.Threading.Tasks.Task</c> has a different <see cref="Type"/>
/// identity than the gsc host's <c>Task</c>, so the old
/// <c>typeof(Task).IsAssignableFrom(...)</c> async detection returned false and
/// the go-thunk was emitted as an <c>Action</c> that discarded the spawned
/// <c>Task</c> (no join) and produced invalid IL when arguments were captured.
/// The default conformance harness compiles in the host context and therefore
/// cannot exercise this path, so this test drives the references path directly.
/// </remarks>
public class AsyncGoScopeReferenceTests
{
    [Fact]
    public void GoScope_AsyncFuncs_JoinAndEmitValidIl_UnderReferences()
    {
        // Covers both void-like (no value) and value-returning async funcs, and
        // an await on an imported Task<T> instance method (StringReader.ReadToEndAsync).
        const string source = @"
package Demo

import System
import System.IO
import System.Threading.Tasks

var reader = StringReader(""payload"")

async func readIt(r StringReader) {
    var text = await r.ReadToEndAsync()
    Console.WriteLine(""read=$text"")
}

async func makeValue() int32 {
    await Task.Delay(5)
    Console.WriteLine(""value=42"")
    return 42
}

scope {
    go readIt(reader)
    go makeValue()
}

Console.WriteLine(""done"")
";

        var tempDir = Directory.CreateTempSubdirectory("gs_async_go_ref_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Program.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
            };

            // Force the MetadataLoadContext reference path by passing the host's
            // own runtime assemblies as explicit references. These are always
            // present wherever the test runs.
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
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath, ignoredErrorCodes: IlVerifier.KnownIssues.AsyncStateMachine);
            Assert.True(File.Exists(outPath), "expected emitted assembly");

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
                $"sample exited {proc.ExitCode} (invalid IL would surface as InvalidProgramException)\nstdout:\n{stdout}\nstderr:\n{stderr}");

            var lines = stdout
                .Replace("\r\n", "\n")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries);

            // Both spawned async tasks must have run to completion (structured join)...
            Assert.Contains("read=payload", lines);
            Assert.Contains("value=42", lines);

            // ...and the scope must join before the trailing top-level statement,
            // so "done" is the final line emitted.
            Assert.Equal("done", lines[^1]);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
