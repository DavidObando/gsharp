// <copyright file="HostAnalyzerConfigOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import System
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.Diagnostics

/// ADR-0145 §C: an (cref:AnalyzerConfigOptionsProvider) that surfaces the
/// MSBuild-derived options a Roslyn generator reads — project-wide
/// `build_property.*` globals (e.g. `RootNamespace`, `ProjectDir`,
/// `AvaloniaNameGeneratorBehavior`) and per-(cref:AdditionalText)
/// `build_metadata.AdditionalFiles.*` pairs (e.g. `SourceItemGroup`).
/// This is what lets a file/options-driven generator such as Avalonia's XAML
/// name generator (issue #2223) recognize and process its inputs.
class HostAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider {
    private let global AnalyzerConfigOptions

    /// Initializes a new instance of the (cref:HostAnalyzerConfigOptionsProvider) class.
    /// @param globalOptions The project-wide `build_property.*` options (keys already prefixed).
    init(globalOptions IReadOnlyDictionary[string, string]) {
        this.global = DictionaryOptions(globalOptions ?? Dictionary[string, string](StringComparer.OrdinalIgnoreCase))
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop GlobalOptions AnalyzerConfigOptions -> this.global

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetOptions(tree SyntaxTree) AnalyzerConfigOptions -> this.global

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetOptions(textFile AdditionalText) AnalyzerConfigOptions {
        if textFile is HostAdditionalText host && host.Metadata.Count > 0 {
            let merged = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
            for kvp in host.Metadata {
                merged["build_metadata.AdditionalFiles." + kvp.Key] = kvp.Value
            }
            return DictionaryOptions(merged, fallback: this.global)
        }
        return this.global
    }

    private class DictionaryOptions : AnalyzerConfigOptions {
        private let values IReadOnlyDictionary[string, string]
        private let fallback AnalyzerConfigOptions?

        init(values IReadOnlyDictionary[string, string], fallback AnalyzerConfigOptions? = nil) {
            this.values = values
            this.fallback = fallback
        }

        override func TryGetValue(key string, @NotNullWhen(true) out value string?) bool {
            if this.values.TryGetValue(key, out value) && value != nil {
                return true
            }
            if this.fallback != nil {
                return this.fallback.TryGetValue(key, out value)
            }
            value = nil
            return false
        }
    }
}
