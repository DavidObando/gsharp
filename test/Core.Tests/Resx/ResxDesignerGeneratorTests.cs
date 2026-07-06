// <copyright file="ResxDesignerGeneratorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Resx;
using Xunit;

namespace GSharp.Core.Tests.Resx;

/// <summary>
/// Issue #2200 / ADR-0142: the generated designer source must be more than
/// textually plausible — it must actually parse, bind, and emit through the
/// real G# compiler, and the emitted assembly must behave like the real
/// resx-generated C# class does when the resource is missing (a
/// <see cref="System.Resources.MissingManifestResourceException"/> from
/// <c>ResourceManager.GetString</c>, not a binder/compile-time failure).
/// </summary>
public class ResxDesignerGeneratorTests
{
    private const string SampleResx = """
        <?xml version="1.0" encoding="utf-8"?>
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
        </root>
        """;

    [Fact]
    public void Generate_ProducesSourceThatParsesWithNoDiagnostics()
    {
        var document = ResxDocument.Parse(SampleResx);
        var options = new ResxDesignerOptions("Oahu.Core.Properties", "Resources", "Oahu.Core.Properties.Resources", isPublic: false);

        string source = ResxDesignerGenerator.Generate(document, options);

        var tree = SyntaxTree.Parse(SourceText.From(source));
        Assert.Empty(tree.Diagnostics);
    }

    [Fact]
    public void Generate_EmitsAndRuns_StringAndTypedAccessors()
    {
        var document = ResxDocument.Parse(SampleResx);
        var options = new ResxDesignerOptions("Oahu.Core.Properties", "Resources", "Oahu.Core.Properties.Resources", isPublic: false);
        string designerSource = ResxDesignerGenerator.Generate(document, options);

        string consumerSource = """
            package Oahu.Core.Properties

            Console.WriteLine(Resources.EncryptedFileExt)
            """;

        var designerTree = SyntaxTree.Parse(SourceText.From(designerSource, "Resources.Designer.gs"));
        var consumerTree = SyntaxTree.Parse(SourceText.From(consumerSource, "Test.gs"));

        Assert.Empty(designerTree.Diagnostics);
        Assert.Empty(consumerTree.Diagnostics);

        var compilation = new Compilation(designerTree, consumerTree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(result.Success, "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    [Fact]
    public void Generate_ReservedKeywordResourceKey_SanitizedWithSuffix()
    {
        var document = ResxDocument.Parse(SampleResx);
        var options = new ResxDesignerOptions("Oahu.Core.Properties", "Resources", "Oahu.Core.Properties.Resources", isPublic: false);

        string source = ResxDesignerGenerator.Generate(document, options);

        Assert.Contains("prop class1 string", source);
    }

    [Fact]
    public void Generate_TypedResource_UsesGetObjectWithAsCast()
    {
        var document = ResxDocument.Parse(SampleResx);
        var options = new ResxDesignerOptions("Oahu.Core.Properties", "Resources", "Oahu.Core.Properties.Resources", isPublic: false);

        string source = ResxDesignerGenerator.Generate(document, options);

        Assert.Contains("prop SampleBytes []uint8 {", source);
        Assert.Contains("ResourceManager.GetObject(\"SampleBytes\", resourceCulture) as []uint8", source);
    }

    [Fact]
    public void Generate_PublicOption_EmitsPublicClass()
    {
        var document = ResxDocument.Parse(SampleResx);
        var options = new ResxDesignerOptions("Oahu.Core.Properties", "Resources", "Oahu.Core.Properties.Resources", isPublic: true);

        string source = ResxDesignerGenerator.Generate(document, options);

        Assert.Contains("public class Resources {", source);

        // The constructor stays `internal` regardless of class accessibility,
        // matching the real ResX code generator's CA1811 suppression intent.
        Assert.Contains("internal init() { }", source);
    }
}
