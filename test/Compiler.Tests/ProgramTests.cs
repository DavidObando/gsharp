// <copyright file="ProgramTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

public class ProgramTests
{
    [Fact]
    public void Main_NoArgs_ReturnsError()
    {
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(System.Array.Empty<string>());
            Assert.NotEqual(0, exit);
            Assert.Contains("Must specify", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
        }
    }

    [Fact]
    public void Main_MissingFile_ReturnsError()
    {
        using var err = new StringWriter();
        var prevErr = Console.Error;
        Console.SetError(err);
        try
        {
            var exit = Program.Main(new[] { "/nonexistent/does-not-exist.gs" });
            Assert.NotEqual(0, exit);
            Assert.Contains("Unable to find", err.ToString());
        }
        finally
        {
            Console.SetError(prevErr);
        }
    }

    [Fact]
    public void Main_ValidSample_ReturnsSuccess()
    {
        var sample = Path.Combine(Path.GetTempPath(), $"gs_test_{System.Guid.NewGuid():N}.gs");
        File.WriteAllText(sample, "package P\n\nfunc Main() {\n}\n");
        var originalCwd = Directory.GetCurrentDirectory();
        var tempCwd = Directory.CreateTempSubdirectory("gsc_test_").FullName;
        Directory.SetCurrentDirectory(tempCwd);
        using var outWriter = new StringWriter();
        using var errWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(outWriter);
        Console.SetError(errWriter);
        try
        {
            var exit = Program.Main(new[] { sample });
            Assert.Equal(0, exit);
            Assert.Contains("Success", outWriter.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            Directory.SetCurrentDirectory(originalCwd);
            try { Directory.Delete(tempCwd, recursive: true); } catch { }
            try { File.Delete(sample); } catch { }
        }
    }
}
