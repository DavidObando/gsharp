// <copyright file="Issue6231DefineCommandLineTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.IO
import System.Reflection
import Xunit

open class Issue6231DefineCommandLineTests {
    @Fact
    func DefinesAccumulateThroughResponseFilesWithoutChangingCase() {
        let directory = Path.Combine(Path.GetTempPath(), "gsharp-symbol-driver-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "Program.gs")
            let output = Path.Combine(directory, "Probe.dll")
            let response = Path.Combine(directory, "symbols.rsp")
            File.WriteAllText(source, `shared class Probe {
    func Value() bool -> @defined("DEBUG") && @defined("TRACE") && !@defined("debug")
}
`)
            File.WriteAllLines(response, []string{"/d:TRACE"})
            let result = Program.Main(
                []string{source, "/target:library", "/out:" + output, "/define:DEBUG", "@" + response}
            )
            Assert.Equal(0, result)
            let assembly = Assembly.Load(File.ReadAllBytes(output))
            Assert.Equal(true, assembly.GetType("Probe")!!.GetMethod("Value")!!.Invoke(nil, nil))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("/define")
    @InlineData("/d:")
    @InlineData("/define: ")
    func MissingDefineValueIsACommandLineError(option string) {
        Assert.NotEqual(0, Program.Main([]string{option}))
    }

    @Fact
    func InvalidDefineNamesAreWarningsAndHonorGlobalPromotion() {
        let directory = Path.Combine(Path.GetTempPath(), "gsharp-symbol-driver-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let source = Path.Combine(directory, "Program.gs")
            File.WriteAllText(source, "shared class Probe { func Value() bool -> @defined(\"VALID\") }\n")
            let output = Path.Combine(directory, "Probe.dll")
            Assert.Equal(0, Program.Main([]string{source, "/target:library", "/out:" + output, "/d:VALID,bad-name"}))
            Assert.True(File.Exists(output))
            File.Delete(output)
            Assert.NotEqual(
                0,
                Program.Main(
                    []string{source, "/target:library", "/out:" + output, "/d:VALID,bad-name", "/warnaserror+"}
                )
            )
            Assert.False(File.Exists(output))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }
}
