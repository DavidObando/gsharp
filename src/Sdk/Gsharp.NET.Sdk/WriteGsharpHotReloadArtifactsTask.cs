// <copyright file="WriteGsharpHotReloadArtifactsTask.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Build.Framework;

namespace Gsharp.NET.Sdk.Tools;

/// <summary>
/// Writes the runtime hot-reload manifest and generated G# module initializer
/// consumed by <c>Gsharp.HotReload.Runtime</c>.
/// </summary>
public sealed class WriteGsharpHotReloadArtifactsTask : Microsoft.Build.Utilities.Task
{
    private const string ManifestHeader = "GSHARP-HOT-RELOAD-1";

    /// <summary>Gets or sets the full project path.</summary>
    [Required]
    public string? ProjectPath { get; set; }

    /// <summary>Gets or sets the target framework.</summary>
    [Required]
    public string? TargetFramework { get; set; }

    /// <summary>Gets or sets the build configuration.</summary>
    [Required]
    public string? Configuration { get; set; }

    /// <summary>Gets or sets the assembly name.</summary>
    [Required]
    public string? AssemblyName { get; set; }

    /// <summary>Gets or sets the manifest output path.</summary>
    [Required]
    public string? ManifestPath { get; set; }

    /// <summary>Gets or sets the generated bootstrap source path.</summary>
    [Required]
    public string? BootstrapPath { get; set; }

    /// <summary>Gets or sets the directory used for full images compiled after edits.</summary>
    [Required]
    public string? UpdateDirectory { get; set; }

    /// <summary>Gets or sets the runtime-side hot-reload agent assembly path.</summary>
    [Required]
    public string? RuntimeAssemblyPath { get; set; }

    /// <summary>Gets or sets a value indicating whether the runtime assembly is copied to the output directory.</summary>
    public bool CopyRuntime { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the module-initializer source is written.</summary>
    public bool WriteBootstrap { get; set; } = true;

    /// <summary>Gets or sets the project's intermediate directory.</summary>
    [Required]
    public string? IntermediateDirectory { get; set; }

    /// <summary>Gets or sets the project's output directory.</summary>
    [Required]
    public string? OutputDirectory { get; set; }

    /// <summary>Gets or sets source and generator-input files watched for changes.</summary>
    public ITaskItem[] WatchFiles { get; set; } = Array.Empty<ITaskItem>();

    private static StringComparer PathComparer =>
        Environment.OSVersion.Platform == PlatformID.Win32NT
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal;

    private static StringComparison PathComparison =>
        Environment.OSVersion.Platform == PlatformID.Win32NT
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

    /// <inheritdoc/>
    public override bool Execute()
    {
        try
        {
            var projectPath = Require(this.ProjectPath, nameof(this.ProjectPath));
            var targetFramework = Require(this.TargetFramework, nameof(this.TargetFramework));
            var configuration = Require(this.Configuration, nameof(this.Configuration));
            var assemblyName = Require(this.AssemblyName, nameof(this.AssemblyName));
            var projectDirectory = Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? Environment.CurrentDirectory;
            var manifestPath = GetFullPath(Require(this.ManifestPath, nameof(this.ManifestPath)), projectDirectory);
            var bootstrapPath = GetFullPath(Require(this.BootstrapPath, nameof(this.BootstrapPath)), projectDirectory);
            var updateDirectory = GetFullPath(Require(this.UpdateDirectory, nameof(this.UpdateDirectory)), projectDirectory);
            var runtimeAssemblyPath = GetFullPath(
                Require(this.RuntimeAssemblyPath, nameof(this.RuntimeAssemblyPath)),
                projectDirectory);
            var intermediateDirectory = GetFullPath(Require(this.IntermediateDirectory, nameof(this.IntermediateDirectory)), projectDirectory);
            var outputDirectory = GetFullPath(Require(this.OutputDirectory, nameof(this.OutputDirectory)), projectDirectory);

            var watchedFiles = this.WatchFiles
                .Select(item => GetFullPath(item.ItemSpec, projectDirectory))
                .Append(Path.GetFullPath(projectPath))
                .Where(path => !IsUnderDirectory(path, intermediateDirectory))
                .Where(path => !IsUnderDirectory(path, outputDirectory))
                .Distinct(PathComparer)
                .OrderBy(path => path, PathComparer)
                .ToArray();

            var manifest = new StringBuilder();
            manifest.AppendLine(ManifestHeader);
            AppendValue(manifest, "project", Path.GetFullPath(projectPath));
            AppendValue(manifest, "targetFramework", targetFramework);
            AppendValue(manifest, "configuration", configuration);
            AppendValue(manifest, "assemblyName", assemblyName);
            AppendValue(manifest, "updateDirectory", updateDirectory);
            AppendValue(manifest, "intermediateDirectory", intermediateDirectory);
            AppendValue(manifest, "outputDirectory", outputDirectory);
            foreach (var watchedFile in watchedFiles)
            {
                manifest.Append("watch\t")
                    .Append(Encode(watchedFile))
                    .Append('\t')
                    .AppendLine(ComputeHash(watchedFile));
            }

            var bootstrap = $$"""
                // <auto-generated />
                package Gsharp.HotReload.Bootstrap

                import System.Reflection
                import System.Runtime.CompilerServices
                import Gsharp.HotReload.Runtime

                class __GsharpHotReloadBootstrap {
                    shared {
                        @ModuleInitializer
                        internal func Initialize() {
                            HotReloadAgent.Start(Assembly.GetExecutingAssembly(), {{WriteGsharpAssemblyInfoTask.QuoteGsharpString(Path.GetFileName(manifestPath))}})
                        }
                    }
                }
                """;

            WriteIfChanged(manifestPath, manifest.ToString());
            if (this.WriteBootstrap)
            {
                WriteIfChanged(bootstrapPath, bootstrap);
            }

            if (this.CopyRuntime)
            {
                CopyRuntimeAssembly(runtimeAssemblyPath, outputDirectory);
            }

            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            this.Log.LogErrorFromException(ex, showStackTrace: false);
            return false;
        }
    }

    private static string Require(string? value, string propertyName)
    {
        if (value is null || string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"WriteGsharpHotReloadArtifactsTask requires {propertyName}.");
        }

        return value;
    }

