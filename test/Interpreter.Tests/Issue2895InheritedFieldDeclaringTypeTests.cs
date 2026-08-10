// <copyright file="Issue2895InheritedFieldDeclaringTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2895: Emitted-execution coverage for inherited field declaring type.
/// </summary>
[Collection("ConsoleIo")]
public class Issue2895InheritedFieldDeclaringTypeTests
{
    [Theory]
    [InlineData("TopLevel", """
        import System

        open class Base { internal var value int32 }
        class Derived[T] : Base { }

        let item = Derived[string]()
        item.value = 121
        Console.WriteLine(item.value)
        """, "121\n")]
    [InlineData("Function", """
        import System

        open class Base { internal var value int32 }
        class Derived[T] : Base { }

        func Run() int32 {
            let item = Derived[string]()
            item.value = 122
            return item.value
        }

        Console.WriteLine(Run())
        """, "122\n")]
    public void InheritedFieldAccessRuns(string name, string source, string expected)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue2895InheritedFieldDeclaringTypeTests),
            name);
        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        File.WriteAllText(sourcePath, source);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        int exitCode;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            exitCode = GSharp.Repl.Program.Main(new[] { sourcePath });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.Equal(0, exitCode);
        Assert.Equal(expected, stdout.ToString().ReplaceLineEndings(Environment.NewLine));
        Assert.Equal(string.Empty, stderr.ToString());
    }
}
