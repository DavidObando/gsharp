// <copyright file="Issue2085FieldLikeEventBareDeclarationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2085: simply declaring a field-like event of a user-declared named
/// delegate type (no assignment, no subscription) must emit add_X/remove_X
/// accessor bodies that verify cleanly. The CAS-loop's Delegate.Combine/Remove
/// call returns System.Delegate; the castclass back to the named delegate
/// type and the Interlocked.CompareExchange&lt;T&gt; instantiation must agree
/// with the locals' declared type, or ilverify reports StackUnexpected.
/// </summary>
public class Issue2085FieldLikeEventBareDeclarationEmitTests
{
    [Fact]
    public void BareNamedDelegateEventDeclaration_NoAssignment_Verifies()
    {
        var source = """
            package Issue2085Pkg
            import System

            type TickHandler = delegate func(count int32) void

            class Clock {
                public event Ticked TickHandler
            }

            func Main() {
            }
            """;

        CompileAndVerify(source);
    }

    private static void CompileAndVerify(string source)
    {
        var tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2085_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new System.Collections.Generic.List<string>
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

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);
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
