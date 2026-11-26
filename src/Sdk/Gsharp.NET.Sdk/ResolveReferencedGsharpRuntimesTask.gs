// <copyright file="ResolveReferencedGsharpRuntimesTask.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.NET.Sdk.Tools

import Microsoft.Build.Framework
import Microsoft.Build.Utilities
import System
import System.Collections.Generic
import System.IO

/// Issue #6249: inspects an emitted assembly's `AssemblyRef` table and computes
/// the transitive closure of SDK-bundled G# runtime assemblies it depends on so
/// `dotnet pack` can ship them alongside the library inside the `.nupkg`.
open class ResolveReferencedGsharpRuntimesTask : Task {
    private var _candidates[]ITaskItem = Array.Empty[ITaskItem]()!!
    private var _referencedRuntimes[]ITaskItem = Array.Empty[ITaskItem]()!!

    /// Path to the emitted assembly (either `$(TargetPath)` for `lib/<tfm>/` or
    /// `$(TargetRefPath)` for `ref/<tfm>/`).
    @Required
    prop AssemblyPath string?

    /// Candidate SDK-bundled runtime assemblies (for example
    /// `Gsharp.Extensions.dll`, `Gsharp.Runtime.Channels.dll`,
    /// `Gsharp.Runtime.Values.dll`).
    @Required
    prop BundledRuntimeCandidates[]ITaskItem {
        get {
            return _candidates
        }
        set {
            _candidates = value ?? Array.Empty[ITaskItem]()!!
        }
    }

    /// Transitively referenced bundled runtime assemblies in deterministic
    /// ordinal order by assembly simple name.
    @Output
    prop ReferencedRuntimes[]ITaskItem {
        get {
            return _referencedRuntimes
        }
        set {
            _referencedRuntimes = value ?? Array.Empty[ITaskItem]()!!
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    open override func Execute() bool {
        this._referencedRuntimes = Array.Empty[ITaskItem]()!!
        if string.IsNullOrEmpty(this.AssemblyPath) || !File.Exists(this.AssemblyPath) {
            return true
        }

        let candidatesByName = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
        for item in this.BundledRuntimeCandidates {
            let fullPath = item.ItemSpec
            if string.IsNullOrEmpty(fullPath) || !File.Exists(fullPath) {
                continue
            }
            let simpleName = Path.GetFileNameWithoutExtension(fullPath)
            if !string.IsNullOrEmpty(simpleName) && !candidatesByName.ContainsKey(simpleName) {
                candidatesByName[simpleName] = fullPath
            }
        }

        let resolvedNames = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let queue = Queue[string]()
        queue.Enqueue(this.AssemblyPath!!)

        try {
            while queue.Count > 0 {
                let currentPath = queue.Dequeue()
                let refs = PeAssemblyReferenceReader.ReadAssemblyReferenceNames(currentPath)
                for refName in refs {
                    if resolvedNames.Contains(refName) {
                        continue
                    }
                    if candidatesByName.TryGetValue(refName, out var candidatePath) {
                        resolvedNames.Add(refName)
                        queue.Enqueue(candidatePath)
                    } else if IsKnownBundledRuntimeName(refName) {
                        let fileName = Path.GetFileName(currentPath)
                        this.Log.LogWarning(
                            "Assembly '" +
                                fileName +
                                "' references bundled G# runtime '" +
                                refName +
                                "', but it was not found among the SDK runtime candidates and will not be packed."
                        )
                    }
                }
            }
        } catch (ex Exception) {
            this.Log.LogWarning(
                "Could not inspect assembly references of '" +
                    this.AssemblyPath +
                    "' while resolving bundled G# runtimes for pack: " +
                    ex.Message
            )
            return true
        }

        if resolvedNames.Count == 0 {
            return true
        }

        let sortedNames = List[string](resolvedNames)
        sortedNames.Sort(StringComparer.Ordinal)
        let results = List[ITaskItem](sortedNames.Count)
        for name in sortedNames {
            results.Add(TaskItem(candidatesByName[name]))
        }
        this._referencedRuntimes = results.ToArray()
        return !this.Log.HasLoggedErrors
    }

    private func IsKnownBundledRuntimeName(name string) bool ->
    string.Equals(name, "Gsharp.Extensions", StringComparison.OrdinalIgnoreCase) || string.Equals(
        name,
        "Gsharp.Runtime.Channels",
        StringComparison.OrdinalIgnoreCase
    ) ||
        string.Equals(name, "Gsharp.Runtime.Values", StringComparison.OrdinalIgnoreCase)
}
