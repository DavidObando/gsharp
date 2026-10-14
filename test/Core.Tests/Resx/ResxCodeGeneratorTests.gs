// <copyright file="ResxCodeGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Resx

import GSharp.Core.Resx
import System
import System.IO
import Xunit

open class ResxCodeGeneratorTests : IDisposable {
    private let tempDirectory string

    init() {
        this.tempDirectory = Path.Combine(Path.GetTempPath(), "gsharp-resx-tests-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.tempDirectory)
    }

    @Fact
    func GetDesignerFilePath_UsesDesignerGsSuffix() {
        let resxPath = Path.Combine(this.tempDirectory, "Resources.resx")
        let designerPath = ResxCodeGenerator.GetDesignerFilePath(resxPath)
        Assert.Equal(Path.Combine(this.tempDirectory, "Resources.Designer.gs"), designerPath)
    }

    @Fact
    func GenerateFromFile_ResxAtProjectRoot_UsesRootNamespaceOnly() {
        let resxPath = Path.Combine(this.tempDirectory, "Resources.resx")
        File.WriteAllText(resxPath, MinimalResx)
        let source = ResxCodeGenerator.GenerateFromFile(resxPath, this.tempDirectory, "Oahu.Core")
        Assert.Contains("package Oahu.Core", source)
        Assert.Contains("\"Oahu.Core.Resources\"", source)
    }

    @Fact
    func GenerateFromFile_ResxInSubfolder_AppendsFolderToNamespace() {
        let subfolder = Path.Combine(this.tempDirectory, "Properties")
        Directory.CreateDirectory(subfolder)
        let resxPath = Path.Combine(subfolder, "Resources.resx")
        File.WriteAllText(resxPath, MinimalResx)
        let source = ResxCodeGenerator.GenerateFromFile(resxPath, this.tempDirectory, "Oahu.Core")
        Assert.Contains("package Oahu.Core.Properties", source)
        Assert.Contains("\"Oahu.Core.Properties.Resources\"", source)
    }

    func Dispose() {
        try {
            Directory.Delete(this.tempDirectory, recursive: true)
        } catch (IOException) { }
    }

    shared {
        private const MinimalResx string = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Greeting" xml:space="preserve">
    <value>Hello</value>
  </data>
</root>`
    }
}
