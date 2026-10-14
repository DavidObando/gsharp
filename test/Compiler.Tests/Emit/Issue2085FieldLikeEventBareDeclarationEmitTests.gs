// <copyright file="Issue2085FieldLikeEventBareDeclarationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #2085: simply declaring a field-like event of a user-declared named
/// delegate type (no assignment, no subscription) must emit add_X/remove_X
/// accessor bodies that verify cleanly. The CAS-loop's Delegate.Combine/Remove
/// call returns System.Delegate; the castclass back to the named delegate
/// type and the Interlocked.CompareExchange<T> instantiation must agree
/// with the locals' declared type, or ilverify reports StackUnexpected.
open class Issue2085FieldLikeEventBareDeclarationEmitTests {
    @Fact
    func BareNamedDelegateEventDeclaration_NoAssignment_Verifies() {
        let source = `package Issue2085Pkg
import System

delegate TickHandler(count int32) void;

class Clock {
    public event Ticked TickHandler
}

func Main() {
}`
        CompileAndVerify(source)
    }

    shared {
        private func CompileAndVerify(source string) {
            let tempDir = Path.Combine(AppContext.BaseDirectory, "Issue2085_" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(tempDir)
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    "/nowarn:GS9100",
                    srcPath
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(args.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
