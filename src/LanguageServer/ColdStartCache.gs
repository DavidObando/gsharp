// <copyright file="ColdStartCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Security
import System.Security.Cryptography
import System.Text

/// ADR-0107: the language server's cross-session cold-start cache. A single
/// human-readable text file per project, `<AssemblyName>.gsproj.lscache`,
/// sitting next to the project file and following the C# Dev Kit `.lscache`
/// format/conventions.
/// @remarks The cache carries two layers:
///
/// 1. A <em>project-system snapshot</em> — the resolved metadata reference set (the `.rsp`-equivalent),
/// the assembly name, target framework, and a source fingerprint — in the `[project]` and
/// `[references]` sections. This lets a checkout describe its reference set <em>without re-running the
/// build</em>: when no `.rsp` is present (a fresh clone or after `dotnet clean`, since the `.rsp` lives
/// in the gitignored `obj/`), the language server bootstraps reference resolution straight from the
/// cache (see (cref:TryBootstrapReferences)).
/// 2. The reference-metadata <em>type-name index</em> ((cref:ReferenceMetadataIndex)) in the
/// `[metadataIndex]` text section, so a subsequent process can skip the ~120 ms
/// `Assembly.GetTypes()`/`GetForwardedTypes()` enumeration of the whole reference closure.
///
/// The whole descriptor is a single text file — the ~25 000-name index parses in
/// ~4 ms, indistinguishable in practice from a binary blob (~2 ms) and far below
/// the enumeration it replaces, so there is no separate `.lscache.bin`. The
/// file begins with a `version=N` header and a human-readable `#` comment
/// block (purpose, generated/do-not-edit, safe-to-delete/auto-regenerate, gitignore
/// guidance, committable opt-in note, and the opt-out env var), followed by
/// `[project]`, `[fingerprint]`, `[references]`, and
/// `[metadataIndex]` sections.
///
/// Correctness is conservative. The metadata index is trusted only when the
/// recorded <em>fingerprint</em> (cache-format version, compiler version, index
/// format version, target framework, source fingerprint, and the ordered reference
/// set with each file's size and last-write time — deliberately <em>not</em> the
/// `.rsp`) matches the current project, <em>and</em> the index section's
/// SHA-256 matches the recorded one (integrity), <em>and</em> the section parses
/// cleanly. The bootstrap reference set is trusted only when every recorded DLL
/// still exists and matches its recorded size:mtime stamp (assembly identity is
/// re-checked when the index is adopted). Any mismatch, missing file, version
/// change, or corruption yields a miss and the caller falls back to the normal
/// cold build (or, for references, to today's empty/degraded behavior).
/// Under-invalidation would be a correctness bug; over-invalidation is always safe.
/// No method here ever throws into the LSP pipeline.
///
/// Opt-out: set the environment variable
/// `GSHARP_DISABLE_COLD_START_CACHE` to `1`/`true`/`on`/`yes`
/// (mirroring C#'s `dotnet.projectsystem.enableLanguageServiceCache`
/// setting). The cache file is safe to delete at any time and auto-regenerates.
internal shared class ColdStartCache {
    /// The descriptor format version. Bump on any descriptor-layout change so an
    /// older or newer descriptor is treated as a miss rather than misparsed. This
    /// is folded into the fingerprint, so a bump invalidates every existing cache.
    internal const DescriptorVersion int32 = 2

    private const DescriptorSuffix string = ".gsproj.lscache"
    private const DisableEnvVar string = "GSHARP_DISABLE_COLD_START_CACHE"
    private let CommentBlock[]string = []string{
        "# GSharp language-service cold-start cache (ADR-0107).",
        "# Caches the resolved reference set and reference-metadata type-name index",
        "# so the G# language server can resume a project — and resolve imported types",
        "# before the first build — without re-scanning every referenced assembly.",
        "# Generated; do not edit. Safe to delete at any time; it regenerates",
        "# automatically. By default it is gitignored (*.lscache). A team MAY instead",
        "# commit this file for fast fresh-clone opens; the reference stamps and",
        "# source/fingerprint hashes make that sound. Note: a committed cache still",
        "# needs the referenced DLLs present — `dotnet restore` brings NuGet package",
        "# DLLs, but project-reference DLLs require those projects to be built — so it",
        "# helps after restore/clean, not from a zero-dependency checkout.",
        "# To disable the cache entirely, set " + DisableEnvVar + "=1."
    }

    /// Gets a value indicating whether the cache is disabled via the opt-out
    /// environment variable. When disabled, (cref:TryLoad),
    /// (cref:Save), and (cref:TryBootstrapReferences) are no-ops and
    /// the resolver stays on the cold path (behaviour identical to before
    /// ADR-0107).
    internal prop Disabled bool {
        get {
            let value = Environment.GetEnvironmentVariable(DisableEnvVar)
            if string.IsNullOrEmpty(value) {
                return false
            }
            return value.Equals("1", StringComparison.OrdinalIgnoreCase) || value.Equals(
                "true",
                StringComparison.OrdinalIgnoreCase
            ) ||
                value.Equals("on", StringComparison.OrdinalIgnoreCase) || value.Equals(
                "yes",
                StringComparison.OrdinalIgnoreCase
            )
        }
    }

    private prop CompilerVersion string -> typeof(ReferenceMetadataIndex)
        .Assembly
        .GetName()
        .Version
        ?.ToString() ??
        "0.0.0.0"

    /// Attempts to load a fingerprint-matching metadata index for the project.
    /// Returns `null` on opt-out, a missing/stale/corrupt cache,
    /// or any I/O error — the caller then performs a normal cold build. Never
    /// throws.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param assemblyName The project's effective assembly name (cache basename); falls back to the
    /// project file's base name when null/empty.
    /// @param references The current ordered reference paths (from the `.rsp`, or bootstrapped from this
    /// cache).
    /// @param rspPath The `.rsp` the references came from, recorded for information only (may be null). Not
    /// part of the fingerprint.
    /// @param sourceFingerprint A hash over the project's current source set (path + content), or
    /// null/empty when unavailable.
    /// @param targetFramework The project's target framework moniker, or null/empty when unknown.
    /// @returns A validated index, or `null` for a cache miss.
    internal func TryLoad(
        projectFilePath string,
        assemblyName string,
        references IReadOnlyList[string],
        rspPath string?,
        sourceFingerprint string?,
        targetFramework string?
    ) ReferenceMetadataIndex? {
        if Disabled || string.IsNullOrEmpty(projectFilePath) {
            return nil
        }
        try {
            let descriptorPath = DescriptorPath(projectFilePath, assemblyName)
            if !File.Exists(descriptorPath) {
                return nil
            }
            let lines = File.ReadAllLines(descriptorPath)
            let fields = ParseHeaderFields(lines)
            if !fields.TryGetValue("version", out var versionText) || versionText != DescriptorVersion.ToString(
                CultureInfo.InvariantCulture
            ) {
                return nil
            }
            let expectedFingerprint = ComputeFingerprint(references, sourceFingerprint, targetFramework)
            if !fields.TryGetValue("fingerprint", out var storedFingerprint) || !string.Equals(
                storedFingerprint,
                expectedFingerprint,
                StringComparison.Ordinal
            ) {
                return nil
            }
            if !ReferenceMetadataIndex.TryReadTextSection(lines, out var index) || index == nil {
                return nil
            }
            // Integrity: re-hash the canonical serialization of the parsed index
            // and compare to the recorded hash. This rejects in-place corruption
            // (e.g. a flipped type name) that still parses structurally.
            if !fields.TryGetValue("indexSha256", out var storedIndexHash) || !string.Equals(
                storedIndexHash,
                ComputeIndexHash(index),
                StringComparison.Ordinal
            ) {
                return nil
            }
            return index
        } catch (ex Exception) when IsRecoverable(ex) {
            return nil
        }
    }

    /// Attempts to recover the resolved reference set from a previously-written
    /// cache so the language server can resolve imported types <em>without</em> a
    /// `.rsp` (a fresh clone, or after `dotnet clean`, deletes the
    /// `obj/` `.rsp`). Every recorded reference DLL must still exist and
    /// match its recorded size:mtime stamp; if any is missing or changed (or the
    /// cache is absent/corrupt/disabled), returns `null` and the
    /// caller keeps today's empty/degraded behavior. Never throws.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param assemblyName The project's effective assembly name (cache basename).
    /// @returns The validated, ordered reference paths, or `null` for a miss.
    internal func TryBootstrapReferences(projectFilePath string, assemblyName string) IReadOnlyList[string]? {
        if Disabled || string.IsNullOrEmpty(projectFilePath) {
            return nil
        }
        try {
            let descriptorPath = DescriptorPath(projectFilePath, assemblyName)
            if !File.Exists(descriptorPath) {
                return nil
            }
            let lines = File.ReadAllLines(descriptorPath)
            let fields = ParseHeaderFields(lines)
            if !fields.TryGetValue("version", out var versionText) || versionText != DescriptorVersion.ToString(
                CultureInfo.InvariantCulture
            ) {
                return nil
            }
            let recorded = ParseReferenceSection(lines)
            if recorded.Count == 0 {
                return nil
            }
            let validated = List[string](recorded.Count)
            for (path, stamp) in recorded {
                if string.IsNullOrEmpty(path) || !File.Exists(path) || !string.Equals(
                    FileStamp(path),
                    stamp,
                    StringComparison.Ordinal
                ) {
                    // A missing or changed reference: never resolve against a
                    // stale reference set. Fall back to today's behavior.
                    return nil
                }
                validated.Add(path)
            }
            return validated
        } catch (ex Exception) when IsRecoverable(ex) {
            return nil
        }
    }

    /// Writes the single descriptor for the project, overwriting any previous
    /// cache. No-op on opt-out. Never throws: a failed write simply leaves the
    /// next start cold.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param assemblyName The project's effective assembly name (cache basename).
    /// @param references The current ordered reference paths.
    /// @param rspPath The `.rsp` the references came from, recorded for information only (may be null).
    /// @param sourceFingerprint A hash over the project's current source set (path + content), or
    /// null/empty when unavailable.
    /// @param targetFramework The project's target framework moniker, or null/empty when unknown.
    /// @param index The metadata index to persist.
    internal func Save(
        projectFilePath string,
        assemblyName string,
        references IReadOnlyList[string],
        rspPath string?,
        sourceFingerprint string?,
        targetFramework string?,
        index ReferenceMetadataIndex?
    ) {
        if Disabled || index == nil || string.IsNullOrEmpty(projectFilePath) {
            return
        }
        try {
            let descriptorPath = DescriptorPath(projectFilePath, assemblyName)
            let descriptor = BuildDescriptor(
                CacheBaseName(projectFilePath, assemblyName),
                ComputeFingerprint(references, sourceFingerprint, targetFramework),
                ComputeIndexHash(index),
                references,
                rspPath,
                sourceFingerprint,
                targetFramework,
                index
            )
            WriteAllTextAtomic(descriptorPath, descriptor)
        } catch (ex Exception) when IsRecoverable(ex) {
            // Best-effort cache; a write failure is never fatal.

        }
    }

    /// Computes the descriptor path for a project. Exposed for tests.
    /// @param projectFilePath Absolute path to the `.gsproj` file.
    /// @param assemblyName The effective assembly name (cache basename).
    /// @returns The descriptor file path.
    internal func DescriptorPath(projectFilePath string, assemblyName string) string {
        let dir = Path.GetDirectoryName(Path.GetFullPath(projectFilePath)) ?? string.Empty
        return Path.Combine(dir, CacheBaseName(projectFilePath, assemblyName) + DescriptorSuffix)
    }

    private func CacheBaseName(projectFilePath string, assemblyName string) string {
        return if string.IsNullOrWhiteSpace(assemblyName) {
            Path.GetFileNameWithoutExtension(projectFilePath)
        } else {
            assemblyName
        }
    }

    // The fingerprint is a SHA-256 over a canonical newline-joined string of:
    // descriptor version, compiler/cache assembly version, the index format
    // version, the target framework, the source fingerprint, and, for each
    // reference in order, its path + size + last-write time. It deliberately does
    // NOT include the .rsp — the .rsp is an ephemeral obj/ build artifact that
    // does not survive clean/clone, and the reference set (which the cache can
    // supply itself) is the real input. Any change to the reference set, a
    // touched reference DLL, a source edit, a TFM change, or a compiler/format
    // upgrade flips the hash.
    private func ComputeFingerprint(
        references IReadOnlyList[string]?,
        sourceFingerprint string?,
        targetFramework string?
    ) string {
        let sb = StringBuilder()
        sb.Append("descriptor=").Append(DescriptorVersion).Append('\n')
        sb.Append("compiler=").Append(CompilerVersion).Append('\n')
        sb.Append("indexFormat=").Append(ReferenceMetadataIndex.FormatVersion).Append('\n')
        sb.Append("tfm=").Append(targetFramework ?? string.Empty).Append('\n')
        sb.Append("sources=").Append(sourceFingerprint ?? string.Empty).Append('\n')
        sb.Append("refCount=").Append(references?.Count ?? 0).Append('\n')
        if references != nil {
            for reference in references {
                sb.Append(reference ?? string.Empty).Append('|').Append(FileStamp(reference)).Append('\n')
            }
        }
        return Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()))
    }

    // SHA-256 over the canonical serialization of the index's [metadataIndex]
    // section. Recomputed on load and compared to the recorded value so in-place
    // corruption that still parses is rejected.
    private func ComputeIndexHash(index ReferenceMetadataIndex) string {
        let sb = StringBuilder()
        {
            using let writer = StringWriter(sb, CultureInfo.InvariantCulture)
            index.WriteTextSection(writer)
        }
        return Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()))
    }

    // "<sizeBytes>:<lastWriteUtcTicks>" for an existing file, or "missing" when
    // the path is null/absent/unreadable. Stamps are cheap and conservative; a
    // restore that only touches mtimes still (correctly) invalidates.
    private func FileStamp(path string?) string {
        if string.IsNullOrEmpty(path) {
            return "missing"
        }
        try {
            let info = FileInfo(path)
            if !info.Exists {
                return "missing"
            }
            return info.Length.ToString(CultureInfo.InvariantCulture) +
                ":" +
                info
                .LastWriteTimeUtc
                .Ticks
                .ToString(CultureInfo.InvariantCulture)
        } catch (ex Exception) when IsRecoverable(ex) {
            return "unreadable"
        }
    }

    private func BuildDescriptor(
        projectName string,
        fingerprint string,
        indexSha256 string,
        references IReadOnlyList[string]?,
        rspPath string?,
        sourceFingerprint string?,
        targetFramework string?,
        index ReferenceMetadataIndex
    ) string {
        let sb = StringBuilder()
        sb.Append("version=").Append(DescriptorVersion).Append('\n')
        for line in CommentBlock {
            sb.Append(line).Append('\n')
        }
        sb.Append('\n')
        sb.Append("[project]\n")
        sb.Append("name=").Append(projectName).Append('\n')
        sb.Append("targetFramework=").Append(targetFramework ?? string.Empty).Append('\n')
        sb.Append("sourceFingerprint=").Append(sourceFingerprint ?? string.Empty).Append('\n')
        sb.Append('\n')
        sb.Append("[fingerprint]\n")
        sb.Append("compilerVersion=").Append(CompilerVersion).Append('\n')
        sb.Append("indexFormat=").Append(ReferenceMetadataIndex.FormatVersion).Append('\n')
        sb.Append("rsp=").Append(rspPath ?? string.Empty).Append('\n')
        sb.Append("rspStamp=").Append(FileStamp(rspPath)).Append('\n')
        sb.Append("referenceCount=").Append(references?.Count ?? 0).Append('\n')
        sb.Append("fingerprint=").Append(fingerprint).Append('\n')
        sb.Append("indexSha256=").Append(indexSha256).Append('\n')
        sb.Append('\n')
        sb.Append("[references]\n")
        sb.Append("# path|sizeBytes:lastWriteUtcTicks — the resolved metadata reference set\n")
        sb.Append("# (the .rsp equivalent). Bootstraps reference resolution when no .rsp is\n")
        sb.Append("# present (after dotnet clean or on a fresh clone). Folded into the fingerprint.\n")
        if references != nil {
            for reference in references {
                sb.Append(reference ?? string.Empty).Append('|').Append(FileStamp(reference)).Append('\n')
            }
        }
        sb.Append('\n')
        // The metadata index is always last so its newline-delimited body runs to
        // end-of-file (the parser reads from its header to EOF).
        {
            using let writer = StringWriter(sb, CultureInfo.InvariantCulture)
            index.WriteTextSection(writer)
        }
        return sb.ToString()
    }

    // Parses the descriptor's leading `key=value` header lines, stopping at the
    // [references] / [metadataIndex] sections so it never walks the large index
    // body. Section headers and comment lines are ignored; the keys we read
    // (version, fingerprint, indexSha256) are unique across the header sections.
    private func ParseHeaderFields(lines IReadOnlyList[string]) Dictionary[string, string] {
        let fields = Dictionary[string, string](StringComparer.Ordinal)
        for raw in lines {
            let line = raw?.Trim()
            if string.IsNullOrEmpty(line) || line!![0] == '#' {
                continue
            }
            if line!![0] == '[' {
                if string.Equals(line, "[references]", StringComparison.Ordinal) || string.Equals(
                    line,
                    ReferenceMetadataIndex.SectionHeader,
                    StringComparison.Ordinal
                ) {
                    break
                }
                continue
            }
            let eq = line!!.IndexOf('=')
            if eq <= 0 {
                continue
            }
            let key = line!!.Substring(0, eq).Trim()
            let value = line!!.Substring(eq + 1).Trim()
            if !fields.ContainsKey(key) {
                fields[key] = value
            }
        }
        return fields
    }

    // Reads the `path|stamp` entries of the [references] section (between its
    // header and the next `[` section). Comment and blank lines are skipped.
    private func ParseReferenceSection(lines IReadOnlyList[string]) List[(Path string, Stamp string)] {
        let result = List[(string, string)]()
        var inSection = false
        for raw in lines {
            let line string? = raw
            if line == nil {
                continue
            }
            let trimmed = line.Trim()
            if !inSection {
                if string.Equals(trimmed, "[references]", StringComparison.Ordinal) {
                    inSection = true
                }
                continue
            }
            if trimmed.Length == 0 || trimmed[0] == '#' {
                continue
            }
            if trimmed[0] == '[' {
                break
            }
            let bar = line.LastIndexOf('|')
            if bar <= 0 {
                continue
            }
            let path = line.Substring(0, bar)
            let stamp = line.Substring(bar + 1)
            result.Add((path, stamp))
        }
        return result
    }

    private func Sha256Hex(bytes[]uint8) string {
        let hash = SHA256.HashData(bytes)
        let sb = StringBuilder(hash.Length * 2)
        for b in hash {
            sb.Append(b.ToString("x2", CultureInfo.InvariantCulture))
        }
        return sb.ToString()
    }

    private func WriteAllTextAtomic(path string, text string) {
        let temp = path + ".tmp"
        File.WriteAllText(temp, text, UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        File.Move(temp, path, overwrite: true)
    }

    private func IsRecoverable(ex Exception) bool {
        return ex is IOException ||
            ex is UnauthorizedAccessException ||
            ex is SecurityException ||
            ex is NotSupportedException ||
            ex is ArgumentException
    }
}
