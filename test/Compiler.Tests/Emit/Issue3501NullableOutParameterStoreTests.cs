// <copyright file="Issue3501NullableOutParameterStoreTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3501: assigning through an <c>out</c>/<c>ref</c> parameter of
/// value-type nullable type (<c>out x int32?</c>) emitted <c>stind.i4</c>
/// instead of <c>stobj Nullable&lt;int32&gt;</c> — NullableTypeSymbol borrows
/// the UNDERLYING type's ClrType, so the indirect-store opcode selection saw
/// a bare int (ilverify StackUnexpected; hit by the migrated Translator's
/// <c>TryClassifyStructInitializerValue</c>). Load and store indirection now
/// route value-type nullables through ldobj/stobj.
/// </summary>
public class Issue3501NullableOutParameterStoreTests
{
    [Fact]
    public void NullableIntOutParameter_AssignsAndReads()
    {
        const string Source = """
            package Issue3501
            import System

            func TryPick(value int32, out ordinal int32?) bool {
                if value > 0 {
                    ordinal = value
                    return true
                }
                ordinal = nil
                return false
            }

            func Main() {
                var slot int32? = nil
                if TryPick(7, out slot) {
                    Console.WriteLine(slot!!.ToString())
                }
                var missing int32? = 3
                if !TryPick(-1, out missing) {
                    Console.WriteLine((missing == nil).ToString())
                }
            }
            """;

        Assert.Equal($"7{Environment.NewLine}True{Environment.NewLine}", CompileAndRun(Source));
    }

    private static string CompileAndRun(string source)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, "issue3501nullout", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        try
        {
            var sourcePath = Path.Combine(outputDirectory, "Program.gs");
            var outputPath = Path.Combine(outputDirectory, "Issue3501NullOut.dll");
            File.WriteAllText(sourcePath, source);

            using var standardOut = new StringWriter();
            using var standardError = new StringWriter();
            var previousOut = Console.Out;
            var previousError = Console.Error;
            Console.SetOut(standardOut);
            Console.SetError(standardError);
            int exitCode;
            try
            {
                exitCode = Program.Main(new[]
                {
                    "/out:" + outputPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    sourcePath,
                });
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousError);
            }

            Assert.True(
                exitCode == 0,
                $"gsc failed:\nstdout:\n{standardOut}\nstderr:\n{standardError}");
            IlVerifier.Verify(outputPath);
            var assembly = Assembly.Load(File.ReadAllBytes(outputPath));
            _ = assembly.GetTypes();
            var entryPoint = assembly.EntryPoint
                ?? throw new InvalidOperationException("Emitted assembly has no entry point.");

            previousOut = Console.Out;
            using var output = new StringWriter();
            Console.SetOut(output);
            try
            {
                entryPoint.Invoke(
                    null,
                    entryPoint.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previousOut);
            }

            return output.ToString();
        }
        finally
        {
            try
            {
                Directory.Delete(outputDirectory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
