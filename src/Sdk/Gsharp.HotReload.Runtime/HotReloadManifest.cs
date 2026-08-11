// <copyright file="HotReloadManifest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Gsharp.HotReload.Runtime;

internal sealed class HotReloadManifest
{
    private const string Header = "GSHARP-HOT-RELOAD-1";

    private HotReloadManifest()
    {
    }

    public string ProjectPath { get; private set; } = string.Empty;

    public string TargetFramework { get; private set; } = string.Empty;

    public string Configuration { get; private set; } = string.Empty;

    public string AssemblyName { get; private set; } = string.Empty;

    public string UpdateDirectory { get; private set; } = string.Empty;

    public string IntermediateDirectory { get; private set; } = string.Empty;

    public string OutputDirectory { get; private set; } = string.Empty;

    public IReadOnlyDictionary<string, string> WatchedFiles { get; private set; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public string ProjectDirectory => Path.GetDirectoryName(this.ProjectPath) ?? Environment.CurrentDirectory;

    public static HotReloadManifest Load(string path)
    {
        var lines = File.ReadAllLines(path);
        if (lines.Length == 0 || !string.Equals(lines[0], Header, StringComparison.Ordinal))
        {
            throw new InvalidDataException($"Unsupported G# hot-reload manifest '{path}'.");
        }

        var manifest = new HotReloadManifest();
        var watchedFiles = new Dictionary<string, string>(PathComparer);

        for (var i = 1; i < lines.Length; i++)
        {
            var parts = lines[i].Split('\t');
            if (parts.Length < 2)
            {
                continue;
            }

            switch (parts[0])
            {
                case "project":
                    manifest.ProjectPath = Decode(parts[1]);
                    break;
                case "targetFramework":
                    manifest.TargetFramework = Decode(parts[1]);
                    break;
                case "configuration":
                    manifest.Configuration = Decode(parts[1]);
                    break;
                case "assemblyName":
                    manifest.AssemblyName = Decode(parts[1]);
                    break;
                case "updateDirectory":
                    manifest.UpdateDirectory = Decode(parts[1]);
                    break;
                case "intermediateDirectory":
                    manifest.IntermediateDirectory = Decode(parts[1]);
                    break;
                case "outputDirectory":
                    manifest.OutputDirectory = Decode(parts[1]);
                    break;
                case "watch" when parts.Length >= 3:
                    watchedFiles[Decode(parts[1])] = parts[2];
                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(manifest.ProjectPath) ||
            string.IsNullOrWhiteSpace(manifest.TargetFramework) ||
            string.IsNullOrWhiteSpace(manifest.AssemblyName) ||
            string.IsNullOrWhiteSpace(manifest.UpdateDirectory))
        {
            throw new InvalidDataException($"Incomplete G# hot-reload manifest '{path}'.");
        }

        manifest.WatchedFiles = watchedFiles;
        return manifest;
    }

    public bool HasChangesSinceBuild()
    {
        foreach (var pair in this.WatchedFiles)
        {
            if (!string.Equals(ComputeHash(pair.Key), pair.Value, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static StringComparer PathComparer =>
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private static string Decode(string value) =>
        Encoding.UTF8.GetString(Convert.FromBase64String(value));

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
            return Convert.ToHexString(sha.ComputeHash(stream));
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
}
