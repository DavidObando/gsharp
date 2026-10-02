// <copyright file="SdkPin.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Cs2Gs.Pipeline;

#nullable enable annotations

/// <summary>
/// Where a repository migration pins the <c>Gsharp.NET.Sdk</c> version its
/// generated projects build with.
/// </summary>
public enum SdkPinLocation
{
    /// <summary>
    /// Every generated project carries <c>Sdk="Gsharp.NET.Sdk/&lt;version&gt;"</c>.
    /// The historical layout, and the default.
    /// </summary>
    ProjectFile,

    /// <summary>
    /// Every generated project carries the bare <c>Sdk="Gsharp.NET.Sdk"</c>, and
    /// the mirror's root <c>global.json</c> pins the version once under
    /// <c>msbuild-sdks</c>. Bumping the SDK is then a one-line change instead of
    /// a rewrite of every project file.
    /// </summary>
    GlobalJson,
}

/// <summary>
/// The single place that decides how the pinned <c>Gsharp.NET.Sdk</c> version
/// is spelled in a migrated repository: the project <c>Sdk</c> attribute value
/// and the <c>global.json</c> <c>msbuild-sdks</c> entry.
/// </summary>
internal static class SdkPin
{
    /// <summary>The SDK's NuGet package id.</summary>
    internal const string PackageId = "Gsharp.NET.Sdk";

    /// <summary>The <c>global.json</c> file name.</summary>
    internal const string GlobalJsonFileName = "global.json";

    private const string MsbuildSdksProperty = "msbuild-sdks";

    // A NuGet-style version: three numeric components and an optional
    // prerelease tag. Deliberately strict: the value is written verbatim into
    // project XML and global.json.
    // Every dot-separated prerelease identifier must be non-empty.
    private static readonly Regex VersionPattern = new Regex(
        "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$",
        RegexOptions.CultureInvariant);

    /// <summary>Returns whether <paramref name="version"/> is an acceptable SDK version.</summary>
    /// <param name="version">The candidate version.</param>
    /// <returns><see langword="true"/> when the version is well-formed.</returns>
    internal static bool IsValidVersion(string? version) =>
        !string.IsNullOrEmpty(version) && VersionPattern.IsMatch(version);

    /// <summary>
    /// Returns the value a generated project's <c>Sdk</c> attribute carries for
    /// <paramref name="version"/> under <paramref name="location"/>.
    /// </summary>
    /// <param name="version">The pinned SDK version.</param>
    /// <param name="location">Where the pin lives.</param>
    /// <returns>The <c>Sdk</c> attribute value.</returns>
    internal static string ProjectSdkAttribute(string version, SdkPinLocation location)
    {
        if (location == SdkPinLocation.GlobalJson)
        {
            return PackageId;
        }

        return PackageId + "/" + version;
    }

