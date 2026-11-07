// <copyright file="RepositoryVerbatimSources.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import System.Text.RegularExpressions
import System.Xml.Linq
import System.Xml

/// Issue #4850: the single decision point for which checked-in `.cs`
/// files a repository mirror carries VERBATIM instead of translating.
/// @remarks A `.cs` file is translated when a translated project compiles it, or,
/// failing that, as an orphan. That is wrong for a `.cs` file a project
/// references as DATA or as foreign input rather than as source it compiles:
/// a `None`/`Content`/`EmbeddedResource` item (translation-test
/// fixtures a test reads as text) or a `Compile` item of an already-G#
/// project (`ForeignCompile.gsproj` lists `ThisAssembly.cs` for the
/// SDK to translate at build time). Translating those silently rewrites the
/// data and leaves the project pointing at a file the mirror no longer has.
///
/// The rule: a `.cs` file matched by any item of a repository project file
/// other than a `Compile` item of a translated (`.csproj`, shared
/// `.props`/`.targets`) project is copied verbatim. A file that is
/// both (compiled by a translated project AND referenced as data) is
/// translated and ALSO copied. Item operations are applied in document order
/// per item type, as MSBuild does. Includes that cannot be resolved statically
/// (unknown MSBuild properties) and explicitly name `.cs` files are
/// reported as warnings rather than guessed at.
internal shared class RepositoryVerbatimSources {
    private data class ItemOperation(Remove bool, Conditional bool, Matches[]Regex, Excludes[]Regex) : IEquatable[
        ItemOperation
    ] { }

    private let ProjectExtensions[]string = []string{".csproj", ".gsproj", ".props", ".targets"}

    /// Computes the `.cs` inventory entries copied verbatim.
    /// @param sourceRoot The repository source root.
    /// @param inventory The repository inventory (root-relative paths).
    /// @param warnings Receives unresolvable-include warnings, or `null` to ignore them.
    /// @returns The matching inventory entries, spelled as in [`inventory`](paramref), case-insensitive.
    internal func Compute(
        sourceRoot string?,
        inventory IReadOnlyList[string]?,
        warnings ICollection[string]? = nil
    ) ISet[string] {
        let (verbatim, _) = ComputeCore(sourceRoot, inventory, warnings)
        return verbatim
    }

    /// Issue #4867: computes the `.cs` inventory entries that are only referenced
    /// as data under a condition or inside a target, so the mirror both copies the
    /// `.cs` file and translates it as an orphan if no project compiles it.
    internal func ComputeCopyAndTranslate(sourceRoot string?, inventory IReadOnlyList[string]?) ISet[string] {
        let (_, copyAndTranslate) = ComputeCore(sourceRoot, inventory, warnings: nil)
        return copyAndTranslate
    }

    private func ComputeCore(sourceRoot string?, inventory IReadOnlyList[string]?, warnings ICollection[string]?)(
        Verbatim ISet[string],
        CopyAndTranslate ISet[string]
    ) {
        let verbatim = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let unconditional = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let copyAndTranslate = HashSet[string](StringComparer.OrdinalIgnoreCase)
        let csharpFiles = List[(Normalized string, Original string)]()
        for path in inventory!! {
            if Path.GetExtension(path).Equals(".cs", StringComparison.OrdinalIgnoreCase) {
                csharpFiles.Add((path.Replace('\\', '/'), path))
            }
        }
        if csharpFiles.Count == 0 {
            return (verbatim, copyAndTranslate)
        }
        let root = Path.GetFullPath(sourceRoot!!)
        // Issue #4897: a file-based C# helper invoked via `dotnet run ... <file>.cs`
        // in a repository script (`build/selfhost/PeBodyMutations.cs`) must stay C#.
        for scriptPath in inventory!!.Where(IsScriptFile) {
            try {
                let fullScript = Path.Combine(
                    root,
                    scriptPath.Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar)
                )
                if !File.Exists(fullScript) {
                    continue
                }
                let text = File.ReadAllText(fullScript)
                if !text.Contains("dotnet", StringComparison.Ordinal) || !text.Contains(
                    "run",
                    StringComparison.Ordinal
                ) {
                    continue
                }
                for (normalized, original) in csharpFiles {
                    let fileName = Path.GetFileName(normalized)
                    if text.Contains(fileName, StringComparison.Ordinal) {
                        verbatim.Add(original)
                        unconditional.Add(original)
                    }
                }
            } catch (IOException) { }
        }
        let documents = List[(Normalized string, Original string, Document XDocument)]()
        let sharedByPath = Dictionary[string, (Original string, Document XDocument)](StringComparer.OrdinalIgnoreCase)
        for projectPath in inventory!!.Where(
            (path string) -> ProjectExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase)
        ) {
            try {
                let normalized = projectPath.Replace('\\', '/')
                let loaded = XDocument.Load(Path.Combine(root, normalized.Replace('/', Path.DirectorySeparatorChar)))
                documents.Add((normalized, projectPath, loaded))
                if IsSharedFile(normalized) {
                    sharedByPath[normalized] = (projectPath, loaded)
                }
            } catch (ex Exception) when ex is XmlException || ex is IOException {
                continue
            }
        }
        let reportedWarnings = HashSet[string](StringComparer.Ordinal)
        for (projectNormalized, projectOriginal, projectDocument) in documents {
            if IsSharedFile(projectNormalized) {
                continue
            }
            let projectDirectory = DirectoryOf(projectNormalized)
            let isGsharp = Path.GetExtension(projectNormalized).Equals(".gsproj", StringComparison.OrdinalIgnoreCase)
            let operations = Dictionary[string, List[ItemOperation]](StringComparer.OrdinalIgnoreCase)
            let visiting = HashSet[string](StringComparer.OrdinalIgnoreCase)
            if FindNearestDirectoryBuildFile(projectDirectory, "Directory.Build.props", sharedByPath) is {} dirProps {
                CollectDocumentOperations(
                    dirProps.Path,
                    dirProps.Original,
                    dirProps.Document,
                    projectDirectory,
                    isGsharp,
                    sharedByPath,
                    visiting,
                    operations,
                    warnings,
                    reportedWarnings
                )
            }
            CollectDocumentOperations(
                projectNormalized,
                projectOriginal,
                projectDocument,
                projectDirectory,
                isGsharp,
                sharedByPath,
                visiting,
                operations,
                warnings,
                reportedWarnings
            )
            if FindNearestDirectoryBuildFile(
                projectDirectory,
                "Directory.Build.targets",
                sharedByPath
            ) is {} dirTargets {
                CollectDocumentOperations(
                    dirTargets.Path,
                    dirTargets.Original,
                    dirTargets.Document,
                    projectDirectory,
                    isGsharp,
                    sharedByPath,
                    visiting,
                    operations,
                    warnings,
                    reportedWarnings
                )
            }
            for list in operations.Values {
                for (normalized, original) in csharpFiles {
                    var isUnconditional = false
                    var isConditional = false
                    for operation in list {
                        if !operation.Matches.Any((r Regex) -> r.IsMatch(normalized)) {
                            continue
                        }
                        if operation.Remove {
                            isUnconditional = false
                            isConditional = false
                        } else if !operation.Excludes.Any((r Regex) -> r.IsMatch(normalized)) {
                            if operation.Conditional {
                                isConditional = true
                            } else {
                                isUnconditional = true
                            }
                        }
                    }
                    if isUnconditional {
                        verbatim.Add(original)
                        unconditional.Add(original)
                        copyAndTranslate.Remove(original)
                    } else if isConditional {
                        verbatim.Add(original)
                        if !unconditional.Contains(original) {
                            copyAndTranslate.Add(original)
                        }
                    }
                }
            }
        }
        return (verbatim, copyAndTranslate)
    }

    private func CollectDocumentOperations(
        documentPath string,
        originalPath string,
        document XDocument,
        projectDirectory string,
        isGsharp bool,
        sharedByPath Dictionary[string, (Original string, Document XDocument)],
        visiting HashSet[string],
        operations Dictionary[string, List[ItemOperation]],
        warnings ICollection[string]?,
        reportedWarnings HashSet[string]
    ) {
        if document.Root == nil || !visiting.Add(documentPath) {
            return
        }
        try {
            let documentDirectory = DirectoryOf(documentPath)
            let relativeDirectories = []string{projectDirectory}
            let anchoredDirectories = []string{documentDirectory}
            for element in document.Root!!.Descendants() {
                if element.Name.LocalName.Equals("Import", StringComparison.OrdinalIgnoreCase) {
                    let importAttr string? = element.Attribute(XName?("Project")!!)?.Value
                    for importedPath in ResolveImportedPaths(
                        importAttr,
                        documentDirectory,
                        projectDirectory,
                        sharedByPath
                    ) {
                        if sharedByPath.TryGetValue(importedPath, out var sharedDoc) {
                            CollectDocumentOperations(
                                importedPath,
                                sharedDoc.Original,
                                sharedDoc.Document,
                                projectDirectory,
                                isGsharp,
                                sharedByPath,
                                visiting,
                                operations,
                                warnings,
                                reportedWarnings
                            )
                        }
                    }
                    continue
                }
                if element.Parent == nil ||
                    !element.Parent!!
                    .Name
                    .LocalName
                    .Equals("ItemGroup", StringComparison.OrdinalIgnoreCase) {
                    continue
                }
                let itemName = element.Name.LocalName
                let isCompile = itemName.Equals("Compile", StringComparison.OrdinalIgnoreCase)
                if !isGsharp && isCompile {
                    continue
                }
                if !operations.TryGetValue(itemName, out var list) {
                    operations[itemName] = (list = List[ItemOperation]())
                }
                let conditional = IsConditionalOrDynamic(element)
                let remove string? = element.Attribute(XName?("Remove")!!)?.Value
                if remove != nil && !conditional {
                    list.Add(
                        ItemOperation(
                            true,
                            false,
                            Patterns(remove, itemName, relativeDirectories, anchoredDirectories, nil).ToArray(),
                            Array.Empty[Regex]()
                        )
                    )
                }
                let value string? = element.Attribute(XName?("Include")!!)?.Value
                if value == nil {
                    continue
                }
                let unresolved List[string]? = if warnings == nil {
                    default(List[string]?)
                } else {
                    List[string]()
                }
                list.Add(
                    ItemOperation(
                        false,
                        conditional && !isCompile,
                        Patterns(value, itemName, relativeDirectories, anchoredDirectories, unresolved).ToArray(),
                        Patterns(
                            element.Attribute(XName?("Exclude")!!)?.Value,
                            itemName,
                            relativeDirectories,
                            anchoredDirectories,
                            nil
                        ).ToArray()
                    )
                )
                if unresolved != nil {
                    for text in unresolved {
                        let message = "'$originalPath' $itemName item '$text' uses an MSBuild expression this " +
                            "mirror cannot resolve; if it names .cs files they will be translated, not copied."
                        if reportedWarnings.Add(message) {
                            warnings!!.Add(message)
                        }
                    }
                }
            }
        } finally {
            visiting.Remove(documentPath)
        }
    }

    private func FindNearestDirectoryBuildFile(
        projectDirectory string,
        fileName string,
        sharedByPath Dictionary[string, (Original string, Document XDocument)]
    )(Path string, Original string, Document XDocument)? {
        var current = projectDirectory
        while true {
            let candidate = if current.Length == 0 {
                fileName
            } else {
                current + "/" + fileName
            }
            if sharedByPath.TryGetValue(candidate, out var found) {
                return (candidate, found.Original, found.Document)
            }
            if current.Length == 0 {
                return nil
            }
            current = DirectoryOf(current)
        }
    }

    private func ResolveImportedPaths(
        importValue string?,
        documentDirectory string,
        projectDirectory string,
        sharedByPath Dictionary[string, (Original string, Document XDocument)]
    ) IReadOnlyList[string] {
        let results = List[string]()
        if string.IsNullOrWhiteSpace(importValue) {
            return results
        }
        for raw in importValue.Split(';', StringSplitOptions.RemoveEmptyEntries) {
            let trimmed = raw.Trim()
            let usesProjectDir = trimmed.Contains("$$(MSBuildProjectDirectory)", StringComparison.OrdinalIgnoreCase)
            let text = trimmed
                .Replace("$$(MSBuildThisFileDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("$$(MSBuildProjectDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace('\\', '/')
                .TrimStart('/')
            if text.Contains("$$(", StringComparison.Ordinal) || text.Contains("@(", StringComparison.Ordinal) ||
                text.Contains("%(", StringComparison.Ordinal) {
                continue
            }
            let baseDir = if usesProjectDir {
                projectDirectory
            } else {
                documentDirectory
            }
            let resolved string? = Resolve(baseDir, text)
            if resolved == nil {
                continue
            }
            if resolved.Contains('*', StringComparison.Ordinal) || resolved.Contains('?', StringComparison.Ordinal) {
                let regex = GlobToRegex(resolved)
                for candidate in sharedByPath
                    .Keys
                    .Where((k string) -> regex.IsMatch(k))
                    .OrderBy((k string) -> k, StringComparer.OrdinalIgnoreCase) {
                    results.Add(candidate)
                }
            } else if sharedByPath.ContainsKey(resolved) {
                results.Add(resolved)
            }
        }
        return results
    }

    private func Patterns(
        itemValue string?,
        itemName string,
        relativeDirectories IReadOnlyList[string],
        anchoredDirectories IReadOnlyList[string],
        unresolved ICollection[string]?
    ) sequence[Regex] {
        if string.IsNullOrWhiteSpace(itemValue) {
            yield break
        }
        for raw in itemValue.Split(';', StringSplitOptions.RemoveEmptyEntries) {
            // The two directory anchors resolve to the file's own directory,
            // which Resolve prepends once below; substituting the directory
            // here too would duplicate it.
            let anchoredToFile = raw.Contains("$$(MSBuildThisFileDirectory)", StringComparison.OrdinalIgnoreCase)
            let text = raw
                .Trim()
                .Replace("$$(MSBuildThisFileDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace("$$(MSBuildProjectDirectory)", string.Empty, StringComparison.OrdinalIgnoreCase)
                .Replace('\\', '/')
            if text.Contains("$$(", StringComparison.Ordinal) || text.Contains("@(", StringComparison.Ordinal) ||
                text
                .Contains("%(", StringComparison.Ordinal) {
                if unresolved != nil && CouldMatchCSharpSource(itemName, text) {
                    unresolved.Add(raw.Trim())
                }
                continue
            }
            for baseDirectory in if anchoredToFile {
                anchoredDirectories
            } else {
                relativeDirectories
            } {
                let resolved string? = Resolve(baseDirectory, text)
                if resolved != nil {
                    yield GlobToRegex(resolved)
                }
            }
        }
    }

    private func CouldMatchCSharpSource(itemName string, text string) bool {
        if text.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) {
            return true
        }
        if itemName.StartsWith("_", StringComparison.Ordinal) {
            return false
        }
        if text.Contains("PublishDir", StringComparison.OrdinalIgnoreCase) || text.Contains(
            "OutputDir",
            StringComparison.OrdinalIgnoreCase
        ) ||
            text.Contains("OutDir", StringComparison.OrdinalIgnoreCase) || text.Contains(
            "OutputPath",
            StringComparison.OrdinalIgnoreCase
        ) ||
            text.Contains("Intermediate", StringComparison.OrdinalIgnoreCase) || text.Contains(
            "StageDir",
            StringComparison.OrdinalIgnoreCase
        ) {
            return false
        }
        let lastSegment = text.Split('/').Last()
        return (
            lastSegment.Contains('*', StringComparison.Ordinal) || lastSegment.Contains('?', StringComparison.Ordinal)
        ) &&
            !lastSegment.Contains('.', StringComparison.Ordinal)
    }

    private func IsScriptFile(path string) bool {
        let ext = Path.GetExtension(path)
        return ext.Equals(".py", StringComparison.OrdinalIgnoreCase) || ext.Equals(
            ".sh",
            StringComparison.OrdinalIgnoreCase
        )
    }

    private func Resolve(projectDirectory string, path string) string? {
        let segments = List[string](projectDirectory.Split('/', StringSplitOptions.RemoveEmptyEntries))
        for segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries) {
            if segment == "." {
                continue
            }
            if segment == ".." {
                if segments.Count == 0 {
                    return nil
                }
                segments.RemoveAt(segments.Count - 1)
                continue
            }
            segments.Add(segment)
        }
        return string.Join('/', segments)
    }

    private func GlobToRegex(glob string) Regex {
        let pattern = StringBuilder("^")
        for var i = 0; i < glob.Length; i++ {
            let c = glob[i]
            if c == '*' && i + 1 < glob.Length && glob[i + 1] == '*' {
                let followedBySlash = i + 2 < glob.Length && glob[i + 2] == '/'
                pattern.Append(
                    if followedBySlash {
                        "(?:.*/)?"
                    } else {
                        ".*"
                    }
                )
                i += if followedBySlash {
                    2
                } else {
                    1
                }
            } else if c == '*' {
                pattern.Append("[^/]*")
            } else if c == '?' {
                pattern.Append("[^/]")
            } else {
                pattern.Append(Regex.Escape(c.ToString()))
            }
        }
        pattern.Append('$')
        return Regex(pattern.ToString(), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
    }

    private func IsAtOrAbove(ancestor string, directory string) bool -> ancestor.Length == 0 || directory.Equals(
        ancestor,
        StringComparison.OrdinalIgnoreCase
    ) ||
        directory.StartsWith(ancestor + "/", StringComparison.OrdinalIgnoreCase)

    private func IsSharedFile(path string) bool {
        let extension = Path.GetExtension(path)
        return extension.Equals(".props", StringComparison.OrdinalIgnoreCase) || extension.Equals(
            ".targets",
            StringComparison.OrdinalIgnoreCase
        )
    }

    private func ImportedFileNames(document XDocument) HashSet[string] {
        let names = HashSet[string](StringComparer.OrdinalIgnoreCase)
        for import_ in document.Descendants().Where(
            (e XElement) -> e.Name.LocalName.Equals("Import", StringComparison.OrdinalIgnoreCase)
        ) {
            let project string? = import_.Attribute(XName?("Project")!!)?.Value
            if !string.IsNullOrWhiteSpace(project) {
                names.Add(project.Replace('\\', '/').Split('/').Last().Trim())
            }
        }
        return names
    }

    private func ImportClosure(direct HashSet[string], sharedImports Dictionary[string, HashSet[string]]) HashSet[
        string
    ] {
        let closure = HashSet[string](direct, StringComparer.OrdinalIgnoreCase)
        let pending = Queue[string](direct)
        while pending.Count > 0 {
            if sharedImports.TryGetValue(pending.Dequeue(), out var next) {
                for name in next.Where(closure.Add) {
                    pending.Enqueue(name)
                }
            }
        }
        return closure
    }

    private func IsConditionalOrDynamic(item XElement) bool -> item.AncestorsAndSelf().Any(
        (e XElement) -> e.Attribute(XName?("Condition")!!) != nil ||
            e
            .Name
            .LocalName
            .Equals("Target", StringComparison.OrdinalIgnoreCase)
    )

    private func DirectoryOf(relativePath string) string {
        let separator = relativePath.LastIndexOf('/')
        return if separator < 0 {
            string.Empty
        } else {
            relativePath.Substring(0, separator)
        }
    }
}
