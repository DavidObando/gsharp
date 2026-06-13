// <copyright file="Issue729FriendlyNumericAliasEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #729 / ADR-0098 — friendly numeric type aliases (<c>int</c>,
/// <c>long</c>, <c>byte</c>, …) compile, IL-verify, and run identically
/// to their canonical width-bearing spellings (<c>int32</c>, <c>int64</c>,
/// <c>uint8</c>, …). For every alias we compile one program written in
/// aliases and one written in canonical names, then assert byte-identical
/// IL (PE body image) between them. This is the strongest possible
/// demonstration that aliases resolve in the binder and that nothing
/// alias-specific reaches the emitter.
/// </summary>
public class Issue729FriendlyNumericAliasEmitTests
{
    public static IEnumerable<object[]> AliasCases => new[]
    {
        new object[] { "int", "int32", "42", "42" },
        new object[] { "uint", "uint32", "uint32(42)", "uint32(42)" },
        new object[] { "long", "int64", "42L", "42L" },
        new object[] { "ulong", "uint64", "42UL", "42UL" },
        new object[] { "short", "int16", "int16(42)", "int16(42)" },
        new object[] { "ushort", "uint16", "uint16(42)", "uint16(42)" },
        new object[] { "byte", "uint8", "uint8(42)", "uint8(42)" },
        new object[] { "sbyte", "int8", "int8(42)", "int8(42)" },
        new object[] { "float", "float32", "1.5F", "1.5F" },
        new object[] { "double", "float64", "1.5", "1.5" },
    };

    [Theory]
    [MemberData(nameof(AliasCases))]
    public void Alias_AndCanonical_Compile_VerifyAndRun(string alias, string canonical, string aliasLiteral, string canonicalLiteral)
    {
        // Each program declares a function `pair(x, y) -> x + y` with both
        // parameters typed by the alias (resp. canonical) name, sums two
        // literals of the matching type, then prints the result. Both
        // programs must produce the same observable output AND identical
        // .text PE body bytes — confirming that aliases erase to the
        // canonical type before reaching the emitter.
        var aliasSource = $@"
package P
import System

func pair(x {alias}, y {alias}) {alias} {{ return x + y }}

Console.WriteLine(pair({aliasLiteral}, {aliasLiteral}))
";
        var canonicalSource = $@"
package P
import System

func pair(x {canonical}, y {canonical}) {canonical} {{ return x + y }}

Console.WriteLine(pair({canonicalLiteral}, {canonicalLiteral}))
";

        var (aliasOutput, aliasIl) = CompileVerifyAndRun(aliasSource, "alias");
        var (canonicalOutput, canonicalIl) = CompileVerifyAndRun(canonicalSource, "canonical");

        Assert.Equal(canonicalOutput, aliasOutput);

        // Byte-identical .text body bytes confirm aliases resolve in the
        // binder to the exact same TypeSymbol that the emitter would have
        // received from the canonical name.
        Assert.Equal(canonicalIl, aliasIl);
    }

    [Fact]
    public void Mixed_AliasAndCanonical_Interoperate_AtRuntime()
    {
        // A sample that intentionally mixes aliases and canonical names
        // across function boundaries demonstrates equivalence at the call
        // site without any explicit conversion. Output is a single line so
        // the assertion is exact.
        const string source = @"
package P
import System

func sumCanonical(a int32, b int32) int32 { return a + b }
func sumAlias(a int, b int) int { return sumCanonical(a, b) }

let x int = sumCanonical(2, 3)
let y int32 = sumAlias(x, 4)

Console.WriteLine(y)
";

        var (output, _) = CompileVerifyAndRun(source, "mixed");
        Assert.Equal("9\n", output);
    }

    private static (string Output, byte[] PeBody) CompileVerifyAndRun(string source, string tag)
    {
        var tempDir = Directory.CreateTempSubdirectory($"gs_issue729_{tag}_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                srcPath,
            };

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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            // Extract method bodies (the IL inside `.text`) so we can
            // compare two alias-vs-canonical runs byte-for-byte. We hash
            // every method body because PE metadata contains tokens that
            // intentionally differ across compilations (timestamps, GUIDs,
            // assembly-name string offsets, etc.).
            var bodyBytes = ExtractAllMethodBodyBytes(outPath);

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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return (stdout.Replace("\r\n", "\n"), bodyBytes);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static byte[] ExtractAllMethodBodyBytes(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();

        // Walk every MethodDef in MetadataToken order and append its IL
        // body bytes. We deliberately ignore the body header (locals
        // signature token, max-stack flags, …) because the locals
        // signature index references the StandAloneSig table whose token
        // value is implementation-stable for these tiny programs — but if
        // it ever diverged the difference would not represent a real
        // emit-level change.
        using var ms = new MemoryStream();
        foreach (var handle in md.MethodDefinitions)
        {
            var def = md.GetMethodDefinition(handle);
            if (def.RelativeVirtualAddress == 0)
            {
                continue;
            }

            var body = pe.GetMethodBody(def.RelativeVirtualAddress);
            var il = body.GetILBytes();
            if (il == null)
            {
                continue;
            }

            ms.Write(il, 0, il.Length);
        }

        return ms.ToArray();
    }
}
