// <copyright file="Issue2638TypedForEachTranslationTests.cs" company="GSharp">
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
import Xunit

class Issue2638TypedForEachTranslationTests {
    @Fact
    func OahuFileSecurityLoop_PreservesExplicitElementCast() {
        const source = `using System;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Oahu.Cli.Server.Auth;

public static class TokenStore
{
    public static void RemoveCurrent(FileSecurity sec)
    {
        var current = sec.GetAccessRules(true, true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule r in current)
        {
            sec.RemoveAccessRule(r);
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("TokenStore.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("for r FileSystemAccessRule in current", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("__foreach", printed, StringComparison.Ordinal)
        Assert.Contains("sec.RemoveAccessRule(r)", printed, StringComparison.Ordinal)
        AssertTranslatedSourceCompiles(printed)
    }

    shared {
        private func AssertTranslatedSourceCompiles(source string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2638TypedForEachTranslationTests")
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "TokenStore.gs")
            let outputPath = Path.Combine(directory, "TokenStore.dll")
            File.WriteAllText(sourcePath, source)
            let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
            Assert.True(File.Exists(compiler), "gsc.dll was not built.")
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            startInfo.ArgumentList.Add(compiler)
            startInfo.ArgumentList.Add("/target:library")
            startInfo.ArgumentList.Add("/targetframework:net10.0")
            startInfo.ArgumentList.Add("/out:" + outputPath)
            startInfo.ArgumentList.Add(sourcePath)
            using let process Process? = Process.Start(startInfo)
            let output = process!!.StandardOutput.ReadToEnd() + process!!.StandardError.ReadToEnd()
            process!!.WaitForExit()
            Assert.True(process!!.ExitCode == 0, output)
            Assert.DoesNotContain("GS0159", output, StringComparison.Ordinal)
        }
    }
}
