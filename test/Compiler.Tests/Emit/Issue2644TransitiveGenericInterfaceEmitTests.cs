// <copyright file="Issue2644TransitiveGenericInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue2644TransitiveGenericInterfaceEmitTests
{
    [Fact]
    public void OahuRegionPickerModal_CrossAssemblyConversionRunsAndHasInterfaceMetadata()
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue2644_").FullName;
        try
        {
            var libraryPath = Path.Combine(directory, "Issue2644.Contracts.dll");
            var librarySource = Path.Combine(directory, "contracts.gs");
            File.WriteAllText(
                librarySource,
                """
                package Issue2644.Contracts

                public interface IModal {
                    func Kind() string;
                }

                public interface IModal[T] : IModal {
                    func Result() T;
                }

                public class RegionPickerModal : IModal[string] {
                    public func Kind() string -> "region"
                    public func Result() string -> "us"
                }

                public class Navigator {
                    public func ShowModal(modal IModal) string -> modal.Kind()
                }

                public class HomeScreen {
                    public func Open(navigator Navigator, pendingRegionModal RegionPickerModal) string {
                        return navigator.ShowModal(pendingRegionModal)
                    }
                }
                """);

            Assert.Equal(
                0,
                Program.Main(
                    new[]
                    {
                        "/out:" + libraryPath,
                        "/target:library",
                        "/targetframework:net10.0",
                        librarySource,
                    }));
            IlVerifier.Verify(libraryPath);

            VerifyInterfaceMetadata(libraryPath);

            var executablePath = Path.Combine(directory, "Issue2644.Consumer.dll");
            var consumerSource = Path.Combine(directory, "consumer.gs");
            File.WriteAllText(
                consumerSource,
                """
                package Issue2644.Consumer
                import System
                import Issue2644.Contracts

                func Accept(modal IModal) string -> modal.Kind()

                func Main() {
                    var pendingRegionModal = RegionPickerModal()
                    Console.WriteLine(Accept(pendingRegionModal))
                    Console.WriteLine(HomeScreen().Open(Navigator(), pendingRegionModal))
                }
                """);

            Assert.Equal(
                0,
                Program.Main(
                    new[]
                    {
                        "/out:" + executablePath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libraryPath,
                        consumerSource,
                    }));
            IlVerifier.Verify(executablePath, additionalReferences: new[] { libraryPath });
            Assert.Equal("region\nregion\n", Run(executablePath, directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void VerifyInterfaceMetadata(string assemblyPath)
    {
        var context = new AssemblyLoadContext("Issue2644", isCollectible: true);
        try
        {
            var assembly = context.LoadFromAssemblyPath(assemblyPath);
            var modal = assembly.GetType("Issue2644.Contracts.IModal", throwOnError: true)!;
            var genericModal = assembly.GetType("Issue2644.Contracts.IModal`1", throwOnError: true)!;
            var picker = assembly.GetType("Issue2644.Contracts.RegionPickerModal", throwOnError: true)!;

            Assert.Contains(modal, picker.GetInterfaces());
            Assert.Contains(
                picker.GetInterfaces(),
                iface => iface.IsGenericType && iface.GetGenericTypeDefinition() == genericModal);
        }
        finally
        {
            context.Unload();
        }
    }

    private static string Run(string assemblyPath, string directory)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }
}
