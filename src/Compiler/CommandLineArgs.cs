// <copyright file="CommandLineArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Diagnostics;
using GSharp.Core.CodeAnalysis.Emit;

namespace GSharp.Compiler;

internal sealed class CommandLineArgs
{
    public List<string> SourceFiles { get; } = new();

    public List<string> References { get; } = new();

    /// <summary>Gets the managed resources to embed, as source path and logical name pairs.</summary>
    public List<(string Path, string Name, bool IsPublic)> Resources { get; } = new();

    /// <summary>Gets the analyzer/generator assembly paths (from /analyzer:&lt;path&gt;). Non-empty triggers a gsgen run (issue #2215).</summary>
    public List<string> AnalyzerPaths { get; } = new();

    /// <summary>Gets the raw additional-file specs (from /additionalfile:&lt;path[;key=value]&gt;) forwarded to gsgen (issue #2223).</summary>
    public List<string> AdditionalFiles { get; } = new();

    /// <summary>Gets the raw generator global options (from /globaloption:&lt;key=value&gt;) forwarded to gsgen (issue #2223).</summary>
    public List<string> GlobalOptions { get; } = new();

    /// <summary>Gets or sets an explicit override for the resolved gsgen.dll path (from /gsgentool:&lt;path&gt;).</summary>
    public string? GsgenToolPath { get; set; }

    public string? OutputPath { get; set; }

    public string? RefOutputPath { get; set; }

    public string? AssemblyName { get; set; }

    public OutputTarget Target { get; set; } = OutputTarget.Exe;

    public string? TargetFramework { get; set; }

    public bool ShowHelp { get; set; }

    public bool ImplicitSystemImport { get; set; } = true;

    /// <summary>Gets the set of diagnostic IDs to suppress (from /nowarn).</summary>
    public HashSet<string> NoWarnIds { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets or sets a value indicating whether all warnings should be treated as errors (from /warnaserror without IDs).</summary>
    public bool TreatAllWarningsAsErrors { get; set; }

    /// <summary>Gets the set of diagnostic IDs that should be promoted to errors (from /warnaserror+:&lt;ids&gt;).</summary>
    public HashSet<string> WarnAsErrorIds { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets the set of diagnostic IDs that should remain as warnings (from /warnaserror-:&lt;ids&gt;), overriding /warnaserror.</summary>
    public HashSet<string> WarnNotAsErrorIds { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Gets or sets the requested PDB emit format (from /debug, /debug:&lt;value&gt;, /debug+/-). Defaults to None.</summary>
    public DebugInformationFormat DebugFormat { get; set; } = DebugInformationFormat.None;

    /// <summary>Gets or sets a value indicating whether emitted assemblies allow JIT optimization (from /optimize, /optimize+/-). Defaults to true.</summary>
    public bool Optimize { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether a /debug, /debug+, or /debug- switch was observed on the command line. Used so that a bare /pdb:&lt;path&gt; can default the format to Portable without overriding a later /debug-.</summary>
    public bool DebugFlagSeen { get; set; }

    /// <summary>Gets or sets the explicit sidecar PDB path (from /pdb:&lt;path&gt;). Null means "default to {OutputPath}.pdb".</summary>
    public string? PdbPath { get; set; }

    /// <summary>Gets or sets the XML documentation output path (from /doc:&lt;path&gt;).</summary>
    public string? DocumentationFile { get; set; }

    /// <summary>Gets or sets the path to a Source Link JSON file (from /sourcelink:&lt;path&gt;).</summary>
    public string? SourceLinkPath { get; set; }

    /// <summary>Gets or sets a value indicating whether the emit should be deterministic (from /deterministic, /deterministic+/-).</summary>
    public bool Deterministic { get; set; }

    /// <summary>Gets or sets a value indicating whether all primary source files are embedded in the Portable PDB (from /embed, /embed+/-).</summary>
    public bool EmbedAllSources { get; set; }

    /// <summary>Gets or sets the informational version string stamped on the output assembly (from /version:).</summary>
    public string? Version { get; set; }

    /// <summary>Gets or sets the log file path (from /log:&lt;file&gt;). When non-null, a <see cref="FileLogger"/> is created and attached to the compilation.</summary>
    public string? LogPath { get; set; }
}
