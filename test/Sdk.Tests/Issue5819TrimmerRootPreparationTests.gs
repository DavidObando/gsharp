// <copyright file="Issue5819TrimmerRootPreparationTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Threading
import System.Threading.Tasks
import System.Xml.Linq
import Gsharp.NET.Sdk.Tools
import Xunit

/// Issue #5819: Android NativeAOT and ILLink trimming require preserving the
/// `System.Runtime` forwarding table and rooting the bundled G# runtime helper
/// assemblies (`Gsharp.Extensions`, `Gsharp.Runtime.Channels`,
/// `Gsharp.Runtime.Values`) before `PrepareForILLink`.
class Issue5819TrimmerRootPreparationTests : IDisposable {
    private let directory string = Path.Combine(
        RepoRoot.Path,
        "out",
        "test",
        "Issue5819TrimmerRootPreparationTests",
        Guid.NewGuid().ToString("N")
    )

    init() {
        Directory.CreateDirectory(directory)
    }

    func Dispose() -> Directory.Delete(directory, recursive: true)

    @Theory
    @InlineData("true", "false", "false", "false", "false")
    @InlineData("false", "true", "false", "false", "false")
    @InlineData("true", "true", "true", "false", "true")
    func PrepareForILLink_RegistersSystemRuntimeDescriptorAndEnabledBundledHelpers(
        publishAot string,
        publishTrimmed string,
        noExtensions string,
        noChannels string,
        noValues string
    ) {
        let (exit, output) = RunPrepareForILLink(publishAot, publishTrimmed, noExtensions, noChannels, noValues)
        Assert.True(exit == 0, output)
        let descriptorPath = Path.Combine(directory, "obj", "gsharp.trimmer.xml")
        Assert.True(File.Exists(descriptorPath), descriptorPath)
        let descriptorDoc = XDocument.Load(descriptorPath)
        let assemblyElement = Assert.Single(descriptorDoc.Root!!.Elements("assembly"))
        Assert.Equal("System.Runtime", string(assemblyElement.Attribute("fullname")))
        Assert.Equal("all", string(assemblyElement.Attribute("preserve")))
        Assert.Contains("DESCRIPTOR=" + descriptorPath, output, StringComparison.Ordinal)
        if noExtensions == "true" {
            Assert.DoesNotContain("ROOT=Gsharp.Extensions|All", output, StringComparison.Ordinal)
        } else {
            Assert.Contains("ROOT=Gsharp.Extensions|All", output, StringComparison.Ordinal)
        }
        if noChannels == "true" {
            Assert.DoesNotContain("ROOT=Gsharp.Runtime.Channels|All", output, StringComparison.Ordinal)
        } else {
            Assert.Contains("ROOT=Gsharp.Runtime.Channels|All", output, StringComparison.Ordinal)
        }
        if noValues == "true" {
            Assert.DoesNotContain("ROOT=Gsharp.Runtime.Values|All", output, StringComparison.Ordinal)
        } else {
            Assert.Contains("ROOT=Gsharp.Runtime.Values|All", output, StringComparison.Ordinal)
        }
    }

    @Fact
    func PrepareForILLink_WhenNeitherTrimmedNorAot_SkipsDescriptorAndRoots() {
        let (exit, output) = RunPrepareForILLink("false", "false", "false", "false", "false")
        Assert.True(exit == 0, output)
        let descriptorPath = Path.Combine(directory, "obj", "gsharp.trimmer.xml")
        Assert.False(File.Exists(descriptorPath), descriptorPath)
        Assert.DoesNotContain("DESCRIPTOR=", output, StringComparison.Ordinal)
        Assert.DoesNotContain("ROOT=Gsharp.", output, StringComparison.Ordinal)
    }

    private func RunPrepareForILLink(
        publishAot string,
        publishTrimmed string,
        noExtensions string,
        noChannels string,
        noValues string
    )(Exit int32, Output string) {
        let extensionsPath = Path.Combine(directory, "Gsharp.Extensions.dll")
        let channelsPath = Path.Combine(directory, "Gsharp.Runtime.Channels.dll")
        let valuesPath = Path.Combine(directory, "Gsharp.Runtime.Values.dll")
        File.WriteAllBytes(extensionsPath, Array.Empty[uint8]())
        File.WriteAllBytes(channelsPath, Array.Empty[uint8]())
        File.WriteAllBytes(valuesPath, Array.Empty[uint8]())
        let document = XDocument.Parse(Project)
        let root = document.Root ?? throw InvalidOperationException("The test project has no root.")
        let properties = root.Elements("PropertyGroup").Single()
        properties.SetElementValue("GsharpToolFullPath", typeof(BuildTask).Assembly.Location)
        properties.SetElementValue("GsharpExtensionsAssemblyFullPath", extensionsPath)
        properties.SetElementValue("GsharpChannelsRuntimeAssemblyFullPath", channelsPath)
        properties.SetElementValue("GsharpValuesRuntimeAssemblyFullPath", valuesPath)
        root
            .Elements("Import")
            .Single()
            .SetAttributeValue("Project", Path.Combine(RepoRoot.SdkSourceDir, "build", "Gsharp.NET.Core.Sdk.targets"))
        let projectPath = Path.Combine(directory, "Probe.proj")
        document.Save(projectPath)
        let start = ProcessStartInfo("dotnet"){
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        }
        for argument in[]string{
            "msbuild",
            "Probe.proj",
            "-nologo",
            "-nr:false",
            "-v:normal",
            "-p:PublishAot=$publishAot",
            "-p:PublishTrimmed=$publishTrimmed",
            "-p:GsharpNoExtensions=$noExtensions",
            "-p:GsharpNoChannelsRuntime=$noChannels",
            "-p:GsharpNoValuesRuntime=$noValues"
        } {
            start.ArgumentList.Add(argument)
        }
        using let process = Process.Start(start) ?? throw InvalidOperationException("Cannot start the probe build.")
        using let outputDeadline = CancellationTokenSource(TimeSpan.FromSeconds(120))
        let stdout = process.StandardOutput.ReadToEndAsync(outputDeadline.Token)
        let stderr = process.StandardError.ReadToEndAsync(outputDeadline.Token)
        if !process.WaitForExit(120000) {
            process.Kill(entireProcessTree: true)
            process.WaitForExit()
            throw TimeoutException("The probe build timed out.")
        }
        Task.WaitAll(stdout, stderr)
        return (process.ExitCode, stdout.Result + stderr.Result)
    }

    shared {
        private const Project string = `<Project DefaultTargets="PrepareForILLink">
  <PropertyGroup>
    <IntermediateOutputPath>obj/</IntermediateOutputPath>
    <TargetName>Probe</TargetName>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <Import Project="placeholder" />
  <Target Name="PrepareForILLink">
    <Message Importance="High" Text="DESCRIPTOR=%(TrimmerRootDescriptor.Identity)" Condition=" '@(TrimmerRootDescriptor)' != '' " />
    <Message Importance="High" Text="ROOT=%(TrimmerRootAssembly.Identity)|%(TrimmerRootAssembly.RootMode)" Condition=" '@(TrimmerRootAssembly)' != '' " />
  </Target>
</Project>`
    }
}
