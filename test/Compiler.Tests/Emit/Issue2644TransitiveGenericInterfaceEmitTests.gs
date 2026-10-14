// <copyright file="Issue2644TransitiveGenericInterfaceEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Runtime.Loader
import Xunit

class Issue2644TransitiveGenericInterfaceEmitTests {
    @Fact
    func OahuRegionPickerModal_CrossAssemblyConversionRunsAndHasInterfaceMetadata() {
        let directory = Directory.CreateTempSubdirectory("gs_issue2644_").FullName
        try {
            let libraryPath = Path.Combine(directory, "Issue2644.Contracts.dll")
            let librarySource = Path.Combine(directory, "contracts.gs")
            File.WriteAllText(librarySource, `package Issue2644.Contracts

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
}`)
            Assert.Equal(
                0,
                Program.Main(
                    []string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", librarySource}
                )
            )
            IlVerifier.Verify(libraryPath)
            VerifyInterfaceMetadata(libraryPath)
            let executablePath = Path.Combine(directory, "Issue2644.Consumer.dll")
            let consumerSource = Path.Combine(directory, "consumer.gs")
            File.WriteAllText(consumerSource, `package Issue2644.Consumer
import System
import Issue2644.Contracts

func Accept(modal IModal) string -> modal.Kind()

func Main() {
    var pendingRegionModal = RegionPickerModal()
    Console.WriteLine(Accept(pendingRegionModal))
    Console.WriteLine(HomeScreen().Open(Navigator(), pendingRegionModal))
}`)
            Assert.Equal(
                0,
                Program.Main(
                    []string{
                        "/out:" + executablePath,
                        "/target:exe",
                        "/targetframework:net10.0",
                        "/reference:" + libraryPath,
                        consumerSource
                    }
                )
            )
            IlVerifier.Verify(executablePath, additionalReferences: []string{libraryPath})
            Assert.Equal("region${Environment.NewLine}region${Environment.NewLine}", Run(executablePath, directory))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func VerifyInterfaceMetadata(assemblyPath string) {
            let context = AssemblyLoadContext("Issue2644", isCollectible: true)
            try {
                let assembly = context.LoadFromAssemblyPath(assemblyPath)
                let modal = assembly.GetType("Issue2644.Contracts.IModal", throwOnError: true)!!
                let genericModal = assembly.GetType("Issue2644.Contracts.IModal`1", throwOnError: true)!!
                let picker = assembly.GetType("Issue2644.Contracts.RegionPickerModal", throwOnError: true)!!
                Assert.Contains(modal, picker.GetInterfaces())
                Assert.Contains(
                    picker.GetInterfaces(),
                    (iface Type) -> iface.IsGenericType && iface.GetGenericTypeDefinition() == genericModal
                )
            } finally {
                context.Unload()
            }
        }

        private func Run(assemblyPath string, directory string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = directory
            }
            startInfo.ArgumentList.Add("exec")
            startInfo.ArgumentList.Add("--runtimeconfig")
            startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"))
            startInfo.ArgumentList.Add(assemblyPath)
            using let process = Process.Start(startInfo)!!
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode == 0, (`exited ` + "${process.ExitCode}" + `
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
