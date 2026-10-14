// <copyright file="ResxDocumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Resx

import GSharp.Core.Resx
import Xunit

open class ResxDocumentTests {
    @Fact
    func Parse_PlainStringResource_IsString() {
        let xml = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Greeting" xml:space="preserve">
    <value>Hello</value>
    <comment>A greeting</comment>
  </data>
</root>`
        let document = ResxDocument.Parse(xml)
        let entry = Assert.Single(document.Entries)
        Assert.Equal("Greeting", entry.Name)
        Assert.Equal("Hello", entry.Value)
        Assert.Equal("A greeting", entry.Comment)
        Assert.True(entry.IsString)
    }

    @Fact
    func Parse_DesignerMetadataEntries_AreSkipped() {
        let xml = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name=">>$this.Name">
    <value>form1</value>
  </data>
  <data name="Real" xml:space="preserve">
    <value>value</value>
  </data>
</root>`
        let document = ResxDocument.Parse(xml)
        let entry = Assert.Single(document.Entries)
        Assert.Equal("Real", entry.Name)
    }

    @Fact
    func Parse_ResheaderEntries_AreIgnored() {
        let xml = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <data name="Real" xml:space="preserve">
    <value>value</value>
  </data>
</root>`
        let document = ResxDocument.Parse(xml)
        let entry = Assert.Single(document.Entries)
        Assert.Equal("Real", entry.Name)
    }

    @Fact
    func Parse_TypedResource_IsNotString() {
        let xml = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="SampleBytes" type="System.Byte[], mscorlib">
    <value>AQIDBA==</value>
  </data>
</root>`
        let document = ResxDocument.Parse(xml)
        let entry = Assert.Single(document.Entries)
        Assert.False(entry.IsString)
        Assert.Equal("System.Byte[], mscorlib", entry.TypeName)
    }
}
