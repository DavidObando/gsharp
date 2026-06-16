// <copyright file="ColdStartCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.LanguageServer;

/// <summary>
/// ADR-0107: the language server's cross-session cold-start cache. A single
/// human-readable text file per project, <c>&lt;AssemblyName&gt;.gsproj.lscache</c>,
/// sitting next to the project file and following the C# Dev Kit <c>.lscache</c>
/// format/conventions.
/// </summary>
/// <remarks>
/// <para>
/// The cache carries two layers:
/// </para>
/// <list type="number">
/// <item><description>
/// A <em>project-system snapshot</em> — the resolved metadata reference set (the
/// <c>.rsp</c>-equivalent), the assembly name, target framework, and a source
/// fingerprint — in the <c>[project]</c> and <c>[references]</c> sections. This
/// lets a checkout describe its reference set <em>without re-running the build</em>:
/// when no <c>.rsp</c> is present (a fresh clone or after <c>dotnet clean</c>, since
/// the <c>.rsp</c> lives in the gitignored <c>obj/</c>), the language server
/// bootstraps reference resolution straight from the cache (see
/// <see cref="TryBootstrapReferences"/>).
/// </description></item>
/// <item><description>
/// The reference-metadata <em>type-name index</em>
/// (<see cref="ReferenceMetadataIndex"/>) in the <c>[metadataIndex]</c> text
/// section, so a subsequent process can skip the ~120 ms
/// <c>Assembly.GetTypes()</c>/<c>GetForwardedTypes()</c> enumeration of the whole
/// reference closure.
/// </description></item>
/// </list>
/// <para>
/// The whole descriptor is a single text file — the ~25 000-name index parses in
/// ~4 ms, indistinguishable in practice from a binary blob (~2 ms) and far below
/// the enumeration it replaces, so there is no separate <c>.lscache.bin</c>. The
/// file begins with a <c>version=N</c> header and a human-readable <c>#</c> comment
/// block (purpose, generated/do-not-edit, safe-to-delete/auto-regenerate, gitignore
/// guidance, committable opt-in note, and the opt-out env var), followed by
/// <c>[project]</c>, <c>[fingerprint]</c>, <c>[references]</c>, and
/// <c>[metadataIndex]</c> sections.
/// </para>
/// <para>
/// Correctness is conservative. The metadata index is trusted only when the
/// recorded <em>fingerprint</em> (cache-format version, compiler version, index
/// format version, target framework, source fingerprint, and the ordered reference
/// set with each file's size and last-write time — deliberately <em>not</em> the
/// <c>.rsp</c>) matches the current project, <em>and</em> the index section's
/// SHA-256 matches the recorded one (integrity), <em>and</em> the section parses
/// cleanly. The bootstrap reference set is trusted only when every recorded DLL
/// still exists and matches its recorded size:mtime stamp (assembly identity is
/// re-checked when the index is adopted). Any mismatch, missing file, version
/// change, or corruption yields a miss and the caller falls back to the normal
/// cold build (or, for references, to today's empty/degraded behavior).
/// Under-invalidation would be a correctness bug; over-invalidation is always safe.
/// No method here ever throws into the LSP pipeline.
/// </para>
/// <para>
/// Opt-out: set the environment variable
/// <c>GSHARP_DISABLE_COLD_START_CACHE</c> to <c>1</c>/<c>true</c>/<c>on</c>/<c>yes</c>
/// (mirroring C#'s <c>dotnet.projectsystem.enableLanguageServiceCache</c>
/// setting). The cache file is safe to delete at any time and auto-regenerates.
/// </para>
/// </remarks>
internal static class ColdStartCache
{
    /// <summary>
    /// The descriptor format version. Bump on any descriptor-layout change so an
    /// older or newer descriptor is treated as a miss rather than misparsed. This
    /// is folded into the fingerprint, so a bump invalidates every existing cache.
    /// </summary>
    internal const int DescriptorVersion = 2;

    private const string DescriptorSuffix = ".gsproj.lscache";
    private const string DisableEnvVar = "GSHARP_DISABLE_COLD_START_CACHE";

    private static readonly string[] CommentBlock =
    {
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
        "# To disable the cache entirely, set " + DisableEnvVar + "=1.",
    };

    /// <summary>
    /// Gets a value indicating whether the cache is disabled via the opt-out
    /// environment variable. When disabled, <see cref="TryLoad"/>,
    /// <see cref="Save"/>, and <see cref="TryBootstrapReferences"/> are no-ops and
    /// the resolver stays on the cold path (behaviour identical to before
    /// ADR-0107).
    /// </summary>
    internal static bool Disabled
    {
        get
        {
            var value = Environment.GetEnvironmentVariable(DisableEnvVar);
            if (string.IsNullOrEmpty(value))
            {
                return false;
            }

            return value.Equals("1", StringComparison.OrdinalIgnoreCase)
                || value.Equals("true", StringComparison.OrdinalIgnoreCase)
                || value.Equals("on", StringComparison.OrdinalIgnoreCase)
                || value.Equals("yes", StringComparison.OrdinalIgnoreCase);
        }
    }

