// <copyright file="ValidationManifest.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cs2Gs.Pipeline;

/// <summary>
/// The per-app hand-off between a translate-only <c>migrate</c> run and a later
/// <c>validate</c> run over the same migrated tree (issue #3668).
/// <para>
/// Sharding the self-migration gate splits it into ONE whole-repository
/// translate pass and N independent per-app validation shards. Translation must
/// stay whole-repository — linked sources (e.g. <c>test/Shared/*.cs</c>) are
/// compiled into several projects and <see cref="PipelineOptions.RepositoryTranslations"/>
/// cross-checks that they translate identically everywhere; splitting the
/// translate pass would silently disable that guard. Stages 2–4 (compile,
/// ilverify, test-parity), by contrast, only read the migrated tree, so they
/// shard cleanly.
/// </para>
/// <para>
/// The only translate-derived state stages 2–4 consume in repository layout is
/// captured here: the emitted <c>.gs</c> file set (compile-error attribution and
/// the <c>!!</c> polish pass), the external reference paths (ilverify's
/// <c>-r</c> set), and the project classification flags. The G# source text
/// itself is NOT stored — it is read back from the migrated tree, which is
/// exactly what a whole run would have on disk at that point.
/// </para>
/// </summary>
public sealed class ValidationManifest
{
    /// <summary>The manifest file name written into each app's artifact directory.</summary>
    public const string FileName = "validation-context.json";

    /// <summary>Gets or sets the corpus app id.</summary>
    [JsonPropertyName("appId")]
    [JsonPropertyOrder(0)]
    public string AppId { get; set; }

    /// <summary>Gets or sets a value indicating whether the translate stage passed for this app.</summary>
    [JsonPropertyName("translated")]
    [JsonPropertyOrder(1)]
    public bool Translated { get; set; }

    /// <summary>Gets or sets a value indicating whether the source project is a test project.</summary>
    [JsonPropertyName("isTestProject")]
    [JsonPropertyOrder(2)]
    public bool IsTestProject { get; set; }

    /// <summary>Gets or sets a value indicating whether the app targets the G# analyzer API.</summary>
    [JsonPropertyName("isAnalyzerProject")]
    [JsonPropertyOrder(3)]
    public bool IsAnalyzerProject { get; set; }

    /// <summary>Gets or sets the source project's root namespace.</summary>
    [JsonPropertyName("rootNamespace")]
    [JsonPropertyOrder(4)]
    public string RootNamespace { get; set; }

    /// <summary>Gets or sets the source project's assembly name.</summary>
    [JsonPropertyName("assemblyName")]
    [JsonPropertyOrder(5)]
    public string AssemblyName { get; set; }

    /// <summary>Gets or sets the friend assemblies contributed by generated sources.</summary>
    [JsonPropertyName("generatedFriendAssemblies")]
    [JsonPropertyOrder(6)]
    public List<string> GeneratedFriendAssemblies { get; set; } = new List<string>();

    /// <summary>
    /// Gets or sets the absolute external (NuGet package) assembly paths the C#
    /// compilation resolved against. Consumed by the IL-verify stage. A shard
    /// filters out any path that does not exist on its own runner; ilverify
    /// already scans the emitted assembly's output directory, so a package copy
    /// that a shard cannot see is additive, never load-bearing.
    /// </summary>
    [JsonPropertyName("externalReferences")]
    [JsonPropertyOrder(7)]
    public List<string> ExternalReferences { get; set; } = new List<string>();

    /// <summary>Gets or sets the emitted G# files, relative to the migrated tree root.</summary>
    [JsonPropertyName("emittedFiles")]
    [JsonPropertyOrder(8)]
    public List<ValidationManifestFile> EmittedFiles { get; set; } = new List<ValidationManifestFile>();

    /// <summary>
    /// Captures the translate-derived state of one app into a manifest.
    /// </summary>
    /// <param name="context">The app's stage execution context after translate.</param>
    /// <param name="translated">Whether the translate stage passed.</param>
    /// <param name="migratedRoot">The migrated tree root, used to relativize emitted paths.</param>
    /// <returns>The populated manifest.</returns>
    public static ValidationManifest Capture(
        StageExecutionContext context,
        bool translated,
        string migratedRoot)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        string root = Path.GetFullPath(migratedRoot ?? throw new ArgumentNullException(nameof(migratedRoot)));
        var manifest = new ValidationManifest
        {
            AppId = context.App.Id,
            Translated = translated,
            IsTestProject = context.IsTestProject,
            IsAnalyzerProject = context.IsAnalyzerProject,
            RootNamespace = context.RootNamespace,
            AssemblyName = context.AssemblyName,
        };

        foreach (string friend in context.GeneratedFriendAssemblies)
        {
            manifest.GeneratedFriendAssemblies.Add(friend);
        }

        manifest.GeneratedFriendAssemblies.Sort(StringComparer.Ordinal);

