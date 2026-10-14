// <copyright file="Issue2642NullableInheritedImportedPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import Xunit

class Issue2642NullableInheritedImportedPropertyEmitTests {
    @Fact
    func OahuSettings_NullConditionalImportedBaseProperty_Runs() {
        const librarySource = `package Issue2642.Ref

open class UserSettingsBase {
    prop DownloadSettings string {
        get -> "2642"
    }
}`
        const consumerSource = `package Issue2642.App
import System
import Issue2642.Ref

class OahuUserSettings : UserSettingsBase { }

class CoreEnvironment {
    shared {
        var settings OahuUserSettings?
        func Read() string? -> CoreEnvironment.settings?.DownloadSettings
        func Set() { CoreEnvironment.settings = OahuUserSettings{} }
    }
}

Console.WriteLine(CoreEnvironment.Read())
CoreEnvironment.Set()
Console.WriteLine(CoreEnvironment.Read())`
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2642", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let libraryPath = Compile(directory, "Issue2642.Ref", librarySource, isLibrary: true)
            let consumerPath = Compile(directory, "Issue2642.App", consumerSource, isLibrary: false, libraryPath)
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(consumerPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(consumerPath)
            using let process Process? = Process.Start(startInfo)
            let stdout = process!!.StandardOutput.ReadToEnd()
            let stderr = process!!.StandardError.ReadToEnd()
            Assert.True(process!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(process!!.ExitCode == 0, (`exited ` + "${process!!.ExitCode}" + `
` + "$stderr"))
            Assert.Equal(
                "${Environment.NewLine}2642${Environment.NewLine}",
                stdout.ReplaceLineEndings(Environment.NewLine)
            )
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func Compile(
            directory string,
            assemblyName string,
            source string,
            isLibrary bool,
            reference string? = nil
        ) string {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                if isLibrary {
                    "/target:library"
                } else {
                    "/target:exe"
                },
                "/targetframework:net10.0"
            }
            if reference != nil {
                args.Add("/reference:" + reference)
            }
            args.Add(sourcePath)
            Assert.Equal(0, Program.Main(args.ToArray()))
            return outputPath
        }
    }
}
