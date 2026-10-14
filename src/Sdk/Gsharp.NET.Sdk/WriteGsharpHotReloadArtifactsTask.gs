// <copyright file="WriteGsharpHotReloadArtifactsTask.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text

/// Writes the runtime hot-reload manifest and generated G# module initializer
/// consumed by `Gsharp.HotReload.Runtime`.
class WriteGsharpHotReloadArtifactsTask : Task {
    /// Gets or sets the full project path.
    @Required
    prop ProjectPath string?

    /// Gets or sets the target framework.
    @Required
    prop TargetFramework string?

    /// Gets or sets the build configuration.
    @Required
    prop Configuration string?

    /// Gets or sets the assembly name.
    @Required
    prop AssemblyName string?

    /// Gets or sets the manifest output path.
    @Required
    prop ManifestPath string?

    /// Gets or sets the generated bootstrap source path.
    @Required
    prop BootstrapPath string?

    /// Gets or sets the directory used for full images compiled after edits.
    @Required
    prop UpdateDirectory string?

    /// Gets or sets the runtime-side hot-reload agent assembly path.
    @Required
    prop RuntimeAssemblyPath string?

    /// Gets or sets a value indicating whether the runtime assembly is copied to the output directory.
    private var _copyRuntime bool = true

    prop CopyRuntime bool {
        get {
            return _copyRuntime
        }
        set {
            _copyRuntime = value
        }
    }

    /// Gets or sets a value indicating whether the module-initializer source is written.
    private var _writeBootstrap bool = true

    prop WriteBootstrap bool {
        get {
            return _writeBootstrap
        }
        set {
            _writeBootstrap = value
        }
    }

    /// Gets or sets the project's intermediate directory.
    @Required
    prop IntermediateDirectory string?

    /// Gets or sets the project's output directory.
    @Required
    prop OutputDirectory string?

    /// Gets or sets source and generator-input files watched for changes.
    private var _watchFiles[]ITaskItem = Array.Empty[ITaskItem]()!!

