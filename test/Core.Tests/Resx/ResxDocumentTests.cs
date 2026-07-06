// <copyright file="ResxDocumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.Resx;
using Xunit;

namespace GSharp.Core.Tests.Resx;

public class ResxDocumentTests
{
    [Fact]
    public void Parse_PlainStringResource_IsString()
    {
        var xml = """
            <?xml version="1.0" encoding="utf-8"?>
            <root>
              <data name="Greeting" xml:space="preserve">
                <value>Hello</value>
                <comment>A greeting</comment>
              </data>
            </root>
            """;

        var document = ResxDocument.Parse(xml);

        var entry = Assert.Single(document.Entries);
        Assert.Equal("Greeting", entry.Name);
        Assert.Equal("Hello", entry.Value);
        Assert.Equal("A greeting", entry.Comment);
        Assert.True(entry.IsString);
    }

    [Fact]
    public void Parse_DesignerMetadataEntries_AreSkipped()
    {
        var xml = """
            <?xml version="1.0" encoding="utf-8"?>
            <root>
              <data name=">>$this.Name">
                <value>form1</value>
              </data>
              <data name="Real" xml:space="preserve">
                <value>value</value>
              </data>
            </root>
            """;

        var document = ResxDocument.Parse(xml);

        var entry = Assert.Single(document.Entries);
        Assert.Equal("Real", entry.Name);
    }

    [Fact]
    public void Parse_ResheaderEntries_AreIgnored()
    {
        var xml = """
            <?xml version="1.0" encoding="utf-8"?>
            <root>
              <resheader name="resmimetype">
                <value>text/microsoft-resx</value>
              </resheader>
              <data name="Real" xml:space="preserve">
                <value>value</value>
              </data>
            </root>
            """;

        var document = ResxDocument.Parse(xml);

        var entry = Assert.Single(document.Entries);
        Assert.Equal("Real", entry.Name);
    }

    [Fact]
    public void Parse_TypedResource_IsNotString()
    {
        var xml = """
            <?xml version="1.0" encoding="utf-8"?>
            <root>
              <data name="SampleBytes" type="System.Byte[], mscorlib">
                <value>AQIDBA==</value>
              </data>
            </root>
            """;

        var document = ResxDocument.Parse(xml);

        var entry = Assert.Single(document.Entries);
        Assert.False(entry.IsString);
        Assert.Equal("System.Byte[], mscorlib", entry.TypeName);
    }
}
