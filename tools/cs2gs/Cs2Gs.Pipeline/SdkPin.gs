// <copyright file="SdkPin.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Text.Json
import System.Text.Json.Nodes
import System.Text.RegularExpressions
import System.Xml.Linq

/// Where a repository migration pins the `Gsharp.NET.Sdk` version its
/// generated projects build with.
enum SdkPinLocation {
    ProjectFile,
    GlobalJson
}

/// The single place that decides how the pinned `Gsharp.NET.Sdk` version
/// is spelled in a migrated repository: the project `Sdk` attribute value
/// and the `global.json` `msbuild-sdks` entry.
internal shared class SdkPin {
    /// The SDK's NuGet package id.
    internal const PackageId string = "Gsharp.NET.Sdk"

    /// The `global.json` file name.
    internal const GlobalJsonFileName string = "global.json"

    private const MsbuildSdksProperty string = "msbuild-sdks"

    // A NuGet-style version: three numeric components and an optional
    // prerelease tag. Deliberately strict: the value is written verbatim into
    // project XML and global.json.
    // Every dot-separated prerelease identifier must be non-empty.
    private let VersionPattern Regex = Regex(
        "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$$",
        RegexOptions.CultureInvariant
    )

    /// Returns whether [`version`](paramref) is an acceptable SDK version.
    /// @param version The candidate version.
    /// @returns `true` when the version is well-formed.
    internal func IsValidVersion(version string?) bool -> !string.IsNullOrEmpty(version) && VersionPattern.IsMatch(
        version!!
    )

    /// Returns the value a generated project's `Sdk` attribute carries for
    /// [`version`](paramref) under [`location`](paramref).
    /// @param version The pinned SDK version.
    /// @param location Where the pin lives.
    /// @returns The `Sdk` attribute value.
    internal func ProjectSdkAttribute(version string, location SdkPinLocation) string {
        if location == SdkPinLocation.GlobalJson {
            return PackageId
        }
        return PackageId + "/" + version
    }

    /// Returns whether a project `Sdk` attribute value names
    /// `Gsharp.NET.Sdk`, bare or versioned.
    /// @param sdkAttribute The attribute value.
    /// @returns `true` for `Gsharp.NET.Sdk` and `Gsharp.NET.Sdk/<version>`.
    internal func IsGsharpSdkAttribute(sdkAttribute string?) bool {
        if sdkAttribute == nil {
            return false
        }
        for sdk in sdkAttribute.Split(';') {
            if IsGsharpSdkMoniker(sdk) {
                return true
            }
        }
        return false
    }

    /// Rebinds compiler SDK declarations, retaining other SDKs and their order.
    /// @param root The project's root element.
    /// @param sdkMoniker The SDK name with an optional version suffix.
    /// @param migrateCSharpSdk Whether to replace the source .NET compiler SDK too.
    /// @returns Whether the project declares any SDK, including an unrelated one.
    internal func RebindProjectSdk(root XElement?, sdkMoniker string, migrateCSharpSdk bool = false) bool {
        let declarations = ProjectSdkAttributes(root)
        var rebound = false
        for declaration in declarations {
            let sdks = declaration.Value.Split(';')
            var changed = false
            for var i = 0; i < sdks.Length; i++ {
                if !IsGsharpSdkMoniker(sdks[i]) && !(migrateCSharpSdk && IsDotnetCompilerSdkMoniker(sdks[i])) {
                    continue
                }
                let element XElement? = declaration.Parent
                if element != nil && element != root {
                    sdks[i] = PackageId
                    let version string? = if sdkMoniker.StartsWith(
                        PackageId + "/",
                        StringComparison.OrdinalIgnoreCase
                    ) {
                        sdkMoniker.Substring(PackageId.Length + 1)
                    } else {
                        default(string?)
                    }
                    element.SetAttributeValue(XName?("Version")!!, version)
                } else {
                    sdks[i] = sdkMoniker
                }
                changed = true
                rebound = true
            }
            if changed {
                declaration.Value = string.Join(";", sdks)
            }
        }
        if migrateCSharpSdk && !rebound {
            let existingSdk string? = root!!.Attribute(XName?("Sdk")!!)?.Value
            root!!.SetAttributeValue(
                XName?("Sdk")!!,
                if string.IsNullOrWhiteSpace(existingSdk) {
                    sdkMoniker
                } else {
                    sdkMoniker + ";" + existingSdk
                }
            )
        }
        return declarations.Count > 0
    }

    /// Enumerates SDK declaration attributes in their original document order.
    /// @param root The project's root element.
    /// @returns Root SDK attributes, SDK element names, and SDK import attributes.
    internal func ProjectSdkAttributes(root XElement?) IReadOnlyList[XAttribute] {
        let declarations = List[XAttribute]()
        let projectSdk XAttribute? = root!!.Attribute(XName?("Sdk")!!)
        if projectSdk != nil {
            declarations.Add(projectSdk)
        }
        for element in root!!.Descendants() {
            let attributeName string? = switch element.Name.LocalName {
                case "Sdk": "Name"
                case "Import": "Sdk"
                default: default(string?)
            }
            let declaration XAttribute? = if attributeName == nil {
                default(XAttribute?)
            } else {
                element.Attribute(XName?(attributeName)!!)
            }
            if declaration != nil {
                declarations.Add(declaration)
            }
        }
        return declarations
    }

    /// Reads SDK names without their optional version suffixes.
    /// @param root The project's root element.
    /// @returns The declared SDK names.
    internal func ProjectSdkNames(root XElement?) IReadOnlyList[string] {
        let names = List[string]()
        for declaration in ProjectSdkAttributes(root) {
            for entry in declaration.Value.Split(';') {
                if !string.IsNullOrWhiteSpace(entry) {
                    names.Add(SdkName(entry))
                }
            }
        }
        return names
    }

    /// Enumerates mirrored MSBuild SDK files, excluding build outputs and template payloads.
    /// @param root The mirrored repository root.
    /// @returns Project, props, and targets file paths.
    internal func BuildableSdkFilePaths(root string?) IReadOnlyList[string] {
        let fullRoot = Path.GetFullPath(root!!)
        let files = List[string]()
        for path in Directory.EnumerateFiles(fullRoot, "*", SearchOption.AllDirectories) {
            let extension = Path.GetExtension(path)
            if !(
                extension.EndsWith("proj", StringComparison.OrdinalIgnoreCase) || extension.Equals(
                    ".props",
                    StringComparison.OrdinalIgnoreCase
                ) ||
                    extension.Equals(".targets", StringComparison.OrdinalIgnoreCase)
            ) ||
                RepositoryFileInventory.HasExcludedDirectory(Path.GetRelativePath(fullRoot, path)) ||
                IsTemplatePayload(path, fullRoot) {
                continue
            }
            files.Add(path)
        }
        files.Sort(StringComparer.Ordinal)
        return files
    }

    /// Lists nested `global.json` paths in a repository file list.
    /// @param root The mirrored repository root.
    /// @param repositoryFiles Repository-relative file paths.
    /// @returns The nested paths.
    internal func EnumerateNestedGlobalJson(root string?, repositoryFiles IEnumerable[string]?) IReadOnlyList[string] {
        let fullRoot = Path.GetFullPath(root!!)
        let nestedPaths = List[string]()
        for path in repositoryFiles!! {
            let normalized = path.Replace('\\', '/')
            if normalized.EndsWith("/" + GlobalJsonFileName, StringComparison.OrdinalIgnoreCase) &&
                !RepositoryFileInventory.HasExcludedDirectory(normalized) &&
                !IsTemplatePayload(Path.GetFullPath(Path.Combine(fullRoot, normalized)), fullRoot) {
                nestedPaths.Add(path)
            }
        }
        return nestedPaths
    }

    /// Reads the per-project pin a migrated tree recorded: the one version
    /// carried by G# SDK attributes, SDK elements, and SDK imports among
    /// [`projectPaths`](paramref).
    /// @param projectPaths The mirrored MSBuild SDK files (missing files are skipped).
    /// @param location The pin mode; only global-json mode permits unversioned G# declarations.
    /// @returns The recorded version, or `null` when no project carries one.
    /// @exception InvalidOperationException The declarations do not consistently record the required pin.
    internal func ReadProjectPin(
        projectPaths IEnumerable[string],
        location SdkPinLocation = SdkPinLocation.ProjectFile
    ) string? {
        let versions = SortedSet[string](StringComparer.Ordinal)
        for path in projectPaths {
            if !File.Exists(path) {
                continue
            }
            let root XElement? = XDocument.Load(path).Root
            if root == nil {
                continue
            }
            for declaration in ProjectSdkAttributes(root) {
                for entry in declaration.Value.Split(';') {
                    let sdk = entry.Trim()
                    if !IsGsharpSdkMoniker(sdk) {
                        continue
                    }
                    let versionSeparator = sdk.IndexOf('/')
                    let inlineVersion string? = if versionSeparator >= 0 {
                        sdk.Substring(versionSeparator + 1).Trim()
                    } else {
                        default(string?)
                    }
                    let elementVersion string? = if declaration.Parent != root {
                        declaration.Parent?.Attribute(XName?("Version")!!)?.Value
                    } else {
                        default(string?)
                    }
                    if inlineVersion != nil && elementVersion != nil && !string.Equals(
                        inlineVersion,
                        elementVersion,
                        StringComparison.Ordinal
                    ) {
                        throw InvalidOperationException(
                            "'" +
                                path +
                                "' declares conflicting " +
                                PackageId +
                                " versions: " +
                                inlineVersion +
                                " and " +
                                elementVersion +
                                "."
                        )
                    }
                    let version string? = inlineVersion ?? elementVersion
                    if version == nil {
                        if location != SdkPinLocation.GlobalJson {
                            throw InvalidOperationException(
                                "'" +
                                    path +
                                    "' has an unversioned " +
                                    PackageId +
                                    " declaration; project-file mode requires every declaration to record its SDK pin."
                            )
                        }
                        continue
                    }
                    if !IsValidVersion(version) {
                        throw InvalidOperationException(
                            "'" +
                                path +
                                "' pins " +
                                PackageId +
                                " to '" +
                                version +
                                "', which is not a valid SDK version."
                        )
                    }
                    versions.Add(version)
                }
            }
        }
        if versions.Count > 1 {
            throw InvalidOperationException(
                "The migrated projects pin more than one " + PackageId + " version: " + string.Join(", ", versions) +
                    "."
            )
        }
        return if versions.Count == 1 {
            versions.Min
        } else {
            default(string?)
        }
    }

    /// Reads the `Gsharp.NET.Sdk` version pinned under
    /// `msbuild-sdks` in [`root`](paramref)'s `global.json`.
    /// @param root The repository root.
    /// @returns The pinned version, or `null` when there is none.
    /// @exception InvalidOperationException The file exists but is not a JSON object, or the pin is not a
    /// valid version.
    internal func ReadGlobalJsonPin(root string?) string? {
        return ReadGlobalJsonPinFile(Path.Combine(root!!, GlobalJsonFileName))
    }

    /// Reads the root pin and enforces one consistent pin mode across effective nested scopes.
    /// @param root The mirrored repository root.
    /// @returns The root pin, or `null` for a project-pinned tree.
    internal func ReadGlobalJsonScopePin(root string?) string? {
        let rootPin string? = ReadGlobalJsonPin(root)
        for nested in EnumerateNestedGlobalJson(root, RepositoryFileInventory.Enumerate(root)) {
            let nestedPin string? = ReadGlobalJsonPinFile(Path.Combine(root!!, nested))
            if rootPin == nil && nestedPin != nil {
                throw InvalidOperationException(
                    "Nested global.json '" +
                        nested +
                        "' pins " +
                        PackageId +
                        " to " +
                        nestedPin +
                        " without a root global pin; migrate with --sdk-pin global-json."
                )
            }
            if rootPin != nil && !string.Equals(rootPin, nestedPin, StringComparison.Ordinal) {
                throw InvalidOperationException(
                    "Nested global.json '" +
                        nested +
                        "' must pin " +
                        PackageId +
                        " to the root " +
                        "version " +
                        rootPin +
                        ", but its pin is " +
                        (nestedPin ?? "<missing>") +
                        "."
                )
            }
        }
        return rootPin
    }

    /// Reads the SDK pin from a specific `global.json` file.
    /// @param path The file path.
    /// @returns The pinned version, or `null` when there is none.
    internal func ReadGlobalJsonPinFile(path string) string? {
        if !File.Exists(path) {
            return nil
        }
        let document = ParseGlobalJson(path)
        if !document.TryGetPropertyValue(MsbuildSdksProperty, out var node) {
            return nil
        }
        if node is not JsonObject sdks {
            // Malformed configuration is an error, never "no pin".
            throw InvalidOperationException("'" + path + "' has an msbuild-sdks value that is not a JSON object.")
        }
        // The SDK resolver matches keys case-insensitively, and a JsonObject can
        // hold several spellings of one key: that is ambiguous, so it is an error.
        var pinned string? = nil
        var pinnedKey string? = nil
        for entry in sdks {
            if !string.Equals(entry.Key, PackageId, StringComparison.OrdinalIgnoreCase) {
                continue
            }
            if pinnedKey != nil {
                throw InvalidOperationException(
                    "'" +
                        path +
                        "' pins " +
                        PackageId +
                        " more than once under msbuild-sdks ('" +
                        pinnedKey +
                        "' and '" +
                        entry.Key +
                        "'); keep exactly one."
                )
            }
            let version string? = if entry.Value is JsonValue value && value.TryGetValue[string](out var text) {
                text
            } else {
                default(string?)
            }
            if !IsValidVersion(version) {
                throw InvalidOperationException(
                    "'" +
                        path +
                        "' pins " +
                        PackageId +
                        " to '" +
                        (version ?? "<non-string>") +
                        "', which is not a valid SDK version."
                )
            }
            pinnedKey = entry.Key
            pinned = version
        }
        return pinned
    }

    /// Pins `Gsharp.NET.Sdk` to [`version`](paramref) under
    /// `msbuild-sdks` in [`root`](paramref)'s `global.json`,
    /// preserving every other setting (the `sdk` section in particular).
    /// Creates the file when it does not exist.
    /// @param root The repository root.
    /// @param version The SDK version to pin.
    /// @returns `true` when the file did not exist and was created.
    internal func WriteGlobalJsonPin(root string?, version string) bool -> WriteGlobalJsonPinFile(
        Path.Combine(root!!, GlobalJsonFileName),
        version
    )

    /// Pins `Gsharp.NET.Sdk` in a specific `global.json` file,
    /// preserving every other setting.
    /// @param path The file path.
    /// @param version The SDK version to pin.
    /// @returns `true` when the file did not exist and was created.
    internal func WriteGlobalJsonPinFile(path string, version string) bool {
        if !IsValidVersion(version) {
            throw ArgumentException("'" + version + "' is not a valid SDK version.", "version")
        }
        let created = !File.Exists(path)
        let document = if created {
            JsonObject()
        } else {
            ParseGlobalJson(path)
        }
        let hasExisting = document.TryGetPropertyValue(MsbuildSdksProperty, out var existing)
        var sdks JsonObject? = existing as JsonObject
        if hasExisting && sdks == nil {
            // Never discard configuration we do not understand.
            throw InvalidOperationException("'" + path + "' has an msbuild-sdks value that is not a JSON object.")
        }
        if sdks == nil {
            sdks = JsonObject()
            document[MsbuildSdksProperty] = sdks
        }
        // Keys are matched case-insensitively by the SDK resolver; drop every
        // differently-cased spelling so the file holds exactly one pin.
        let existingKeys = List[string]()
        for entry in sdks {
            if string.Equals(entry.Key, PackageId, StringComparison.OrdinalIgnoreCase) {
                existingKeys.Add(entry.Key)
            }
        }
        for existingKey in existingKeys {
            sdks.Remove(existingKey)
        }
        sdks[PackageId] = JsonValue.Create(version)
        let text = document.ToJsonString(JsonSerializerOptions{WriteIndented: true})
        File.WriteAllText(path, text.ReplaceLineEndings("\n") + "\n")
        return created
    }

    private func IsGsharpSdkMoniker(sdk string) bool {
        return string.Equals(SdkName(sdk), PackageId, StringComparison.OrdinalIgnoreCase)
    }

    private func IsDotnetCompilerSdkMoniker(sdk string) bool {
        let name = SdkName(sdk)
        return string.Equals(name, "Microsoft.NET.Sdk", StringComparison.OrdinalIgnoreCase) || string.Equals(
            name,
            "Microsoft.NET.Sdk.Web",
            StringComparison.OrdinalIgnoreCase
        ) ||
            string.Equals(name, "Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase)
    }

    private func SdkName(sdk string) string -> sdk.Trim().Split('/')[0].Trim()

    private func IsTemplatePayload(path string, root string) bool {
        for var directory DirectoryInfo? = FileInfo(path).Directory; directory != nil; directory = directory!!.Parent {
            if File.Exists(Path.Combine(directory.FullName, ".template.config", "template.json")) {
                return true
            }
            for templatePath in Directory.EnumerateFiles(directory.FullName, "*.vstemplate") {
                let template XElement? = XDocument.Load(templatePath).Root
                if template == nil {
                    continue
                }
                for payloadPath in TemplatePayloadPaths(template, directory.FullName) {
                    if string.Equals(payloadPath, path, StringComparison.OrdinalIgnoreCase) {
                        return true
                    }
                }
            }
            if string.Equals(directory.FullName, root, StringComparison.OrdinalIgnoreCase) {
                break
            }
        }
        return false
    }

    private func TemplatePayloadPaths(element XElement, directory string?) sequence[string] {
        var directory = directory
        if element.Name.LocalName == "Project" && element.Attribute(XName?("File")!!) is XAttribute projectFile {
            let projectPath = Path.GetFullPath(
                Path.Combine(directory!!, projectFile.Value.Replace('\\', Path.DirectorySeparatorChar))
            )
            yield projectPath
            directory = Path.GetDirectoryName(projectPath)
        } else if element.Name.LocalName == "Folder" && element.Attribute(XName?("Name")!!) is XAttribute folderName {
            directory = Path.Combine(directory!!, folderName.Value.Replace('\\', Path.DirectorySeparatorChar))
        } else if element.Name.LocalName == "ProjectItem" {
            yield Path.GetFullPath(
                Path.Combine(directory!!, element.Value.Trim().Replace('\\', Path.DirectorySeparatorChar))
            )
        }
        for child in element.Elements() {
            for path in TemplatePayloadPaths(child, directory) {
                yield path
            }
        }
    }

    private func ParseGlobalJson(path string) JsonObject {
        var node JsonNode?
        try {
            node = JsonNode.Parse(
                File.ReadAllText(path),
                nodeOptions: nil,
                documentOptions: JsonDocumentOptions{
                    AllowTrailingCommas: true,
                    CommentHandling: JsonCommentHandling.Skip
                }
            )
        } catch (ex JsonException) {
            throw InvalidOperationException("'" + path + "' is not valid JSON: " + ex.Message, ex)
        }
        if node is not JsonObject document {
            throw InvalidOperationException("'" + path + "' is not a JSON object.")
        }
        return document
    }
}