    prop WatchFiles[]ITaskItem {
        get {
            return _watchFiles
        }
        set {
            _watchFiles = value
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Execute() bool {
        try {
            let projectPath = Require(this.ProjectPath, "ProjectPath")
            let targetFramework = Require(this.TargetFramework, "TargetFramework")
            let configuration = Require(this.Configuration, "Configuration")
            let assemblyName = Require(this.AssemblyName, "AssemblyName")
            let projectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? Environment.CurrentDirectory
            let manifestPath = GetFullPath(Require(this.ManifestPath, "ManifestPath"), projectDirectory)
            let bootstrapPath = GetFullPath(Require(this.BootstrapPath, "BootstrapPath"), projectDirectory)
            let updateDirectory = GetFullPath(Require(this.UpdateDirectory, "UpdateDirectory"), projectDirectory)
            let runtimeAssemblyPath = GetFullPath(
                Require(this.RuntimeAssemblyPath, "RuntimeAssemblyPath"),
                projectDirectory
            )
            let intermediateDirectory = GetFullPath(
                Require(this.IntermediateDirectory, "IntermediateDirectory"),
                projectDirectory
            )
            let outputDirectory = GetFullPath(Require(this.OutputDirectory, "OutputDirectory"), projectDirectory)
            let watchedFiles = this.WatchFiles.Select(
                (item ITaskItem) -> GetFullPath(item.ItemSpec, projectDirectory)
            )!!.Append(Path.GetFullPath(projectPath)!!)!!.Where(
                (path string) -> !IsUnderDirectory(path, intermediateDirectory)
            )!!.Where((path string) -> !IsUnderDirectory(path, outputDirectory))!!.Distinct(PathComparer)!!.OrderBy(
                (path string) -> path,
                PathComparer
            )!!.ToArray()
            let manifest = StringBuilder()
            manifest.AppendLine(ManifestHeader)
            AppendValue(manifest, "project", Path.GetFullPath(projectPath))
            AppendValue(manifest, "targetFramework", targetFramework)
            AppendValue(manifest, "configuration", configuration)
            AppendValue(manifest, "assemblyName", assemblyName)
            AppendValue(manifest, "updateDirectory", updateDirectory)
            AppendValue(manifest, "intermediateDirectory", intermediateDirectory)
            AppendValue(manifest, "outputDirectory", outputDirectory)
            for watchedFile in watchedFiles!! {
                manifest.Append("watch\t").Append(Encode(watchedFile)).Append('\t').AppendLine(ComputeHash(watchedFile))
            }
            let bootstrap = (`// <auto-generated />
package Gsharp.HotReload.Bootstrap

import System.Reflection
import System.Runtime.CompilerServices
import Gsharp.HotReload.Runtime

class __GsharpHotReloadBootstrap {
    shared {
        @ModuleInitializer
        internal func Initialize() {
            HotReloadAgent.Start(Assembly.GetExecutingAssembly(), ` + "${WriteGsharpAssemblyInfoTask.QuoteGsharpString(Path.GetFileName(manifestPath))}" + `)
        }
    }
}`)
            WriteIfChanged(manifestPath, manifest.ToString())
            if this.WriteBootstrap {
                WriteIfChanged(bootstrapPath, bootstrap)
            }
            if this.CopyRuntime {
                CopyRuntimeAssembly(runtimeAssemblyPath, outputDirectory)
            }
            return true
        } catch (ex Exception) when ex is IOException || ex is UnauthorizedAccessException || ex is ArgumentException {
            this.Log.LogErrorFromException(ex, showStackTrace: false)
            return false
        }
    }

    shared {
        private const ManifestHeader string = "GSHARP-HOT-RELOAD-1"
        private prop PathComparer StringComparer -> (
            if Environment.OSVersion.Platform == PlatformID.Win32NT {
                StringComparer.OrdinalIgnoreCase
            } else {
                StringComparer.Ordinal
            }
        )!!
        private prop PathComparison StringComparison -> if Environment.OSVersion.Platform == PlatformID.Win32NT {
            StringComparison.OrdinalIgnoreCase
        } else {
            StringComparison.Ordinal
        }

        private func Require(value string?, propertyName string) string {
            if value == nil || string.IsNullOrWhiteSpace(value) {
                throw ArgumentException("WriteGsharpHotReloadArtifactsTask requires $propertyName.")
            }
            return value
        }

        private func GetFullPath(path string, projectDirectory string) string -> Path.GetFullPath(
            if Path.IsPathRooted(path) {
                path
            } else {
                Path.Combine(projectDirectory, path)
            }
        )

        private func IsUnderDirectory(path string, directory string) bool {
            var normalizedDirectory = Path.GetFullPath(directory)
            if !normalizedDirectory!!.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) {
                normalizedDirectory += Path.DirectorySeparatorChar
            }
            return Path.GetFullPath(path).StartsWith(normalizedDirectory, PathComparison)
        }

        private func AppendValue(builder StringBuilder, key string, value string) -> builder
            .Append(key)
            .Append('\t')
            .AppendLine(Encode(value))

        private func Encode(value string) string -> Convert.ToBase64String(Encoding.UTF8.GetBytes(value))

        private func ComputeHash(path string) string {
            if !File.Exists(path) {
                return "missing"
            }
            try {
                using let stream = File.Open(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete
                )
                using let sha = SHA256.Create()
                return ToHex(sha!!.ComputeHash(stream))
            } catch (IOException) {
                return "unreadable"
            } catch (UnauthorizedAccessException) {
                return "unreadable"
            }
        }

        private func ToHex(bytes[]uint8) string {
            let builder = StringBuilder(bytes.Length * 2)
            for value in bytes {
                builder.Append(value.ToString("X2", CultureInfo.InvariantCulture))
            }
            return builder.ToString()
        }

        private func WriteIfChanged(path string, content string) {
            let directory = Path.GetDirectoryName(path)
            if !string.IsNullOrEmpty(directory) {
                Directory.CreateDirectory(directory)
            }
            if File.Exists(path) && string.Equals(File.ReadAllText(path), content, StringComparison.Ordinal) {
                return
            }
            File.WriteAllText(path, content, UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        }

        private func CopyRuntimeAssembly(sourcePath string, outputDirectory string) {
            Directory.CreateDirectory(outputDirectory)
            let destinationPath = Path.Combine(outputDirectory, Path.GetFileName(sourcePath))
            if File.Exists(destinationPath) && string.Equals(
                ComputeHash(sourcePath),
                ComputeHash(destinationPath!!),
                StringComparison.Ordinal
            ) {
                return
            }
            File.Copy(sourcePath, destinationPath, overwrite: true)
        }
    }
}
