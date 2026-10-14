// <copyright file="NativeSliceRuntimeLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System.IO
import System.Linq
import System.Xml.Linq
import Xunit

class NativeSliceRuntimeLayoutTests {
    @Theory
    @InlineData("Gsharp.NET.Sdk/build/Gsharp.NET.Sdk.props", "tools\\values\\Gsharp.Runtime.Values.dll")
    @InlineData(
        "Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets",
        "Gsharp.Runtime.Values\\Gsharp.Runtime.Values.dll"
    )
    func ValuesRuntimeIsAnExplicitSdkReference(file string, expectedSuffix string) {
        let xml = XDocument.Load(Path.Combine(RepoRoot.Path, "src", "Sdk", file))
        let property = Assert.Single(
            xml.Descendants(),
            (e XElement) -> e.Name.LocalName == "GsharpValuesRuntimeAssemblyFullPath"
        )
        Assert.EndsWith(expectedSuffix, property.Value)
        Assert.Contains(
            xml.Descendants(),
            (e XElement) -> e
                .Name
                .LocalName == "_ExplicitReference" &&
                string(e.Attribute(XName?("Include")!!)) == "$$(GsharpValuesRuntimeAssemblyFullPath)"
        )
    }

    @Fact
    func ValuesRuntimeIsPackagedOnceWithNoCompilerDependency() {
        let sdk = XDocument.Load(
            RepoRoot.ResolveSourcePath(
                Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.NET.Sdk", "Gsharp.NET.Sdk.csproj")
            )
        )
        Assert.Single(
            sdk.Descendants("ProjectReference"),
            (e XElement) -> (string(e.Attribute(XName?("Include")!!))).Contains("Gsharp.Runtime.Values")
        )
        let target = Assert.Single(
            sdk.Descendants("Target"),
            (e XElement) -> string(e.Attribute(XName?("Name")!!)) == "PackGsharpValuesRuntime"
        )
        Assert.Contains(
            target.Descendants("None"),
            (e XElement) -> string(e.Attribute(XName?("PackagePath")!!)) == "tools\\values\\"
        )
        let runtime = XDocument.Load(
            RepoRoot.ResolveSourcePath(
                Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.Runtime.Values", "Gsharp.Runtime.Values.csproj")
            )
        )
        Assert.Empty(runtime.Descendants("ProjectReference"))
    }
}
