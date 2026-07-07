// <copyright file="GsgenArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;

namespace GSharp.Gsgen.Cli;

/// <summary>
/// Parsed one-shot invocation for the <c>gsgen</c> tool (ADR-0145 §A/§F). The
/// tool is invoked as <c>dotnet gsgen.dll @file.rsp</c>; .NET's response-file
/// expansion splits the <c>@file</c> into one argument per line before
/// <c>Main</c> is reached, so <see cref="Parse"/> only has to interpret the
/// already-split <c>/flag:value</c> tokens.
/// </summary>
public sealed class GsgenArgs
{
    /// <summary>Gets the G# source files to include in the compilation (<c>/gs:</c>). At least one is required.</summary>
    public List<string> GsFiles { get; } = new();

    /// <summary>Gets the metadata reference assembly paths (<c>/r:</c>).</summary>
    public List<string> References { get; } = new();

    /// <summary>Gets the analyzer/generator assembly paths (<c>/analyzer:</c>).</summary>
    public List<string> AnalyzerPaths { get; } = new();

    /// <summary>
    /// Gets the "foreign" C# source files (<c>/csfile:</c>) to translate
    /// directly to G# (issue #2214 / ADR-0145 extension) — a stray <c>.cs</c>
    /// <c>Compile</c> item the SDK found in the project (e.g. Nerdbank.
    /// GitVersioning's generated <c>ThisAssembly.cs</c>), as opposed to the
    /// <c>.gs</c> sources gsgen projects to a stub and runs generators over.
    /// </summary>
    public List<string> CsFiles { get; } = new();

    /// <summary>
    /// Gets the additional (non-source) files (<c>/additionalfile:</c>) forwarded
    /// to generators as Roslyn <c>AdditionalText</c> (issue #2223 — Avalonia
    /// <c>.axaml</c>). Each entry is <c>path</c> optionally followed by
    /// <c>;key=value</c> MSBuild-metadata pairs (e.g.
    /// <c>;SourceItemGroup=AvaloniaXaml</c>) that become
    /// <c>build_metadata.AdditionalFiles.*</c> options for that file.
    /// </summary>
    public List<AdditionalFileSpec> AdditionalFiles { get; } = new();

