// <copyright file="Issue1107OutVarUserTypeErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1107: an inline <c>out var</c> argument bound against a generic by-ref
/// parameter whose pointee is a type-level type parameter — e.g. the
/// <c>out TValue</c> of <c>Dictionary&lt;TKey, TValue&gt;.TryGetValue</c> — was
/// typed from the type-erased closed CLR shape (<c>out object</c>) when the
/// receiver's generic argument is a <em>same-compilation</em> user type. The
/// out-var local therefore bound as <c>object</c> and any subsequent member
/// access on it failed with <c>GS0158</c>.
/// <para>
/// This is the by-ref-parameter counterpart of the generic-method return-type
/// erasure fixed for #1100 (PR #1102): the return path was recovered in
/// <c>ResolveInstanceReturnTypeFromReceiver</c>, but the by-ref parameter path
/// in <c>RebindInlineOutVarArguments</c> (#977) still derived the out-var
/// pointee from the erased closed shape. The new
/// <c>ResolveInstanceParameterPointeeTypeFromReceiver</c> re-projects the open
/// declaring type's parameter pointee through the receiver's symbolic type
/// arguments, recovering the user element type. These tests compile, IL-verify,
/// and actually run the shape end-to-end.
/// </para>
/// </summary>
public class Issue1107OutVarUserTypeErasureEmitTests
{
    [Fact]
    public void DictionaryOfUserClass_TryGetValueOutVar_Compiles_And_Runs()
    {
        // The headline repro: `Dictionary[string, Entry].TryGetValue(key, out var
        // found)` must bind `found` as `Entry` (not erased `object`) so the
        // subsequent `found.V` resolves (no GS0158), and the program runs.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Entry { var V int32 }

            class C {
                private let d Dictionary[string, Entry] = Dictionary[string, Entry]()
                func Put(key string, e Entry) { d[key] = e }
                func TryGet(key string) int32 {
                    var ok = d.TryGetValue(key, out var found)
                    if ok { return found.V }
                    return -1
                }
            }

            var c = C()
            var a = Entry()
            a.V = 42
            c.Put("k", a)
            Console.WriteLine(c.TryGet("k"))
            Console.WriteLine(c.TryGet("missing"))
            """;

        Assert.Equal("42\n-1\n", CompileAndRun(source));
    }

    [Fact]
    public void DictionaryOfUserDataStruct_TryGetValueOutVar_Compiles_And_Runs()
    {
        // Value-type user argument: `found` must bind as the `Item` struct (not
        // `object`), so `found.Price` resolves and no spurious unbox is emitted.
        var source = """
            package P
            import System
            import System.Collections.Generic

            data struct Item(Name string, Price int32)

            class C {
                private let d Dictionary[string, Item] = Dictionary[string, Item]()
                func Put(key string, i Item) { d[key] = i }
                func TryTotal(key string) int32 {
                    var ok = d.TryGetValue(key, out var found)
                    if ok { return found.Price }
                    return -1
                }
            }

            var c = C()
            c.Put("a", Item{Name: "a", Price: 42})
            Console.WriteLine(c.TryTotal("a"))
            Console.WriteLine(c.TryTotal("missing"))
            """;

        Assert.Equal("42\n-1\n", CompileAndRun(source));
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue1107_emit_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }
}
