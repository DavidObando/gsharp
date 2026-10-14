// <copyright file="GsgenArgsAdditionalFilesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost.Tests

import GSharp.Gsgen.Cli
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #2223: parse tests for the `gsgen` CLI's new
/// `/additionalfile:` and `/globaloption:` flags.
open class GsgenArgsAdditionalFilesTests {
    @Fact
    func AdditionalFile_WithMetadata_ParsesPathAndMetadata() {
        let notes = List[string]()
        let parsed = GsgenArgs.Parse(
            []string{"/additionalfile:/proj/MainWindow.axaml;SourceItemGroup=AvaloniaXaml;TargetPath=MainWindow.axaml"},
            notes
        )
        let spec = Assert.Single(parsed.AdditionalFiles)
        Assert.Equal("/proj/MainWindow.axaml", spec.Path)
        Assert.Equal("AvaloniaXaml", spec.Metadata["SourceItemGroup"])
        Assert.Equal("MainWindow.axaml", spec.Metadata["TargetPath"])
    }

    @Fact
    func AdditionalFile_WithoutMetadata_ParsesPathOnly() {
        let parsed = GsgenArgs.Parse([]string{"/additionalfile:/proj/readme.txt"}, List[string]())
        let spec = Assert.Single(parsed.AdditionalFiles)
        Assert.Equal("/proj/readme.txt", spec.Path)
        Assert.Empty(spec.Metadata)
    }

    @Fact
    func GlobalOption_IsPrefixedWithBuildProperty() {
        let parsed = GsgenArgs.Parse(
            []string{"/globaloption:RootNamespace=App", "/globaloption:build_property.ProjectDir=/proj"},
            List[string]()
        )
        Assert.Equal("App", parsed.GlobalOptions["build_property.RootNamespace"])
        Assert.Equal("/proj", parsed.GlobalOptions["build_property.ProjectDir"])
    }

    @Fact
    func GlobalOption_Malformed_IsNoted_AndIgnored() {
        let notes = List[string]()
        let parsed = GsgenArgs.Parse([]string{"/globaloption:NoEquals"}, notes)
        Assert.Empty(parsed.GlobalOptions)
        Assert.Contains(notes, (n string) -> n.Contains("globaloption"))
    }
}
