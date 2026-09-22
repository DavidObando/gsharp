// <copyright file="NativeSliceRuntimeLayoutTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Xml.Linq;
using Xunit;

namespace GSharp.Sdk.Tests;

public sealed class NativeSliceRuntimeLayoutTests
{
    [Theory]
    [InlineData("Gsharp.NET.Sdk/build/Gsharp.NET.Sdk.props", "tools\\values\\Gsharp.Runtime.Values.dll")]
    [InlineData("Gsharp.NET.Sdk.Bootstrap/build/Gsharp.NET.Sdk.Bootstrap.targets", "Gsharp.Runtime.Values\\Gsharp.Runtime.Values.dll")]
    public void ValuesRuntimeIsAnExplicitSdkReference(string file, string expectedSuffix)
    {
        var xml = XDocument.Load(Path.Combine(RepoRoot.Path, "src", "Sdk", file));
        var property = Assert.Single(xml.Descendants(), e => e.Name.LocalName == "GsharpValuesRuntimeAssemblyFullPath");
        Assert.EndsWith(expectedSuffix, property.Value);
        Assert.Contains(xml.Descendants(), e => e.Name.LocalName == "_ExplicitReference"
            && (string)e.Attribute("Include") == "$(GsharpValuesRuntimeAssemblyFullPath)");
    }

    [Fact]
    public void ValuesRuntimeIsPackagedOnceWithNoCompilerDependency()
    {
        var sdk = XDocument.Load(Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.NET.Sdk", "Gsharp.NET.Sdk.csproj"));
        Assert.Single(sdk.Descendants("ProjectReference"), e => ((string)e.Attribute("Include")).Contains("Gsharp.Runtime.Values"));
        var target = Assert.Single(sdk.Descendants("Target"), e => (string)e.Attribute("Name") == "PackGsharpValuesRuntime");
        Assert.Contains(target.Descendants("None"), e => (string)e.Attribute("PackagePath") == "tools\\values\\");
        var runtime = XDocument.Load(Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.Runtime.Values", "Gsharp.Runtime.Values.csproj"));
        Assert.Empty(runtime.Descendants("ProjectReference"));
    }
}