    /// <summary>
    /// Gets the project-wide generator options (<c>/globaloption:</c>) forwarded
    /// as <c>build_property.*</c> global <c>AnalyzerConfigOptions</c> (e.g.
    /// <c>RootNamespace</c>, <c>AvaloniaNameGeneratorBehavior</c>). Keys are
    /// stored already prefixed with <c>build_property.</c>.
    /// </summary>
    public Dictionary<string, string> GlobalOptions { get; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets or sets the output directory for generated <c>.g.gs</c> files (<c>/out:</c>). Required.</summary>
    public string OutDir { get; set; }

    /// <summary>Gets or sets the optional root namespace (<c>/rootnamespace:</c>). Accepted; may be unused by the host.</summary>
    public string RootNamespace { get; set; }

    /// <summary>Gets or sets the optional manifest path (<c>/manifest:</c>) that receives the newline-separated generated-file list.</summary>
    public string ManifestPath { get; set; }

    /// <summary>
    /// Parses the expanded response-file arguments. Unknown flags are reported
    /// through <paramref name="notes"/> at low severity and otherwise ignored,
    /// so a forward-compatible SDK never crashes the tool.
    /// </summary>
    /// <param name="args">The already response-file-expanded arguments.</param>
    /// <param name="notes">Collects human-readable notes about ignored/unknown tokens.</param>
    /// <returns>The parsed arguments.</returns>
    public static GsgenArgs Parse(IEnumerable<string> args, ICollection<string> notes)
    {
        ArgumentNullException.ThrowIfNull(args);
        var parsed = new GsgenArgs();

        foreach (var raw in args)
        {
            if (string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }

            var arg = raw.Trim();

            if (TryMatch(arg, "/gs:", out var gs))
            {
                parsed.GsFiles.Add(gs);
            }
            else if (TryMatch(arg, "/r:", out var r))
            {
                parsed.References.Add(r);
            }
            else if (TryMatch(arg, "/analyzer:", out var analyzer))
            {
                parsed.AnalyzerPaths.Add(analyzer);
            }
            else if (TryMatch(arg, "/csfile:", out var csFile))
            {
                parsed.CsFiles.Add(csFile);
            }
            else if (TryMatch(arg, "/additionalfile:", out var additionalFile))
            {
                var spec = AdditionalFileSpec.Parse(additionalFile);
                if (spec is not null)
                {
                    parsed.AdditionalFiles.Add(spec);
                }
            }
            else if (TryMatch(arg, "/globaloption:", out var globalOption))
            {
                int eq = globalOption.IndexOf('=');
                if (eq > 0)
                {
                    var key = globalOption.Substring(0, eq).Trim();
                    var value = globalOption.Substring(eq + 1);
                    if (key.Length > 0)
                    {
                        var prefixed = key.StartsWith("build_property.", StringComparison.OrdinalIgnoreCase)
                            ? key
                            : "build_property." + key;
                        parsed.GlobalOptions[prefixed] = value;
                    }
                }
                else
                {
                    notes?.Add($"ignoring malformed '/globaloption:' (expected key=value): '{arg}'");
                }
            }
            else if (TryMatch(arg, "/out:", out var outDir))
            {
                parsed.OutDir = outDir;
            }
            else if (TryMatch(arg, "/rootnamespace:", out var ns))
            {
                parsed.RootNamespace = ns;
            }
            else if (TryMatch(arg, "/manifest:", out var manifest))
            {
                parsed.ManifestPath = manifest;
            }
            else
            {
                notes?.Add($"ignoring unrecognized argument '{arg}'");
            }
        }

        return parsed;
    }

    /// <summary>
    /// Validates that the required flags are present, throwing an
    /// <see cref="ArgumentException"/> (surfaced by the caller as a
    /// <c>GS9200</c> error) when they are not.
    /// </summary>
    public void ValidateRequired()
    {
        if (string.IsNullOrWhiteSpace(OutDir))
        {
            throw new ArgumentException("missing required '/out:<dir>' argument.");
        }

        if (GsFiles.Count == 0)
        {
            throw new ArgumentException("at least one '/gs:<path>' argument is required.");
        }
    }

    /// <summary>
    /// Verifies each <c>/gs:</c> file exists on disk, throwing a
    /// <see cref="FileNotFoundException"/> (surfaced as <c>GS9200</c>) otherwise.
    /// </summary>
    public void ValidateGsFilesExist()
    {
        foreach (var path in GsFiles)
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"G# source file not found: '{path}'.", path);
            }
        }
    }

    /// <summary>
    /// Verifies each <c>/csfile:</c> file exists on disk, throwing a
    /// <see cref="FileNotFoundException"/> (surfaced as <c>GS9200</c>) otherwise.
    /// </summary>
    public void ValidateCsFilesExist()
    {
        foreach (var path in CsFiles)
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"C# source file not found: '{path}'.", path);
            }
        }
    }

    /// <summary>
    /// Verifies each <c>/additionalfile:</c> file exists on disk, throwing a
    /// <see cref="FileNotFoundException"/> (surfaced as <c>GS9200</c>) otherwise.
    /// </summary>
    public void ValidateAdditionalFilesExist()
    {
        foreach (var spec in AdditionalFiles)
        {
            if (!File.Exists(spec.Path))
            {
                throw new FileNotFoundException($"additional file not found: '{spec.Path}'.", spec.Path);
            }
        }
    }

    private static bool TryMatch(string arg, string prefix, out string value)
    {
        if (arg.StartsWith(prefix, StringComparison.Ordinal))
        {
            value = arg.Substring(prefix.Length);
            return true;
        }

        value = null;
        return false;
    }
}

/// <summary>
/// A parsed <c>/additionalfile:</c> entry: a file path plus optional
/// <c>;key=value</c> MSBuild-metadata pairs (e.g.
/// <c>;SourceItemGroup=AvaloniaXaml</c>) that become
/// <c>build_metadata.AdditionalFiles.*</c> options for that file.
/// </summary>
public sealed class AdditionalFileSpec
{
    private AdditionalFileSpec(string path, IReadOnlyDictionary<string, string> metadata)
    {
        Path = path;
        Metadata = metadata;
    }

    /// <summary>Gets the additional file path.</summary>
    public string Path { get; }

    /// <summary>Gets the <c>build_metadata.AdditionalFiles.*</c> pairs (key without the prefix).</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; }

    /// <summary>
    /// Parses a <c>path[;key=value[;key=value...]]</c> spec. Returns
    /// <see langword="null"/> for a blank path.
    /// </summary>
    /// <param name="raw">The raw value following <c>/additionalfile:</c>.</param>
    /// <returns>The parsed spec, or <see langword="null"/> when the path is blank.</returns>
    public static AdditionalFileSpec Parse(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var parts = raw.Split(';');
        var path = parts[0].Trim();
        if (path.Length == 0)
        {
            return null;
        }

        var metadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < parts.Length; i++)
        {
            var part = parts[i];
            int eq = part.IndexOf('=');
            if (eq > 0)
            {
                var key = part.Substring(0, eq).Trim();
                var value = part.Substring(eq + 1);
                if (key.Length > 0)
                {
                    metadata[key] = value;
                }
            }
        }

        return new AdditionalFileSpec(path, metadata);
    }
}
