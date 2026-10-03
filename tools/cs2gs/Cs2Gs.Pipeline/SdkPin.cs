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
    /// the mirror's root and nested <c>global.json</c> files pin the same version
    /// under <c>msbuild-sdks</c> instead of rewriting every project file.
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
    internal static bool IsGsharpSdkAttribute(string? sdkAttribute)
    {
        if (sdkAttribute is null)
        {
            return false;
        }

        foreach (string sdk in sdkAttribute.Split(';'))
        {
            if (IsGsharpSdkMoniker(sdk))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Rebinds compiler SDK declarations, retaining other SDKs and their order.</summary>
    /// <param name="root">The project's root element.</param>
    /// <param name="sdkMoniker">The SDK name with an optional version suffix.</param>
    /// <param name="migrateCSharpSdk">Whether to replace the source .NET compiler SDK too.</param>
    /// <returns>Whether the project declares any SDK, including an unrelated one.</returns>
    internal static bool RebindProjectSdk(XElement root, string sdkMoniker, bool migrateCSharpSdk = false)
    {
        IReadOnlyList<XAttribute> declarations = ProjectSdkAttributes(root);
        bool rebound = false;
        foreach (XAttribute declaration in declarations)
        {
            string[] sdks = declaration.Value.Split(';');
            bool changed = false;
            for (int i = 0; i < sdks.Length; i++)
            {
                if (!IsGsharpSdkMoniker(sdks[i])
                    && !(migrateCSharpSdk && IsDotnetCompilerSdkMoniker(sdks[i])))
                {
                    continue;
                }

                XElement? element = declaration.Parent;
                if (element is not null && element != root)
                {
                    sdks[i] = PackageId;
                    string? version = sdkMoniker.StartsWith(PackageId + "/", StringComparison.OrdinalIgnoreCase)
                        ? sdkMoniker.Substring(PackageId.Length + 1)
                        : null;
                    element.SetAttributeValue("Version", version);
                }
                else
                {
                    sdks[i] = sdkMoniker;
                }

                changed = true;
                rebound = true;
            }

            if (changed)
            {
                declaration.Value = string.Join(";", sdks);
            }
        }

        if (migrateCSharpSdk && !rebound)
        {
            string? existingSdk = root.Attribute("Sdk")?.Value;
            root.SetAttributeValue(
                "Sdk",
                string.IsNullOrWhiteSpace(existingSdk) ? sdkMoniker : sdkMoniker + ";" + existingSdk);
        }

        return declarations.Count > 0;
    }

    /// <summary>Enumerates SDK declaration attributes in their original document order.</summary>
    /// <param name="root">The project's root element.</param>
    /// <returns>Root SDK attributes, SDK element names, and SDK import attributes.</returns>
    internal static IReadOnlyList<XAttribute> ProjectSdkAttributes(XElement root)
    {
        var declarations = new List<XAttribute>();
        XAttribute? projectSdk = root.Attribute("Sdk");
        if (projectSdk is not null)
        {
            declarations.Add(projectSdk);
        }

        foreach (XElement element in root.Descendants())
        {
            string? attributeName = element.Name.LocalName switch
            {
                "Sdk" => "Name",
                "Import" => "Sdk",
                _ => null,
            };
            XAttribute? declaration = attributeName is null ? null : element.Attribute(attributeName);
            if (declaration is not null)
            {
                declarations.Add(declaration);
            }
        }

        return declarations;
    }

    /// <summary>Reads SDK names without their optional version suffixes.</summary>
    /// <param name="root">The project's root element.</param>
    /// <returns>The declared SDK names.</returns>
    internal static IReadOnlyList<string> ProjectSdkNames(XElement root)
    {
        var names = new List<string>();
        foreach (XAttribute declaration in ProjectSdkAttributes(root))
        {
            foreach (string entry in declaration.Value.Split(';'))
            {
                if (!string.IsNullOrWhiteSpace(entry))
                {
                    names.Add(SdkName(entry));
                }
            }
        }

        return names;
    }

    /// <summary>Enumerates buildable mirrored projects, excluding build outputs and template payloads.</summary>
    /// <param name="root">The mirrored repository root.</param>
    /// <returns>The C# and G# project paths.</returns>
    internal static IReadOnlyList<string> BuildableProjectPaths(string root)
    {
        string fullRoot = Path.GetFullPath(root);
        var projects = new List<string>();
        foreach (string path in Directory.EnumerateFiles(fullRoot, "*", SearchOption.AllDirectories))
        {
            string extension = Path.GetExtension(path);
            if (!(extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase)
                || extension.Equals(".gsproj", StringComparison.OrdinalIgnoreCase))
                || RepositoryFileInventory.HasExcludedDirectory(Path.GetRelativePath(fullRoot, path))
                || IsTemplateProject(path, fullRoot))
            {
                continue;
            }

            projects.Add(path);
        }

        projects.Sort(StringComparer.Ordinal);
        return projects;
    }

    /// <summary>Lists nested <c>global.json</c> paths in a repository file list.</summary>
    /// <param name="repositoryFiles">Repository-relative file paths.</param>
    /// <returns>The nested paths.</returns>
    internal static IReadOnlyList<string> EnumerateNestedGlobalJson(IEnumerable<string> repositoryFiles)
    {
        var nestedPaths = new List<string>();
        foreach (string path in repositoryFiles)
        {
            string normalized = path.Replace('\\', '/');
            if (normalized.EndsWith("/" + GlobalJsonFileName, StringComparison.OrdinalIgnoreCase))
            {
                nestedPaths.Add(path);
            }
        }

        return nestedPaths;
    }

    /// <summary>
    /// Reads the per-project pin a migrated tree recorded: the one version
    /// carried by G# SDK attributes, SDK elements, and SDK imports among
    /// <paramref name="projectPaths"/>.
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

            XElement? root = XDocument.Load(path).Root;
            if (root is null)
            {
                continue;
            }

            foreach (XAttribute declaration in ProjectSdkAttributes(root))
            {
                foreach (string entry in declaration.Value.Split(';'))
                {
                    string sdk = entry.Trim();
                    if (!IsGsharpSdkMoniker(sdk))
                    {
                        continue;
                    }

                    int versionSeparator = sdk.IndexOf('/');
                    string? inlineVersion = versionSeparator >= 0
                        ? sdk.Substring(versionSeparator + 1).Trim()
                        : null;
                    string? elementVersion = declaration.Parent != root
                        ? declaration.Parent?.Attribute("Version")?.Value
                        : null;
                    if (inlineVersion is not null && elementVersion is not null
                        && !string.Equals(inlineVersion, elementVersion, StringComparison.Ordinal))
                    {
                        throw new InvalidOperationException(
                            "'" + path + "' declares conflicting " + PackageId + " versions: " +
                            inlineVersion + " and " + elementVersion + ".");
                    }

                    string? version = inlineVersion ?? elementVersion;
                    if (version is null)
                    {
                        continue;
                    }

                    if (!IsValidVersion(version))
                    {
                        throw new InvalidOperationException(
                            "'" + path + "' pins " + PackageId + " to '" + version + "', which is not a valid SDK version.");
                    }

                    versions.Add(version);
                }
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
        return ReadGlobalJsonPinFile(Path.Combine(root, GlobalJsonFileName));
    }

    /// <summary>Reads the SDK pin from a specific <c>global.json</c> file.</summary>
    /// <param name="path">The file path.</param>
    /// <returns>The pinned version, or <see langword="null"/> when there is none.</returns>
    internal static string? ReadGlobalJsonPinFile(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        JsonObject document = ParseGlobalJson(path);
        if (!document.TryGetPropertyValue(MsbuildSdksProperty, out JsonNode? node))
        {
            return null;
        }

        if (node is not JsonObject sdks)
        {
            // Malformed configuration is an error, never "no pin".
            throw new InvalidOperationException(
                "'" + path + "' has an msbuild-sdks value that is not a JSON object.");
        }

        // The SDK resolver matches keys case-insensitively, and a JsonObject can
        // hold several spellings of one key: that is ambiguous, so it is an error.
        string? pinned = null;
        string? pinnedKey = null;
        foreach (KeyValuePair<string, JsonNode?> entry in sdks)
        {
            if (!string.Equals(entry.Key, PackageId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (pinnedKey is not null)
            {
                throw new InvalidOperationException(
                    "'" + path + "' pins " + PackageId + " more than once under msbuild-sdks ('" +
                    pinnedKey + "' and '" + entry.Key + "'); keep exactly one.");
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

            pinnedKey = entry.Key;
            pinned = version;
        }

        return pinned;
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
        => WriteGlobalJsonPinFile(Path.Combine(root, GlobalJsonFileName), version);

    /// <summary>
    /// Pins <c>Gsharp.NET.Sdk</c> in a specific <c>global.json</c> file,
    /// preserving every other setting.
    /// </summary>
    /// <param name="path">The file path.</param>
    /// <param name="version">The SDK version to pin.</param>
    /// <returns><see langword="true"/> when the file did not exist and was created.</returns>
    internal static bool WriteGlobalJsonPinFile(string path, string version)
    {
        if (!IsValidVersion(version))
        {
            throw new ArgumentException("'" + version + "' is not a valid SDK version.", nameof(version));
        }

        bool created = !File.Exists(path);
        JsonObject document = created ? new JsonObject() : ParseGlobalJson(path);
        bool hasExisting = document.TryGetPropertyValue(MsbuildSdksProperty, out JsonNode? existing);
        JsonObject? sdks = existing as JsonObject;
        if (hasExisting && sdks is null)
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
        foreach (KeyValuePair<string, JsonNode?> entry in sdks)
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

    private static bool IsGsharpSdkMoniker(string sdk)
    {
        return string.Equals(SdkName(sdk), PackageId, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsDotnetCompilerSdkMoniker(string sdk)
    {
        string name = SdkName(sdk);
        return string.Equals(name, "Microsoft.NET.Sdk", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase);
    }

    private static string SdkName(string sdk) => sdk.Trim().Split('/')[0].Trim();

    private static bool IsTemplateProject(string projectPath, string root)
    {
        for (DirectoryInfo? directory = new FileInfo(projectPath).Directory;
            directory is not null;
            directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, ".template.config", "template.json")))
            {
                return true;
            }

            foreach (string templatePath in Directory.EnumerateFiles(directory.FullName, "*.vstemplate"))
            {
                foreach (XElement element in XDocument.Load(templatePath).Descendants())
                {
                    if (element.Name.LocalName != "Project")
                    {
                        continue;
                    }

                    string? file = element.Attribute("File")?.Value;
                    if (file is not null
                        && string.Equals(
                            Path.GetFullPath(Path.Combine(
                                directory.FullName,
                                file.Replace('\\', Path.DirectorySeparatorChar))),
                            projectPath,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }

            if (string.Equals(directory.FullName, root, StringComparison.OrdinalIgnoreCase))
            {
                break;
            }
        }

        return false;
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