        var seenReferences = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string reference in context.ExternalReferencePaths)
        {
            if (!string.IsNullOrEmpty(reference) && seenReferences.Add(reference))
            {
                manifest.ExternalReferences.Add(reference);
            }
        }

        foreach (EmittedGsFile file in context.EmittedFiles)
        {
            manifest.EmittedFiles.Add(new ValidationManifestFile
            {
                Path = Relativize(root, file.GsPath),
                RelativeGsPath = file.RelativeGsPath,
                CsFilePath = file.CsFilePath,
                FromReferencedProject = file.IsFromReferencedProject,
            });
        }

        return manifest;
    }

    /// <summary>
    /// Writes the manifest into an app's artifact directory.
    /// </summary>
    /// <param name="manifest">The manifest to write.</param>
    /// <param name="artifactDir">The app's artifact directory.</param>
    public static void Write(ValidationManifest manifest, string artifactDir)
    {
        if (manifest is null)
        {
            throw new ArgumentNullException(nameof(manifest));
        }

        Directory.CreateDirectory(artifactDir);
        File.WriteAllText(
            Path.Combine(artifactDir, FileName),
            JsonSerializer.Serialize(manifest, TriageSerialization.Options));
    }

    /// <summary>
    /// Reads a manifest from an app's artifact directory.
    /// </summary>
    /// <param name="artifactDir">The app's artifact directory.</param>
    /// <returns>The manifest, or <see langword="null"/> when absent or unreadable.</returns>
    public static ValidationManifest Read(string artifactDir)
    {
        string path = Path.Combine(artifactDir ?? string.Empty, FileName);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<ValidationManifest>(
                File.ReadAllText(path), TriageSerialization.Options);
        }
        catch (JsonException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>
    /// Rehydrates the translate-derived state of this manifest onto a stage
    /// execution context, reading each emitted file's current text from the
    /// migrated tree. Files that no longer exist are dropped: a whole run would
    /// equally have nothing to attribute a diagnostic to.
    /// </summary>
    /// <param name="context">The context to populate.</param>
    /// <param name="migratedRoot">The migrated tree root.</param>
    public void Hydrate(StageExecutionContext context, string migratedRoot)
    {
        if (context is null)
        {
            throw new ArgumentNullException(nameof(context));
        }

        string root = Path.GetFullPath(migratedRoot ?? throw new ArgumentNullException(nameof(migratedRoot)));
        context.IsTestProject = this.IsTestProject;
        context.IsAnalyzerProject = this.IsAnalyzerProject;
        context.RootNamespace = this.RootNamespace;
        context.AssemblyName = this.AssemblyName;

        foreach (string friend in this.GeneratedFriendAssemblies)
        {
            context.GeneratedFriendAssemblies.Add(friend);
        }

        foreach (string reference in this.ExternalReferences)
        {
            // A shard runs on a different machine than the translate pass: a
            // package path that is not present here is dropped rather than
            // handed to ilverify as a dangling -r (which it reports as a load
            // error). The emitted assembly's own output directory is scanned
            // by IlVerifyRunner regardless, so real dependencies still resolve.
            if (File.Exists(reference))
            {
                context.ExternalReferencePaths.Add(reference);
            }
        }

        foreach (ValidationManifestFile file in this.EmittedFiles)
        {
            string gsPath = Path.GetFullPath(Path.Combine(root, file.Path));
            if (!File.Exists(gsPath))
            {
                continue;
            }

            context.EmittedFiles.Add(new EmittedGsFile(
                gsPath,
                file.RelativeGsPath,
                file.CsFilePath,
                File.ReadAllText(gsPath))
            {
                IsFromReferencedProject = file.FromReferencedProject,
            });
        }
    }

    private static string Relativize(string root, string path)
    {
        string full = Path.GetFullPath(path);
        string relative = Path.GetRelativePath(root, full);
        return relative.Replace('\\', '/');
    }
}

/// <summary>One emitted G# file recorded in a <see cref="ValidationManifest"/>.</summary>
public sealed class ValidationManifestFile
{
    /// <summary>Gets or sets the migrated-tree-relative path of the emitted <c>.gs</c> file.</summary>
    [JsonPropertyName("path")]
    [JsonPropertyOrder(0)]
    public string Path { get; set; }

    /// <summary>Gets or sets the run-relative path used in triage artifacts.</summary>
    [JsonPropertyName("relativeGsPath")]
    [JsonPropertyOrder(1)]
    public string RelativeGsPath { get; set; }

    /// <summary>Gets or sets the originating C# file path.</summary>
    [JsonPropertyName("csFilePath")]
    [JsonPropertyOrder(2)]
    public string CsFilePath { get; set; }

    /// <summary>Gets or sets a value indicating whether the file came from a referenced project.</summary>
    [JsonPropertyName("fromReferencedProject")]
    [JsonPropertyOrder(3)]
    public bool FromReferencedProject { get; set; }
}
