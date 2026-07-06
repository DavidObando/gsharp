// <copyright file="ResxCodeGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.Resx;
using Xunit;

namespace GSharp.Core.Tests.Resx;

public class ResxCodeGeneratorTests : IDisposable
{
    private readonly string tempDirectory;

    public ResxCodeGeneratorTests()
    {
        this.tempDirectory = Path.Combine(Path.GetTempPath(), "gsharp-resx-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.tempDirectory);
    }

    [Fact]
    public void GetDesignerFilePath_UsesDesignerGsSuffix()
    {
        string resxPath = Path.Combine(this.tempDirectory, "Resources.resx");
        string designerPath = ResxCodeGenerator.GetDesignerFilePath(resxPath);

        Assert.Equal(Path.Combine(this.tempDirectory, "Resources.Designer.gs"), designerPath);
    }

    [Fact]
    public void GenerateFromFile_ResxAtProjectRoot_UsesRootNamespaceOnly()
    {
        string resxPath = Path.Combine(this.tempDirectory, "Resources.resx");
        File.WriteAllText(resxPath, MinimalResx);

        string source = ResxCodeGenerator.GenerateFromFile(resxPath, this.tempDirectory, "Oahu.Core");

        Assert.Contains("package Oahu.Core", source);
        Assert.Contains("\"Oahu.Core.Resources\"", source);
    }

    [Fact]
    public void GenerateFromFile_ResxInSubfolder_AppendsFolderToNamespace()
    {
        string subfolder = Path.Combine(this.tempDirectory, "Properties");
        Directory.CreateDirectory(subfolder);
        string resxPath = Path.Combine(subfolder, "Resources.resx");
        File.WriteAllText(resxPath, MinimalResx);

        string source = ResxCodeGenerator.GenerateFromFile(resxPath, this.tempDirectory, "Oahu.Core");

        Assert.Contains("package Oahu.Core.Properties", source);
        Assert.Contains("\"Oahu.Core.Properties.Resources\"", source);
    }

    private const string MinimalResx = """
        <?xml version="1.0" encoding="utf-8"?>
        <root>
          <data name="Greeting" xml:space="preserve">
            <value>Hello</value>
          </data>
        </root>
        """;

    public void Dispose()
    {
        try
        {
            Directory.Delete(this.tempDirectory, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
