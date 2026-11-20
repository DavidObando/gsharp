// <copyright file="Issue6077MethodGroupAndNullableFieldDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// End-to-end `gsc` driver, ILVerify, and runtime checks for issue #6077.
class Issue6077MethodGroupAndNullableFieldDriverTests {
    @Fact
    func OriginalRepro_WithoutLinq_FailsDriverWithGS0158AndNotGS9998() {
        let log = CompileExpectingFailure(`package R
import System.Collections.Generic
class Bag {
    private var items List[string]?
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return ""
    }
}`, "/target:library")
        Assert.Contains("GS0158", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
    }

    @Fact
    func OriginalRepro_WithLinq_FailsDriverWithGS0582AndNotGS9998() {
        let log = CompileExpectingFailure(`package R
import System.Collections.Generic
import System.Linq
class Bag {
    private var items List[string]?
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return ""
    }
}`, "/target:library")
        Assert.Contains("GS0582", log, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", log, StringComparison.Ordinal)
    }

    @Fact
    func ImmutableLetAndLocalCopy_CompileIlVerifyAndExecute() {
        let lines = CompileVerifyAndRun(`package R
import System
import System.Collections.Generic

class LetBag {
    private let items List[string]?
    init(items List[string]?) { this.items = items }
    func Top() string {
        if items != nil && items.Count > 0 {
            let top = items[items.Count - 1]
            return top
        }
        return "empty"
    }
}

class VarBag {
    private var items List[string]?
    init(items List[string]?) { this.items = items }
    func Top() string {
        if let list = items {
            if list.Count > 0 {
                let top = list[list.Count - 1]
                return top
            }
        }
        return "empty"
    }
}

Console.WriteLine(LetBag(List[string]{"first", "last"}).Top())
Console.WriteLine(VarBag(List[string]{"one", "two"}).Top())
Console.WriteLine(VarBag(nil).Top())`)
        Assert.Equal([]string{"last", "two", "empty"}, lines)
    }

    shared {
        private func CreateWorkspaceDir(prefix string) string {
            let dir = Path.Combine(AppContext.BaseDirectory, prefix + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(dir)
            return dir
        }

        private func CompileVerifyAndRun(source string)[]string {
            let tempDir = CreateWorkspaceDir("gs_6077_pos_")
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let outPath = Path.Combine(tempDir, "Program.dll")
                let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                let (compileExit, compileLog) = RunCompiler(args)
                Assert.True(compileExit == 0, (`gsc failed:
` + "$compileLog"))
                IlVerifier.Verify(outPath)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc Process? = Process.Start(psi)
                let stdout = proc!!.StandardOutput.ReadToEnd()
                let stderr = proc!!.StandardError.ReadToEnd()
                Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                    Environment.NewLine,
                    StringSplitOptions.RemoveEmptyEntries
                )
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func CompileExpectingFailure(source string, targetArg string) string {
            let tempDir = CreateWorkspaceDir("gs_6077_neg_")
            try {
                let srcPath = Path.Combine(tempDir, "Program.gs")
                File.WriteAllText(srcPath, source)
                let args = List[string]{
                    "/out:" + Path.Combine(tempDir, "Program.dll"),
                    targetArg,
                    "/targetframework:net10.0",
                    srcPath
                }
                let (compileExit, compileLog) = RunCompiler(args)
                Assert.True(compileExit != 0, (`gsc unexpectedly succeeded:
` + "$compileLog"))
                return compileLog
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }

        private func RunCompiler(args List[string])(Exit int32, Log string) {
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                let exit = Program.Main(args.ToArray())
                return (exit, compileOut.ToString() + "\n" + compileErr.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
        }
    }
}
