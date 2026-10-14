// <copyright file="Issue2646DeclarationPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

class Issue2646DeclarationPatternTranslationTests {
    @Fact
    func OahuNullableIntPattern_PreservesCodeIdentity() {
        let printed = Translate(`namespace Oahu.Cli
{
    public sealed class Program
    {
        public int Run(int? rewriteResult)
        {
            try
            {
                var rewriteCode = rewriteResult;
                if (rewriteCode is int code)
                {
                    return code;
                }
            }
            catch
            {
            }

            return -1;
        }
    }
}`)
        // ADR-0166 / issue #3409: `code` is a native G# pattern variable —
        // its own typed local assigned by the match itself, scoped to the
        // then-branch. It therefore still does not depend on flow narrowing of
        // `rewriteCode` surviving this enclosing try/block (issue #2646's whole
        // point), and the separate `var code int32` hoist plus narrowing
        // conversion (`code = int32(rewriteCode)`) is no longer needed. No
        // spill either (issue #3360): the scrutinee is read exactly once.
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.Contains("if rewriteCode is int32 code {", printed, StringComparison.Ordinal)
        Assert.Contains("return code", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("var code int32", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(rewriteCode)", printed, StringComparison.Ordinal)
        // `code` must keep its own identity, not become a smart-cast alias of
        // `rewriteCode`.
        Assert.DoesNotContain("let code = rewriteCode", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("return rewriteCode", printed, StringComparison.Ordinal)
    }

    @Fact
    func ValuePattern_NarrowsNamedBinderAcrossFollowingScope() {
        let printed = Translate(`namespace Demo
{
    public sealed class C
    {
        public int Read(object value)
        {
            if (value is int code)
            {
            }
            else
            {
                return -1;
            }

            code = code + 1;
            return code;
        }
    }
}`)
        Assert.Contains("var code int32", printed, StringComparison.Ordinal)
        // Issue #3360: `value` is a bare parameter — no spill needed.
        Assert.Contains("code = int32(value)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("return value", printed, StringComparison.Ordinal)
        Assert.Equal(
            "43${Environment.NewLine}-1",
            CompileAndRun(
                printed,
                "System.Console.WriteLine(C().Read(42))${Environment.NewLine}System.Console.WriteLine(C().Read(\"no\"))"
            ).Trim()
        )
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.Empty(context.Diagnostics)
            return GSharpPrinter.Print(unit)
        }

        private func CompileAndRun(printed string, entryPoint string) string {
            let compiler string? = FindCompiler()
            Assert.True(compiler != nil, "gsc.dll must be built before running this test.")
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-2646", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            let source = Path.Combine(directory, "Program.gs")
            let output = Path.Combine(directory, "Program.dll")
            File.WriteAllText(source, printed + Environment.NewLine + entryPoint + Environment.NewLine)
            let (compileExit, compileOutput) = Run("\"$compiler\" /target:exe /out:\"$output\" \"$source\"")
            Assert.True(compileExit == 0, compileOutput + Environment.NewLine + printed)
            let (runExit, runOutput) = Run("\"$output\"")
            Assert.True(runExit == 0, runOutput)
            return runOutput
        }

        private func Run(arguments string)(ExitCode int32, Output string) {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet", arguments){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                for configuration in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(directory.FullName, "out", "bin", configuration, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                directory = directory.Parent
            }
            return nil
        }
    }
}
