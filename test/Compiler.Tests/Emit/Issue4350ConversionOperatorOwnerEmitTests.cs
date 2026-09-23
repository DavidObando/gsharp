// <copyright file="Issue4350ConversionOperatorOwnerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4350: an in-body conversion operator is owned by its ENCLOSING type,
/// as in C#. It used to be attached to the source type, which changed the
/// declaring type in metadata and, when the source type's own <c>shared</c>
/// block bound later, dropped the operator from the assembly entirely (the
/// migrated <c>ReadOnlySlice.op_Implicit(Slice)</c> vanished).
/// </summary>
public class Issue4350ConversionOperatorOwnerEmitTests
{
    private const string Inner = """
        package P

        struct Inner[T](Value T) {
            func AsView() View[T] -> View[T](this)

            shared {
                func Make(value T) Inner[T] -> Inner[T]{Value: value}
            }
        }
        """;

    private const string View = """
        package P
        import System

        struct View[T] {
            private let inner Inner[T]

            internal init(inner Inner[T]) {
                this.inner = inner
            }

            prop Value T -> inner.Value

            func operator implicit(value Inner[T]) View[T] -> value.AsView()
        }

        let view View[string] = Inner[string].Make("x")
        Console.WriteLine(view.Value)
        let viewType = typeof(View[string])
        let op = viewType.GetMethod("op_Implicit")
        Console.WriteLine(op?.DeclaringType == viewType)
        Console.WriteLine(typeof(Inner[string]).GetMethod("op_Implicit") == nil)
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void InBodyConversionOperator_IsDeclaredOnEnclosingType(bool sourceFileFirst)
    {
        var output = sourceFileFirst ? CompileAndRun(Inner, View) : CompileAndRun(View, Inner);
        Assert.Equal(Lines("x", "True", "True"), output);
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(params string[] sources)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_convowner_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "test.dll");
            var sourcePaths = new string[sources.Length];
            for (var i = 0; i < sources.Length; i++)
            {
                sourcePaths[i] = Path.Combine(tempDir, $"test{i}.gs");
                File.WriteAllText(sourcePaths[i], sources[i]);
            }

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                var compileArgs = new System.Collections.Generic.List<string>
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                };
                compileArgs.AddRange(sourcePaths);
                compileExit = Program.Main(compileArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

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

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
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
