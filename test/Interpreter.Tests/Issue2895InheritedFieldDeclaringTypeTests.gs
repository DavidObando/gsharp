// <copyright file="Issue2895InheritedFieldDeclaringTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl
import System
import System.IO
import Xunit

/// Issue #2895: Emitted-execution coverage for inherited field declaring type.
@Collection("ConsoleIo")
open class Issue2895InheritedFieldDeclaringTypeTests {
    @Theory
    @InlineData("TopLevel", `import System

open class Base { internal var value int32 }
class Derived[T] : Base { }

let item = Derived[string]()
item.value = 121
Console.WriteLine(item.value)`, "121\n")
    @InlineData("Function", `import System

open class Base { internal var value int32 }
class Derived[T] : Base { }

func Run() int32 {
    let item = Derived[string]()
    item.value = 122
    return item.value
}

Console.WriteLine(Run())`, "122\n")
    func InheritedFieldAccessRuns(name string, source string, expected string) {
        let directory = Path.Combine(AppContext.BaseDirectory, "Issue2895InheritedFieldDeclaringTypeTests", name)
        Directory.CreateDirectory(directory)
        let sourcePath = Path.Combine(directory, "test.gs")
        File.WriteAllText(sourcePath, source)
        using let stdout = StringWriter()
        using let stderr = StringWriter()
        let previousOut = Console.Out
        let previousError = Console.Error
        var exitCode int32
        try {
            Console.SetOut(stdout)
            Console.SetError(stderr)
            exitCode = GSharp.Repl.Program.Main([]string{sourcePath})
        } finally {
            Console.SetOut(previousOut)
            Console.SetError(previousError)
        }
        Assert.Equal(0, exitCode)
        Assert.Equal(expected, stdout.ToString().ReplaceLineEndings(Environment.NewLine))
        Assert.Equal(string.Empty, stderr.ToString())
    }
}
