// <copyright file="Issue4802RecursiveHelperActivationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;
using Xunit.Abstractions;

namespace Cs2Gs.Tests;

[Collection(IlVerifyPipelineCollection.Name)]
public sealed class Issue4802RecursiveHelperActivationTests
{
    private readonly ITestOutputHelper output;

    public Issue4802RecursiveHelperActivationTests(ITestOutputHelper output) => this.output = output;

    [Theory]
    [InlineData("RecursiveHelper", "20,10,0,1,11,21|6|native")]
    [InlineData("NestedMutualAndEscapes", "0,1,2|2,1,0")]
    [InlineData("OuterMutualThroughNestedBridge", "2,21,1,20,0,10,11,12")]
    public void NativeAndTranslatedCallbacks_KeepTheirDeclaringActivation(string method, string expected)
    {
        string directory = Path.Combine(AppContext.BaseDirectory, "issue4802", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            this.output.WriteLine("Active translator: " + typeof(CSharpToGSharpTranslator).Assembly.Location +
                " SHA256=" + Convert.ToHexString(SHA256.HashData(
                    File.ReadAllBytes(typeof(CSharpToGSharpTranslator).Assembly.Location))));
            string source = File.ReadAllText(Path.Combine(
                AppContext.BaseDirectory, "Fixtures", "Issue4802", "Activation.cs.txt"));
            string nativeSource = Path.Combine(directory, "Activation.cs");
            File.WriteAllText(nativeSource, source);
            string projectPath = Path.Combine(directory, "Native.csproj");
            File.WriteAllText(projectPath, """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net10.0</TargetFramework>
                    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
                    <DebugType>portable</DebugType>
                    <Deterministic>true</Deterministic>
                    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
                  </PropertyGroup>
                  <ItemGroup><Compile Include="Activation.cs" /></ItemGroup>
                </Project>
                """);
            string intermediate = "/p:BaseIntermediateOutputPath=" + Path.Combine(directory, "obj") + Path.DirectorySeparatorChar;
            this.Run(directory, "native-restore", new[]
            {
                "restore", projectPath, "--locked-mode", "/nr:false", intermediate,
                "/p:ImportDirectoryBuildProps=false", "/p:ImportDirectoryBuildTargets=false",
            });
            this.Run(directory, "native-build", new[]
            {
                "build", projectPath, "-c", "Release", "--no-restore", "-graph", "/nr:false",
                "/bl:" + Path.Combine(directory, "native.binlog"),
                "/p:ImportDirectoryBuildProps=false", "/p:ImportDirectoryBuildTargets=false",
                intermediate,
                "/p:OutputPath=" + Path.Combine(directory, "native") + Path.DirectorySeparatorChar,
            });
            string nativeImage = Path.Combine(directory, "native", "Native.dll");
            this.AssertContract(nativeImage, method, expected);

            LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Activation.cs", source) });
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
            LoadedDocument document = Assert.Single(project.Documents);
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));
            Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
            string translatedSource = Path.Combine(directory, "Activation.gs");
            File.WriteAllText(translatedSource, printed);
            string translatedImage = Path.Combine(directory, "Translated.dll");
            string compiler = LocalFunctionHoistTranslationTests.FindCompiler();
            Assert.NotNull(compiler);
            this.Run(directory, "gsc", new[] { compiler, "/target:library", "/out:" + translatedImage, translatedSource });
            foreach (string image in new[] { nativeImage, translatedImage })
            {
                var verify = new List<string> { "tool", "run", "ilverify", image, "-s", "System.Private.CoreLib" };
                foreach (string reference in Directory.EnumerateFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll"))
                {
                    verify.Add("-r");
                    verify.Add(reference);
                }

                this.Run(directory, Path.GetFileNameWithoutExtension(image) + "-strict-ilverify", verify);
            }

            this.AssertContract(translatedImage, method, expected);
        }
        finally
        {
            CaptureEvidenceAndCleanup(directory, Environment.GetEnvironmentVariable("GSHARP_ISSUE4802_EVIDENCE"));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EvidenceCapture_UsesSuppliedRootPreservesArtifactsAndCleansWorkspace(bool fixtureFails)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"));
        string directory = Path.Combine(root, "workspace");
        string evidence = Path.Combine(root, "supplied evidence");
        string destination = Path.Combine(evidence, "workspace");
        Directory.CreateDirectory(Path.Combine(directory, "native"));
        Directory.CreateDirectory(destination);
        try
        {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence");
            byte[] product = { 0, 1, 255, 42 };
            File.WriteAllBytes(Path.Combine(directory, "native", "Native.pdb"), product);
            File.WriteAllText(Path.Combine(evidence, "existing.marker"), "root artifact");
            File.WriteAllText(Path.Combine(destination, "existing.log"), "previous artifact");
            var failure = Record.Exception(() =>
            {
                try
                {
                    if (fixtureFails)
                    {
                        throw new InvalidOperationException("original fixture failure");
                    }
                }
                finally
                {
                    CaptureEvidenceAndCleanup(directory, evidence);
                }
            });
            if (fixtureFails)
            {
                Assert.Equal("original fixture failure", Assert.IsType<InvalidOperationException>(failure).Message);
            }
            else
            {
                Assert.Null(failure);
            }

            Assert.False(Directory.Exists(directory));
            Assert.Equal("fixture evidence", File.ReadAllText(Path.Combine(destination, "command.log")));
            Assert.Equal(product, File.ReadAllBytes(Path.Combine(destination, "native", "Native.pdb")));
            Assert.Equal("root artifact", File.ReadAllText(Path.Combine(evidence, "existing.marker")));
            Assert.Equal("previous artifact", File.ReadAllText(Path.Combine(destination, "existing.log")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void EvidenceCapture_CleansWorkspaceAndReportsCopyFailure()
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"));
        string directory = Path.Combine(root, "workspace");
        string evidence = Path.Combine(root, "blocked evidence");
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence");
            File.WriteAllText(evidence, "existing artifact");
            Assert.ThrowsAny<IOException>(() => CaptureEvidenceAndCleanup(directory, evidence));
            Assert.False(Directory.Exists(directory));
            Assert.Equal("existing artifact", File.ReadAllText(evidence));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void EvidenceCapture_WithoutDestinationStillCleansWorkspace(string evidence)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "issue4802-evidence", Guid.NewGuid().ToString("N"));
        string directory = Path.Combine(root, "workspace");
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "command.log"), "fixture evidence");
            CaptureEvidenceAndCleanup(directory, evidence);
            Assert.False(Directory.Exists(directory));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void CaptureEvidenceAndCleanup(string directory, string evidence)
    {
        try
        {
            if (!string.IsNullOrEmpty(evidence))
            {
                string destination = Path.Combine(evidence, Path.GetFileName(directory));
                Directory.CreateDirectory(destination);
                foreach (string file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
                {
                    string target = Path.Combine(destination, Path.GetRelativePath(directory, file));
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(file, target, overwrite: true);
                }
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private void AssertContract(string image, string method, string expected)
    {
        Assembly assembly = EmittedFixture.Load(image);
        Type definition = assembly.GetType("Issue4802.Activation`1");
        Assert.NotNull(definition);
        Type type = definition.MakeGenericType(typeof(string));
        object instance = Activator.CreateInstance(type, "native");
        Assert.NotNull(instance);
        MethodInfo callback = type.GetMethod(method);
        Assert.NotNull(callback);
        string actual = Assert.IsType<string>(callback.Invoke(instance, null));
        this.output.WriteLine(Path.GetFileName(image) + " " + method + ": " + actual);
        Assert.Equal(expected, actual);
    }

    private void Run(string directory, string label, IEnumerable<string> arguments)
    {
        string[] command = arguments.ToArray();
        File.WriteAllText(Path.Combine(directory, label + ".command.json"),
            System.Text.Json.JsonSerializer.Serialize(command));
        ProcessRunResult result = ProcessRunner.Run("dotnet", command, GsharpTestProjectRunner.FindRepoRoot());
        File.WriteAllText(Path.Combine(directory, label + ".log"), result.Output);
        File.WriteAllText(Path.Combine(directory, label + ".exit"), result.ExitCode.ToString());
        this.output.WriteLine(label + ": " + result.Output);
        Assert.False(result.TimedOut, result.Output);
        Assert.True(result.ExitCode == 0, result.Output);
    }
}
