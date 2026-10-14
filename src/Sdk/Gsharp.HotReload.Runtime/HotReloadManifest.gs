// <copyright file="HotReloadManifest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.HotReload.Runtime

import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text

internal class HotReloadManifest {
    private init() { }

    private var _projectPath string = string.Empty

    prop ProjectPath string {
        get {
            return _projectPath
        }
        private set {
            _projectPath = value
        }
    }

    private var _targetFramework string = string.Empty

    prop TargetFramework string {
        get {
            return _targetFramework
        }
        private set {
            _targetFramework = value
        }
    }

    private var _configuration string = string.Empty

    prop Configuration string {
        get {
            return _configuration
        }
        private set {
            _configuration = value
        }
    }

    private var _assemblyName string = string.Empty

    prop AssemblyName string {
        get {
            return _assemblyName
        }
        private set {
            _assemblyName = value
        }
    }

    private var _updateDirectory string = string.Empty

    prop UpdateDirectory string {
        get {
            return _updateDirectory
        }
        private set {
            _updateDirectory = value
        }
    }

    private var _intermediateDirectory string = string.Empty

    prop IntermediateDirectory string {
        get {
            return _intermediateDirectory
        }
        private set {
            _intermediateDirectory = value
        }
    }

    private var _outputDirectory string = string.Empty

    prop OutputDirectory string {
        get {
            return _outputDirectory
        }
        private set {
            _outputDirectory = value
        }
    }

    private var _watchedFiles IReadOnlyDictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal)

    prop WatchedFiles IReadOnlyDictionary[string, string] {
        get {
            return _watchedFiles
        }
        private set {
            _watchedFiles = value
        }
    }

    prop ProjectDirectory string -> Path.GetDirectoryName(this.ProjectPath) ?? Environment.CurrentDirectory

    func HasChangesSinceBuild() bool {
        for pair in this.WatchedFiles {
            if !string.Equals(ComputeHash(pair.Key), pair.Value, StringComparison.Ordinal) {
                return true
            }
        }
        return false
    }

    shared {
        private const Header string = "GSHARP-HOT-RELOAD-1"
        private prop PathComparer StringComparer -> if OperatingSystem.IsWindows() {
            StringComparer.OrdinalIgnoreCase
        } else {
            StringComparer.Ordinal
        }

        func Load(path string) HotReloadManifest {
            let lines = File.ReadAllLines(path)
            if lines.Length == 0 || !string.Equals(lines[0], Header, StringComparison.Ordinal) {
                throw InvalidDataException("Unsupported G# hot-reload manifest '$path'.")
            }
            let manifest = HotReloadManifest()
            let watchedFiles = Dictionary[string, string](PathComparer)
            for var i = 1; i < lines.Length; i++ {
                let parts = lines[i].Split('\t')
                if parts.Length < 2 {
                    continue
                }
                switch parts[0] {
                    case "project" {
                        manifest.ProjectPath = Decode(parts[1])
                    }
                    case "targetFramework" {
                        manifest.TargetFramework = Decode(parts[1])
                    }
                    case "configuration" {
                        manifest.Configuration = Decode(parts[1])
                    }
                    case "assemblyName" {
                        manifest.AssemblyName = Decode(parts[1])
                    }
                    case "updateDirectory" {
                        manifest.UpdateDirectory = Decode(parts[1])
                    }
                    case "intermediateDirectory" {
                        manifest.IntermediateDirectory = Decode(parts[1])
                    }
                    case "outputDirectory" {
                        manifest.OutputDirectory = Decode(parts[1])
                    }
                    case "watch" when parts.Length >= 3 {
                        watchedFiles[Decode(parts[1])] = parts[2]
                    }
                }
            }
            if string.IsNullOrWhiteSpace(manifest.ProjectPath) || string.IsNullOrWhiteSpace(manifest.TargetFramework) ||
                string.IsNullOrWhiteSpace(manifest.AssemblyName) || string.IsNullOrWhiteSpace(
                manifest.UpdateDirectory
            ) {
                throw InvalidDataException("Incomplete G# hot-reload manifest '$path'.")
            }
            manifest.WatchedFiles = watchedFiles
            return manifest
        }

        private func Decode(value string) string -> Encoding.UTF8.GetString(Convert.FromBase64String(value))

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
                return Convert.ToHexString(sha.ComputeHash(stream))
            } catch (IOException) {
                return "unreadable"
            } catch (UnauthorizedAccessException) {
                return "unreadable"
            }
        }
    }
}
