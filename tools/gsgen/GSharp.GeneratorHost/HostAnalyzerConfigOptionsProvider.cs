// <copyright file="HostAnalyzerConfigOptions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0145 §C: an <see cref="AnalyzerConfigOptionsProvider"/> that surfaces the
/// MSBuild-derived options a Roslyn generator reads — project-wide
/// <c>build_property.*</c> globals (e.g. <c>RootNamespace</c>, <c>ProjectDir</c>,
/// <c>AvaloniaNameGeneratorBehavior</c>) and per-<see cref="AdditionalText"/>
/// <c>build_metadata.AdditionalFiles.*</c> pairs (e.g. <c>SourceItemGroup</c>).
/// This is what lets a file/options-driven generator such as Avalonia's XAML
/// name generator (issue #2223) recognize and process its inputs.
/// </summary>
public sealed class HostAnalyzerConfigOptionsProvider : AnalyzerConfigOptionsProvider
{
    private readonly AnalyzerConfigOptions global;

    /// <summary>
    /// Initializes a new instance of the <see cref="HostAnalyzerConfigOptionsProvider"/> class.
    /// </summary>
    /// <param name="globalOptions">The project-wide <c>build_property.*</c> options (keys already prefixed).</param>
    public HostAnalyzerConfigOptionsProvider(IReadOnlyDictionary<string, string> globalOptions)
    {
        this.global = new DictionaryOptions(globalOptions ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
    }

    /// <inheritdoc/>
    public override AnalyzerConfigOptions GlobalOptions => this.global;

    /// <inheritdoc/>
    public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => this.global;

    /// <inheritdoc/>
    public override AnalyzerConfigOptions GetOptions(AdditionalText textFile)
    {
        if (textFile is HostAdditionalText host && host.Metadata.Count > 0)
        {
            var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kvp in host.Metadata)
            {
                merged["build_metadata.AdditionalFiles." + kvp.Key] = kvp.Value;
            }

            return new DictionaryOptions(merged, fallback: this.global);
        }

        return this.global;
    }

    private sealed class DictionaryOptions : AnalyzerConfigOptions
    {
        private readonly IReadOnlyDictionary<string, string> values;
        private readonly AnalyzerConfigOptions fallback;

        public DictionaryOptions(IReadOnlyDictionary<string, string> values, AnalyzerConfigOptions fallback = null)
        {
            this.values = values;
            this.fallback = fallback;
        }

        public override bool TryGetValue(string key, [NotNullWhen(true)] out string value)
        {
            if (this.values.TryGetValue(key, out value) && value is not null)
            {
                return true;
            }

            if (this.fallback is not null)
            {
                return this.fallback.TryGetValue(key, out value);
            }

            value = null;
            return false;
        }
    }
}