    private static string CompilerVersion =>
        typeof(ReferenceMetadataIndex).Assembly.GetName().Version?.ToString() ?? "0.0.0.0";

    /// <summary>
    /// Attempts to load a fingerprint-matching metadata index for the project.
    /// Returns <see langword="null"/> on opt-out, a missing/stale/corrupt cache,
    /// or any I/O error — the caller then performs a normal cold build. Never
    /// throws.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="assemblyName">The project's effective assembly name (cache basename); falls back to the project file's base name when null/empty.</param>
    /// <param name="references">The current ordered reference paths (from the <c>.rsp</c>, or bootstrapped from this cache).</param>
    /// <param name="rspPath">The <c>.rsp</c> the references came from, recorded for information only (may be null). Not part of the fingerprint.</param>
    /// <param name="sourceFingerprint">A hash over the project's current source set (path + content), or null/empty when unavailable.</param>
    /// <param name="targetFramework">The project's target framework moniker, or null/empty when unknown.</param>
    /// <returns>A validated index, or <see langword="null"/> for a cache miss.</returns>
    internal static ReferenceMetadataIndex TryLoad(
        string projectFilePath,
        string assemblyName,
        IReadOnlyList<string> references,
        string rspPath,
        string sourceFingerprint,
        string targetFramework)
    {
        if (Disabled || string.IsNullOrEmpty(projectFilePath))
        {
            return null;
        }

        try
        {
            var descriptorPath = DescriptorPath(projectFilePath, assemblyName);
            if (!File.Exists(descriptorPath))
            {
                return null;
            }

            var lines = File.ReadAllLines(descriptorPath);
            var fields = ParseHeaderFields(lines);
            if (!fields.TryGetValue("version", out var versionText)
                || versionText != DescriptorVersion.ToString(CultureInfo.InvariantCulture))
            {
                return null;
            }

            var expectedFingerprint = ComputeFingerprint(references, sourceFingerprint, targetFramework);
            if (!fields.TryGetValue("fingerprint", out var storedFingerprint)
                || !string.Equals(storedFingerprint, expectedFingerprint, StringComparison.Ordinal))
            {
                return null;
            }

            if (!ReferenceMetadataIndex.TryReadTextSection(lines, out var index))
            {
                return null;
            }

            // Integrity: re-hash the canonical serialization of the parsed index
            // and compare to the recorded hash. This rejects in-place corruption
            // (e.g. a flipped type name) that still parses structurally.
            if (!fields.TryGetValue("indexSha256", out var storedIndexHash)
                || !string.Equals(storedIndexHash, ComputeIndexHash(index), StringComparison.Ordinal))
            {
                return null;
            }

            return index;
        }
        catch (Exception ex) when (IsRecoverable(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// Attempts to recover the resolved reference set from a previously-written
    /// cache so the language server can resolve imported types <em>without</em> a
    /// <c>.rsp</c> (a fresh clone, or after <c>dotnet clean</c>, deletes the
    /// <c>obj/</c> <c>.rsp</c>). Every recorded reference DLL must still exist and
    /// match its recorded size:mtime stamp; if any is missing or changed (or the
    /// cache is absent/corrupt/disabled), returns <see langword="null"/> and the
    /// caller keeps today's empty/degraded behavior. Never throws.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="assemblyName">The project's effective assembly name (cache basename).</param>
    /// <returns>The validated, ordered reference paths, or <see langword="null"/> for a miss.</returns>
    internal static IReadOnlyList<string> TryBootstrapReferences(string projectFilePath, string assemblyName)
    {
        if (Disabled || string.IsNullOrEmpty(projectFilePath))
        {
            return null;
        }

        try
        {
            var descriptorPath = DescriptorPath(projectFilePath, assemblyName);
            if (!File.Exists(descriptorPath))
            {
                return null;
            }

            var lines = File.ReadAllLines(descriptorPath);
            var fields = ParseHeaderFields(lines);
            if (!fields.TryGetValue("version", out var versionText)
                || versionText != DescriptorVersion.ToString(CultureInfo.InvariantCulture))
            {
                return null;
            }

            var recorded = ParseReferenceSection(lines);
            if (recorded.Count == 0)
            {
                return null;
            }

            var validated = new List<string>(recorded.Count);
            foreach (var (path, stamp) in recorded)
            {
                if (string.IsNullOrEmpty(path)
                    || !File.Exists(path)
                    || !string.Equals(FileStamp(path), stamp, StringComparison.Ordinal))
                {
                    // A missing or changed reference: never resolve against a
                    // stale reference set. Fall back to today's behavior.
                    return null;
                }

                validated.Add(path);
            }

            return validated;
        }
        catch (Exception ex) when (IsRecoverable(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// Writes the single descriptor for the project, overwriting any previous
    /// cache. No-op on opt-out. Never throws: a failed write simply leaves the
    /// next start cold.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="assemblyName">The project's effective assembly name (cache basename).</param>
    /// <param name="references">The current ordered reference paths.</param>
    /// <param name="rspPath">The <c>.rsp</c> the references came from, recorded for information only (may be null).</param>
    /// <param name="sourceFingerprint">A hash over the project's current source set (path + content), or null/empty when unavailable.</param>
    /// <param name="targetFramework">The project's target framework moniker, or null/empty when unknown.</param>
    /// <param name="index">The metadata index to persist.</param>
    internal static void Save(
        string projectFilePath,
        string assemblyName,
        IReadOnlyList<string> references,
        string rspPath,
        string sourceFingerprint,
        string targetFramework,
        ReferenceMetadataIndex index)
    {
        if (Disabled || index is null || string.IsNullOrEmpty(projectFilePath))
        {
            return;
        }

        try
        {
            var descriptorPath = DescriptorPath(projectFilePath, assemblyName);
            var descriptor = BuildDescriptor(
                CacheBaseName(projectFilePath, assemblyName),
                ComputeFingerprint(references, sourceFingerprint, targetFramework),
                ComputeIndexHash(index),
                references,
                rspPath,
                sourceFingerprint,
                targetFramework,
                index);

            WriteAllTextAtomic(descriptorPath, descriptor);
        }
        catch (Exception ex) when (IsRecoverable(ex))
        {
            // Best-effort cache; a write failure is never fatal.
        }
    }

    /// <summary>
    /// Computes the descriptor path for a project. Exposed for tests.
    /// </summary>
    /// <param name="projectFilePath">Absolute path to the <c>.gsproj</c> file.</param>
    /// <param name="assemblyName">The effective assembly name (cache basename).</param>
    /// <returns>The descriptor file path.</returns>
    internal static string DescriptorPath(string projectFilePath, string assemblyName)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(projectFilePath));
        return Path.Combine(dir, CacheBaseName(projectFilePath, assemblyName) + DescriptorSuffix);
    }

    private static string CacheBaseName(string projectFilePath, string assemblyName)
    {
        return string.IsNullOrWhiteSpace(assemblyName)
            ? Path.GetFileNameWithoutExtension(projectFilePath)
            : assemblyName;
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
    private static string ComputeFingerprint(
        IReadOnlyList<string> references,
        string sourceFingerprint,
        string targetFramework)
    {
        var sb = new StringBuilder();
        sb.Append("descriptor=").Append(DescriptorVersion).Append('\n');
        sb.Append("compiler=").Append(CompilerVersion).Append('\n');
        sb.Append("indexFormat=").Append(ReferenceMetadataIndex.FormatVersion).Append('\n');
        sb.Append("tfm=").Append(targetFramework ?? string.Empty).Append('\n');
        sb.Append("sources=").Append(sourceFingerprint ?? string.Empty).Append('\n');
        sb.Append("refCount=").Append(references?.Count ?? 0).Append('\n');
        if (references != null)
        {
            foreach (var reference in references)
            {
                sb.Append(reference ?? string.Empty).Append('|').Append(FileStamp(reference)).Append('\n');
            }
        }

        return Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()));
    }

    // SHA-256 over the canonical serialization of the index's [metadataIndex]
    // section. Recomputed on load and compared to the recorded value so in-place
    // corruption that still parses is rejected.
    private static string ComputeIndexHash(ReferenceMetadataIndex index)
    {
        var sb = new StringBuilder();
        using (var writer = new StringWriter(sb, CultureInfo.InvariantCulture))
        {
            index.WriteTextSection(writer);
        }

        return Sha256Hex(Encoding.UTF8.GetBytes(sb.ToString()));
    }

    // "<sizeBytes>:<lastWriteUtcTicks>" for an existing file, or "missing" when
    // the path is null/absent/unreadable. Stamps are cheap and conservative; a
    // restore that only touches mtimes still (correctly) invalidates.
    private static string FileStamp(string path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return "missing";
        }

        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                return "missing";
            }

            return info.Length.ToString(CultureInfo.InvariantCulture)
                + ":"
                + info.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (IsRecoverable(ex))
        {
            return "unreadable";
        }
    }

    private static string BuildDescriptor(
        string projectName,
        string fingerprint,
        string indexSha256,
        IReadOnlyList<string> references,
        string rspPath,
        string sourceFingerprint,
        string targetFramework,
        ReferenceMetadataIndex index)
    {
        var sb = new StringBuilder();
        sb.Append("version=").Append(DescriptorVersion).Append('\n');
        foreach (var line in CommentBlock)
        {
            sb.Append(line).Append('\n');
        }

        sb.Append('\n');
        sb.Append("[project]\n");
        sb.Append("name=").Append(projectName).Append('\n');
        sb.Append("targetFramework=").Append(targetFramework ?? string.Empty).Append('\n');
        sb.Append("sourceFingerprint=").Append(sourceFingerprint ?? string.Empty).Append('\n');
        sb.Append('\n');
        sb.Append("[fingerprint]\n");
        sb.Append("compilerVersion=").Append(CompilerVersion).Append('\n');
        sb.Append("indexFormat=").Append(ReferenceMetadataIndex.FormatVersion).Append('\n');
        sb.Append("rsp=").Append(rspPath ?? string.Empty).Append('\n');
        sb.Append("rspStamp=").Append(FileStamp(rspPath)).Append('\n');
        sb.Append("referenceCount=").Append(references?.Count ?? 0).Append('\n');
        sb.Append("fingerprint=").Append(fingerprint).Append('\n');
        sb.Append("indexSha256=").Append(indexSha256).Append('\n');
        sb.Append('\n');
        sb.Append("[references]\n");
        sb.Append("# path|sizeBytes:lastWriteUtcTicks — the resolved metadata reference set\n");
        sb.Append("# (the .rsp equivalent). Bootstraps reference resolution when no .rsp is\n");
        sb.Append("# present (after dotnet clean or on a fresh clone). Folded into the fingerprint.\n");
        if (references != null)
        {
            foreach (var reference in references)
            {
                sb.Append(reference ?? string.Empty).Append('|').Append(FileStamp(reference)).Append('\n');
            }
        }

        sb.Append('\n');

        // The metadata index is always last so its newline-delimited body runs to
        // end-of-file (the parser reads from its header to EOF).
        using (var writer = new StringWriter(sb, CultureInfo.InvariantCulture))
        {
            index.WriteTextSection(writer);
        }

        return sb.ToString();
    }

    // Parses the descriptor's leading `key=value` header lines, stopping at the
    // [references] / [metadataIndex] sections so it never walks the large index
    // body. Section headers and comment lines are ignored; the keys we read
    // (version, fingerprint, indexSha256) are unique across the header sections.
    private static Dictionary<string, string> ParseHeaderFields(IReadOnlyList<string> lines)
    {
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in lines)
        {
            var line = raw?.Trim();
            if (string.IsNullOrEmpty(line) || line[0] == '#')
            {
                continue;
            }

            if (line[0] == '[')
            {
                if (string.Equals(line, "[references]", StringComparison.Ordinal)
                    || string.Equals(line, ReferenceMetadataIndex.SectionHeader, StringComparison.Ordinal))
                {
                    break;
                }

                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var key = line.Substring(0, eq).Trim();
            var value = line.Substring(eq + 1).Trim();
            if (!fields.ContainsKey(key))
            {
                fields[key] = value;
            }
        }

        return fields;
    }

    // Reads the `path|stamp` entries of the [references] section (between its
    // header and the next `[` section). Comment and blank lines are skipped.
    private static List<(string Path, string Stamp)> ParseReferenceSection(IReadOnlyList<string> lines)
    {
        var result = new List<(string, string)>();
        var inSection = false;
        foreach (var raw in lines)
        {
            var line = raw;
            if (line == null)
            {
                continue;
            }

            var trimmed = line.Trim();
            if (!inSection)
            {
                if (string.Equals(trimmed, "[references]", StringComparison.Ordinal))
                {
                    inSection = true;
                }

                continue;
            }

            if (trimmed.Length == 0 || trimmed[0] == '#')
            {
                continue;
            }

            if (trimmed[0] == '[')
            {
                break;
            }

            var bar = line.LastIndexOf('|');
            if (bar <= 0)
            {
                continue;
            }

            var path = line.Substring(0, bar);
            var stamp = line.Substring(bar + 1);
            result.Add((path, stamp));
        }

        return result;
    }

    private static string Sha256Hex(byte[] bytes)
    {
        var hash = SHA256.HashData(bytes);
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }

    private static void WriteAllTextAtomic(string path, string text)
    {
        var temp = path + ".tmp";
        File.WriteAllText(temp, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(temp, path, overwrite: true);
    }

    private static bool IsRecoverable(Exception ex)
    {
        return ex is IOException
            or UnauthorizedAccessException
            or System.Security.SecurityException
            or NotSupportedException
            or ArgumentException;
    }
}
