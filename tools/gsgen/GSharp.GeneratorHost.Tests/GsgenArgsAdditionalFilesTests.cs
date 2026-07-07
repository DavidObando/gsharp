// <copyright file="GsgenArgsAdditionalFilesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Gsgen.Cli;
using Xunit;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// Issue #2223: parse tests for the <c>gsgen</c> CLI's new
/// <c>/additionalfile:</c> and <c>/globaloption:</c> flags.
/// </summary>
public class GsgenArgsAdditionalFilesTests
{
    [Fact]
    public void AdditionalFile_WithMetadata_ParsesPathAndMetadata()
    {
        var notes = new List<string>();
        GsgenArgs parsed = GsgenArgs.Parse(
            new[] { "/additionalfile:/proj/MainWindow.axaml;SourceItemGroup=AvaloniaXaml;TargetPath=MainWindow.axaml" },
            notes);

        AdditionalFileSpec spec = Assert.Single(parsed.AdditionalFiles);
        Assert.Equal("/proj/MainWindow.axaml", spec.Path);
        Assert.Equal("AvaloniaXaml", spec.Metadata["SourceItemGroup"]);
        Assert.Equal("MainWindow.axaml", spec.Metadata["TargetPath"]);
    }

    [Fact]
    public void AdditionalFile_WithoutMetadata_ParsesPathOnly()
    {
        GsgenArgs parsed = GsgenArgs.Parse(new[] { "/additionalfile:/proj/readme.txt" }, new List<string>());

        AdditionalFileSpec spec = Assert.Single(parsed.AdditionalFiles);
        Assert.Equal("/proj/readme.txt", spec.Path);
        Assert.Empty(spec.Metadata);
    }

    [Fact]
    public void GlobalOption_IsPrefixedWithBuildProperty()
    {
        GsgenArgs parsed = GsgenArgs.Parse(
            new[] { "/globaloption:RootNamespace=App", "/globaloption:build_property.ProjectDir=/proj" },
            new List<string>());

        Assert.Equal("App", parsed.GlobalOptions["build_property.RootNamespace"]);
        Assert.Equal("/proj", parsed.GlobalOptions["build_property.ProjectDir"]);
    }

    [Fact]
    public void GlobalOption_Malformed_IsNoted_AndIgnored()
    {
        var notes = new List<string>();
        GsgenArgs parsed = GsgenArgs.Parse(new[] { "/globaloption:NoEquals" }, notes);

        Assert.Empty(parsed.GlobalOptions);
        Assert.Contains(notes, n => n.Contains("globaloption"));
    }
}