    /// <summary>
    /// Returns whether a project <c>Sdk</c> attribute value names
    /// <c>Gsharp.NET.Sdk</c>, bare or versioned.
    /// </summary>
    /// <param name="sdkAttribute">The attribute value.</param>
    /// <returns><see langword="true"/> for <c>Gsharp.NET.Sdk</c> and <c>Gsharp.NET.Sdk/&lt;version&gt;</c>.</returns>
    internal static bool IsGsharpSdkAttribute(string? sdkAttribute) =>
        string.Equals(sdkAttribute, PackageId, StringComparison.OrdinalIgnoreCase)
        || (sdkAttribute is not null
            && sdkAttribute.StartsWith(PackageId + "/", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Reads the per-project pin a migrated tree recorded: the one version
    /// carried by every versioned <c>Sdk="Gsharp.NET.Sdk/&lt;version&gt;"</c>
    /// attribute among <paramref name="projectPaths"/>.
    /// </summary>
    /// <param name="projectPaths">The generated project files (missing files are skipped).</param>
    /// <returns>The recorded version, or <see langword="null"/> when no project carries one.</returns>
    /// <exception cref="InvalidOperationException">The projects record more than one version.</exception>
    internal static string? ReadProjectPin(IEnumerable<string> projectPaths)
    {
        var versions = new SortedSet<string>(StringComparer.Ordinal);
        foreach (string path in projectPaths)
        {
            if (!File.Exists(path))
            {
                continue;
            }

            string? sdk = XDocument.Load(path).Root?.Attribute("Sdk")?.Value;
            if (sdk is not null && sdk.StartsWith(PackageId + "/", StringComparison.OrdinalIgnoreCase))
            {
                versions.Add(sdk.Substring(PackageId.Length + 1));
            }
        }

        if (versions.Count > 1)
        {
            throw new InvalidOperationException(
                "The migrated projects pin more than one " + PackageId + " version: " +
                string.Join(", ", versions) + ".");
        }

        return versions.Count == 1 ? versions.Min : null;
    }

    /// <summary>
    /// Reads the <c>Gsharp.NET.Sdk</c> version pinned under
    /// <c>msbuild-sdks</c> in <paramref name="root"/>'s <c>global.json</c>.
    /// </summary>
    /// <param name="root">The repository root.</param>
    /// <returns>The pinned version, or <see langword="null"/> when there is none.</returns>
    /// <exception cref="InvalidOperationException">
    /// The file exists but is not a JSON object, or the pin is not a valid version.
    /// </exception>
    internal static string? ReadGlobalJsonPin(string root)
    {
        string path = Path.Combine(root, GlobalJsonFileName);
        if (!File.Exists(path))
        {
            return null;
        }

        JsonObject document = ParseGlobalJson(path);
        if (document[MsbuildSdksProperty] is not JsonObject sdks)
        {
            return null;
        }

        foreach (KeyValuePair<string, JsonNode> entry in sdks)
        {
            if (!string.Equals(entry.Key, PackageId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string? version = entry.Value is JsonValue value && value.TryGetValue<string>(out string? text)
                ? text
                : null;
            if (!IsValidVersion(version))
            {
                throw new InvalidOperationException(
                    "'" + path + "' pins " + PackageId + " to '" + (version ?? "<non-string>") +
                    "', which is not a valid SDK version.");
            }

            return version;
        }

        return null;
    }

    /// <summary>
    /// Pins <c>Gsharp.NET.Sdk</c> to <paramref name="version"/> under
    /// <c>msbuild-sdks</c> in <paramref name="root"/>'s <c>global.json</c>,
    /// preserving every other setting (the <c>sdk</c> section in particular).
    /// Creates the file when it does not exist.
    /// </summary>
    /// <param name="root">The repository root.</param>
    /// <param name="version">The SDK version to pin.</param>
    /// <returns><see langword="true"/> when the file did not exist and was created.</returns>
    internal static bool WriteGlobalJsonPin(string root, string version)
    {
        if (!IsValidVersion(version))
        {
            throw new ArgumentException("'" + version + "' is not a valid SDK version.", nameof(version));
        }

        string path = Path.Combine(root, GlobalJsonFileName);
        bool created = !File.Exists(path);
        JsonObject document = created ? new JsonObject() : ParseGlobalJson(path);
        JsonNode? existing = document[MsbuildSdksProperty];
        JsonObject? sdks = existing as JsonObject;
        if (existing is not null && sdks is null)
        {
            // Never discard configuration we do not understand.
            throw new InvalidOperationException(
                "'" + path + "' has an msbuild-sdks value that is not a JSON object.");
        }

        if (sdks is null)
        {
            sdks = new JsonObject();
            document[MsbuildSdksProperty] = sdks;
        }

        // Keys are matched case-insensitively by the SDK resolver; drop every
        // differently-cased spelling so the file holds exactly one pin.
        var existingKeys = new List<string>();
        foreach (KeyValuePair<string, JsonNode> entry in sdks)
        {
            if (string.Equals(entry.Key, PackageId, StringComparison.OrdinalIgnoreCase))
            {
                existingKeys.Add(entry.Key);
            }
        }

        foreach (string existingKey in existingKeys)
        {
            sdks.Remove(existingKey);
        }

        sdks[PackageId] = JsonValue.Create(version);
        string text = document.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(path, text.ReplaceLineEndings("\n") + "\n");
        return created;
    }

    private static JsonObject ParseGlobalJson(string path)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(
                File.ReadAllText(path),
                nodeOptions: null,
                documentOptions: new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip,
                });
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException("'" + path + "' is not valid JSON: " + ex.Message, ex);
        }

        if (node is not JsonObject document)
        {
            throw new InvalidOperationException("'" + path + "' is not a JSON object.");
        }

        return document;
    }
}