    private static string GetFullPath(string path, string projectDirectory) =>
        Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(projectDirectory, path));

    private static bool IsUnderDirectory(string path, string directory)
    {
        var normalizedDirectory = Path.GetFullPath(directory);
        if (!normalizedDirectory.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
        {
            normalizedDirectory += Path.DirectorySeparatorChar;
        }

        return Path.GetFullPath(path).StartsWith(normalizedDirectory, PathComparison);
    }

    private static void AppendValue(StringBuilder builder, string key, string value) =>
        builder.Append(key).Append('\t').AppendLine(Encode(value));

    private static string Encode(string value) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(value));

    private static string ComputeHash(string path)
    {
        if (!File.Exists(path))
        {
            return "missing";
        }

        try
        {
            using var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var sha = SHA256.Create();
            return ToHex(sha.ComputeHash(stream));
        }
        catch (IOException)
        {
            return "unreadable";
        }
        catch (UnauthorizedAccessException)
        {
            return "unreadable";
        }
    }

    private static string ToHex(byte[] bytes)
    {
        var builder = new StringBuilder(bytes.Length * 2);
        foreach (var value in bytes)
        {
            builder.Append(value.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
        }

        return builder.ToString();
    }

    private static void WriteIfChanged(string path, string content)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        if (File.Exists(path) && string.Equals(File.ReadAllText(path), content, StringComparison.Ordinal))
        {
            return;
        }

        File.WriteAllText(path, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    }

    private static void CopyRuntimeAssembly(string sourcePath, string outputDirectory)
    {
        Directory.CreateDirectory(outputDirectory);
        var destinationPath = Path.Combine(outputDirectory, Path.GetFileName(sourcePath));
        if (File.Exists(destinationPath) &&
            string.Equals(ComputeHash(sourcePath), ComputeHash(destinationPath), StringComparison.Ordinal))
        {
            return;
        }

        File.Copy(sourcePath, destinationPath, overwrite: true);
    }
}
