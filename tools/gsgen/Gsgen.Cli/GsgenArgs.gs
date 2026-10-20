// <copyright file="GsgenArgs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Gsgen.Cli

import System
import System.Collections.Generic
import System.IO

/// Parsed one-shot invocation for the `gsgen` tool (ADR-0145 §A/§F). The
/// tool is invoked as `dotnet gsgen.dll @file.rsp`; .NET's response-file
/// expansion splits the `@file` into one argument per line before
/// `Main` is reached, so (cref:Parse) only has to interpret the
/// already-split `/flag:value` tokens.
class GsgenArgs {
    init() {
        GsFiles = List[string]()
        References = List[string]()
        AnalyzerPaths = List[string]()
        CsFiles = List[string]()
        AdditionalFiles = List[AdditionalFileSpec]()
        GlobalOptions = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
    }

    /// Gets the G# source files (`/gs:`), required except for existing-manifest cleanup without generators or C#.
    prop GsFiles List[string] {
        get;
    }

    /// Gets the metadata reference assembly paths (`/r:`).
    prop References List[string] {
        get;
    }

    /// Gets the analyzer/generator assembly paths (`/analyzer:`).
    prop AnalyzerPaths List[string] {
        get;
    }

    /// Gets the "foreign" C# source files (`/csfile:`) to translate
    /// directly to G# (issue #2214 / ADR-0145 extension) — a stray `.cs`
    /// `Compile` item the SDK found in the project (e.g. Nerdbank.
    /// GitVersioning's generated `ThisAssembly.cs`), as opposed to the
    /// `.gs` sources gsgen projects to a stub and runs generators over.
    prop CsFiles List[string] {
        get;
    }

    /// Gets the additional (non-source) files (`/additionalfile:`) forwarded
    /// to generators as Roslyn `AdditionalText` (issue #2223 — Avalonia
    /// `.axaml`). Each entry is `path` optionally followed by
    /// `;key=value` MSBuild-metadata pairs (e.g.
    /// `;SourceItemGroup=AvaloniaXaml`) that become
    /// `build_metadata.AdditionalFiles.*` options for that file.
    prop AdditionalFiles List[AdditionalFileSpec] {
        get;
    }

    /// Gets the project-wide generator options (`/globaloption:`) forwarded
    /// as `build_property.*` global `AnalyzerConfigOptions` (e.g.
    /// `RootNamespace`, `AvaloniaNameGeneratorBehavior`). Keys are
    /// stored already prefixed with `build_property.`.
    prop GlobalOptions Dictionary[string, string] {
        get;
    }

    /// Gets or sets the output directory for generated `.g.gs` files (`/out:`). Required.
    prop OutDir string

    /// Gets or sets the optional root namespace (`/rootnamespace:`). Accepted; may be unused by the host.
    prop RootNamespace string

    /// Gets or sets the optional manifest path (`/manifest:`) that receives the newline-separated
    /// generated-file list.
    prop ManifestPath string

    /// Validates that the required flags are present, throwing an
    /// (cref:ArgumentException) (surfaced by the caller as a
    /// `GS9200` error) when they are not.
    func ValidateRequired() {
        if string.IsNullOrWhiteSpace(OutDir) {
            throw ArgumentException("missing required '/out:<dir>' argument.")
        }
        if GsFiles.Count == 0 && (AnalyzerPaths.Count > 0 || CsFiles.Count > 0 || !File.Exists(ManifestPath)) {
            throw ArgumentException("at least one '/gs:<path>' argument is required.")
        }
    }

    /// Verifies each `/gs:` file exists on disk, throwing a
    /// (cref:FileNotFoundException) (surfaced as `GS9200`) otherwise.
    func ValidateGsFilesExist() {
        for path in GsFiles {
            if !File.Exists(path) {
                throw FileNotFoundException("G# source file not found: '$path'.", path)
            }
        }
    }

    /// Verifies each `/csfile:` file exists on disk, throwing a
    /// (cref:FileNotFoundException) (surfaced as `GS9200`) otherwise.
    func ValidateCsFilesExist() {
        for path in CsFiles {
            if !File.Exists(path) {
                throw FileNotFoundException("C# source file not found: '$path'.", path)
            }
        }
    }

    /// Verifies each `/additionalfile:` file exists on disk, throwing a
    /// (cref:FileNotFoundException) (surfaced as `GS9200`) otherwise.
    func ValidateAdditionalFilesExist() {
        for spec in AdditionalFiles {
            if !File.Exists(spec.Path) {
                throw FileNotFoundException("additional file not found: '${spec.Path}'.", spec.Path)
            }
        }
    }

