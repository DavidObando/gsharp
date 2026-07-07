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
