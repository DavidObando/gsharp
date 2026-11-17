// <copyright file="Adr0223RuntimeDirectoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// ADR-0223 D4: the bundled G# runtime directory is an argument of the resolver factories and
/// of (cref:ReferenceResolver.ResolveDriverReferencePaths). The search order is the argument,
/// then the folder beside the application, then GSHARP_SDK_TOOLS_DIR. No process-wide directory
/// exists. Compiler.Tests runs its tests serially, so a test can set the variable.
open class Adr0223RuntimeDirectoryTests {
    /// The argument comes first, then the folder beside the application, then the variable.
    @Fact
    func BundledRuntime_SearchOrder_ArgumentThenApplicationFolderThenVariable() {
        let root = Directory.CreateTempSubdirectory("adr0223_order_").FullName
        let previous = Environment.GetEnvironmentVariable(Variable)
        try {
            let argument = Path.Combine(root, "argument")
            let application = Path.Combine(root, "app")
            let variable = Path.Combine(root, "variable")
            let fromArgument = PlaceRuntime(Path.Combine(argument, "channels"))
            let besideApplication = PlaceRuntime(application)
            let fromVariable = PlaceRuntime(Path.Combine(variable, "channels"))
            Environment.SetEnvironmentVariable(Variable, variable)
            Assert.Equal(fromArgument, ReferenceResolver.FindBundledChannelsRuntimePath(application, argument))
            // Before ADR-0223 D4 the variable came before the folder beside the application.
            Assert.Equal(besideApplication, ReferenceResolver.FindBundledChannelsRuntimePath(application, nil))
            File.Delete(fromArgument)
            Assert.Equal(besideApplication, ReferenceResolver.FindBundledChannelsRuntimePath(application, argument))
            File.Delete(besideApplication)
            Assert.Equal(fromVariable, ReferenceResolver.FindBundledChannelsRuntimePath(application, argument))
            Environment.SetEnvironmentVariable(Variable, nil)
            Assert.Null(ReferenceResolver.FindBundledChannelsRuntimePath(application, argument))
        } finally {
            Environment.SetEnvironmentVariable(Variable, previous)
            Directory.Delete(root, recursive: true)
        }
    }

    /// A runtime directory can use the SDK layout (`channels/`) or be one folder with the files, as
    /// `runtimes/gsharp/` of the Gsharp.Compiler package. The SDK layout comes first.
    @Fact
    func BundledRuntime_RuntimeDirectory_AcceptsTheSdkLayoutAndAFlatFolder() {
        let root = Directory.CreateTempSubdirectory("adr0223_layout_").FullName
        let previous = Environment.GetEnvironmentVariable(Variable)
        try {
            Environment.SetEnvironmentVariable(Variable, nil)
            let application = Path.Combine(root, "app")
            Directory.CreateDirectory(application)
            let flat = PlaceRuntime(root)
            Assert.Equal(flat, ReferenceResolver.FindBundledChannelsRuntimePath(application, root))
            let sdkLayout = PlaceRuntime(Path.Combine(root, "channels"))
            Assert.Equal(sdkLayout, ReferenceResolver.FindBundledChannelsRuntimePath(application, root))
        } finally {
            Environment.SetEnvironmentVariable(Variable, previous)
            Directory.Delete(root, recursive: true)
        }
    }

    /// Two runtime directories in one process: each call uses the folder it is given, and a call
    /// without a folder is not changed by an earlier call. The resolver of each factory references
    /// the files of its own folder.
    @Fact
    func ResolveDriverReferencePaths_TwoRuntimeDirectories_DoNotShareState() {
        let root = Directory.CreateTempSubdirectory("adr0223_two_").FullName
        let previous = Environment.GetEnvironmentVariable(Variable)
        try {
            Environment.SetEnvironmentVariable(Variable, nil)
            let bundled = ReferenceResolver.ResolveDriverReferencePaths(Array.Empty[string]())
            Assert.Equal(RuntimeFiles.Length, bundled.Count)
            let first = Path.Combine(root, "first")
            let second = Path.Combine(root, "second")
            for folder in[]string{first, second} {
                Directory.CreateDirectory(folder)
                for path in bundled {
                    File.Copy(path, Path.Combine(folder, Path.GetFileName(path)))
                }
            }
            let Folders = func (paths IReadOnlyList[string]) List[string] {
                return paths.Select((path string) -> Path.GetDirectoryName(path)!!).Distinct().ToList()
            }
            Assert.Equal(
                List[string]{Path.GetFullPath(first)},
                Folders(ReferenceResolver.ResolveDriverReferencePaths(nil, first))
            )
            Assert.Equal(
                List[string]{Path.GetFullPath(second)},
                Folders(ReferenceResolver.ResolveDriverReferencePaths(nil, second))
            )
            Assert.Equal(bundled, ReferenceResolver.ResolveDriverReferencePaths(Array.Empty[string]()))
            using let resolver = ReferenceResolver.ForReferencePack(
                "net${Environment.Version.Major}.0",
                runtimeDirectory: second
            )
            for fileName in RuntimeFiles {
                let simpleName = Path.GetFileNameWithoutExtension(fileName)
                let assembly = resolver.Assemblies.Single((a Assembly) -> a.GetName().Name == simpleName)
                Assert.True(ReferenceResolver.TryGetAssemblyPath(assembly, out var path))
                Assert.Equal(Path.Combine(Path.GetFullPath(second), fileName), path)
            }
        } finally {
            Environment.SetEnvironmentVariable(Variable, previous)
            Directory.Delete(root, recursive: true)
        }
    }

    shared {
        private const Variable string = "GSHARP_SDK_TOOLS_DIR"
        private let RuntimeFiles[]string = []string{
            "Gsharp.Extensions.dll",
            "Gsharp.Runtime.Channels.dll",
            "Gsharp.Runtime.Values.dll"
        }

        // A portable IL assembly that the build produced, as a stand-in for the channel runtime.
        private func PlaceRuntime(folder string) string {
            Directory.CreateDirectory(folder)
            let path = Path.GetFullPath(Path.Combine(folder, "Gsharp.Runtime.Channels.dll"))
            File.Copy(typeof(Adr0223RuntimeDirectoryTests).Assembly.Location, path)
            return path
        }
    }
}