    shared {
        /// Parses the expanded response-file arguments. Unknown flags are reported
        /// through [`notes`](paramref) at low severity and otherwise ignored,
        /// so a forward-compatible SDK never crashes the tool.
        /// @param args The already response-file-expanded arguments.
        /// @param notes Collects human-readable notes about ignored/unknown tokens.
        /// @returns The parsed arguments.
        func Parse(args IEnumerable[string], notes ICollection[string]?) GsgenArgs {
            ArgumentNullException.ThrowIfNull(args, paramName: "args")
            let parsed = GsgenArgs()
            for raw in args {
                if string.IsNullOrWhiteSpace(raw) {
                    continue
                }
                let arg = raw.Trim()
                if TryMatch(arg, "/gs:", out var gs) {
                    parsed.GsFiles.Add(gs!!)
                } else if TryMatch(arg, "/r:", out var r) {
                    parsed.References.Add(r!!)
                } else if TryMatch(arg, "/analyzer:", out var analyzer) {
                    parsed.AnalyzerPaths.Add(analyzer!!)
                } else if TryMatch(arg, "/csfile:", out var csFile) {
                    parsed.CsFiles.Add(csFile!!)
                } else if TryMatch(arg, "/additionalfile:", out var additionalFile) {
                    let spec AdditionalFileSpec? = AdditionalFileSpec.Parse(additionalFile!!)
                    if spec != nil {
                        parsed.AdditionalFiles.Add(spec)
                    }
                } else if TryMatch(arg, "/globaloption:", out var globalOption) {
                    let eq = globalOption!!.IndexOf('=')
                    if eq > 0 {
                        let key = globalOption!!.Substring(0, eq).Trim()
                        let value = globalOption!!.Substring(eq + 1)
                        if key.Length > 0 {
                            let prefixed = if key.StartsWith("build_property.", StringComparison.OrdinalIgnoreCase) {
                                key
                            } else {
                                "build_property." + key
                            }
                            parsed.GlobalOptions[prefixed] = value
                        }
                    } else {
                        notes?.Add("ignoring malformed '/globaloption:' (expected key=value): '$arg'")
                    }
                } else if TryMatch(arg, "/out:", out var outDir) {
                    parsed.OutDir = outDir!!
                } else if TryMatch(arg, "/rootnamespace:", out var ns) {
                    parsed.RootNamespace = ns!!
                } else if TryMatch(arg, "/manifest:", out var manifest) {
                    parsed.ManifestPath = manifest!!
                } else {
                    notes?.Add("ignoring unrecognized argument '$arg'")
                }
            }
            return parsed
        }

        private func TryMatch(arg string, prefix string, out value string?) bool {
            if arg.StartsWith(prefix, StringComparison.Ordinal) {
                value = arg.Substring(prefix.Length)
                return true
            }
            value = nil
            return false
        }
    }
}

/// A parsed `/additionalfile:` entry: a file path plus optional
/// `;key=value` MSBuild-metadata pairs (e.g.
/// `;SourceItemGroup=AvaloniaXaml`) that become
/// `build_metadata.AdditionalFiles.*` options for that file.
class AdditionalFileSpec {
    private init(path string, metadata IReadOnlyDictionary[string, string]) {
        Path = path
        Metadata = metadata
    }

    /// Gets the additional file path.
    prop Path string {
        get;
    }

    /// Gets the `build_metadata.AdditionalFiles.*` pairs (key without the prefix).
    prop Metadata IReadOnlyDictionary[string, string] {
        get;
    }

    shared {
        /// Parses a `path[;key=value[;key=value...]]` spec. Returns
        /// `null` for a blank path.
        /// @param raw The raw value following `/additionalfile:`.
        /// @returns The parsed spec, or `null` when the path is blank.
        func Parse(raw string?) AdditionalFileSpec? {
            if string.IsNullOrWhiteSpace(raw) {
                return nil
            }
            let parts = raw.Split(';')
            let path = parts[0].Trim()
            if path.Length == 0 {
                return nil
            }
            let metadata = Dictionary[string, string](StringComparer.OrdinalIgnoreCase)
            for var i = 1; i < parts.Length; i++ {
                let part = parts[i]
                let eq = part.IndexOf('=')
                if eq > 0 {
                    let key = part.Substring(0, eq).Trim()
                    let value = part.Substring(eq + 1)
                    if key.Length > 0 {
                        metadata[key] = value
                    }
                }
            }
            return AdditionalFileSpec(path, metadata)
        }
    }
}
