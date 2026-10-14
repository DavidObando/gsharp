// <copyright file="ResxDesignerGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Resx

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Resx
import System.IO
import System.Linq
import Xunit

/// Issue #2200 / ADR-0142: the generated designer source must be more than
/// textually plausible — it must actually parse, bind, and emit through the
/// real G# compiler, and the emitted assembly must behave like the real
/// resx-generated C# class does when the resource is missing (a
/// (cref:System.Resources.MissingManifestResourceException) from
/// `ResourceManager.GetString`, not a binder/compile-time failure).
open class ResxDesignerGeneratorTests {
    @Fact
    func Generate_ProducesSourceThatParsesWithNoDiagnostics() {
        let document = ResxDocument.Parse(SampleResx)
        let options = ResxDesignerOptions(
            "Oahu.Core.Properties",
            "Resources",
            "Oahu.Core.Properties.Resources",
            isPublic: false
        )
        let source = ResxDesignerGenerator.Generate(document, options)
        let tree = SyntaxTree.Parse(SourceText.From(source))
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Generate_EmitsAndRuns_StringAndTypedAccessors() {
        let document = ResxDocument.Parse(SampleResx)
        let options = ResxDesignerOptions(
            "Oahu.Core.Properties",
            "Resources",
            "Oahu.Core.Properties.Resources",
            isPublic: false
        )
        let designerSource = ResxDesignerGenerator.Generate(document, options)
        let consumerSource = `package Oahu.Core.Properties

Console.WriteLine(Resources.EncryptedFileExt)`
        let designerTree = SyntaxTree.Parse(SourceText.From(designerSource, "Resources.Designer.gs"))
        let consumerTree = SyntaxTree.Parse(SourceText.From(consumerSource, "Test.gs"))
        Assert.Empty(designerTree.Diagnostics)
        Assert.Empty(consumerTree.Diagnostics)
        let compilation = Compilation(designerTree, consumerTree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
    }

    @Fact
    func Generate_ReservedKeywordResourceKey_SanitizedWithSuffix() {
        let document = ResxDocument.Parse(SampleResx)
        let options = ResxDesignerOptions(
            "Oahu.Core.Properties",
            "Resources",
            "Oahu.Core.Properties.Resources",
            isPublic: false
        )
        let source = ResxDesignerGenerator.Generate(document, options)
        Assert.Contains("prop class1 string", source)
    }

    @Fact
    func Generate_TypedResource_UsesCheckedCast() {
        let document = ResxDocument.Parse(SampleResx)
        let options = ResxDesignerOptions(
            "Oahu.Core.Properties",
            "Resources",
            "Oahu.Core.Properties.Resources",
            isPublic: false
        )
        let source = ResxDesignerGenerator.Generate(document, options)
        Assert.Contains("prop SampleBytes []uint8 {", source)
        Assert.Contains("cast[[]uint8](ResourceManager.GetObject(\"SampleBytes\", resourceCulture))", source)
    }

    @Fact
    func Generate_PublicOption_EmitsPublicClass() {
        let document = ResxDocument.Parse(SampleResx)
        let options = ResxDesignerOptions(
            "Oahu.Core.Properties",
            "Resources",
            "Oahu.Core.Properties.Resources",
            isPublic: true
        )
        let source = ResxDesignerGenerator.Generate(document, options)
        Assert.Contains("public class Resources {", source)
        // The constructor stays `internal` regardless of class accessibility,
        // matching the real ResX code generator's CA1811 suppression intent.
        Assert.Contains("internal init() { }", source)
    }

    shared {
        private const SampleResx string = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <data name="EncryptedFileExt" xml:space="preserve">
    <value>.aax.enc</value>
    <comment>File extension for encrypted downloads</comment>
  </data>
  <data name="class" xml:space="preserve">
    <value>reserved keyword collision</value>
  </data>
  <data name="SampleBytes" type="System.Byte[], mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089">
    <value>AQIDBA==</value>
  </data>
</root>`
    }
}
